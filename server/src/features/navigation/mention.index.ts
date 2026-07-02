import { stat } from 'fs/promises';
import { CancellationToken } from 'vscode-languageserver';
import { CancellationError } from '../../utils/cancellation';
import { CosmoteerWorkspaceService } from '../../workspace/cosmoteer-workspace.service';
import { normalizeUri } from './reference-location';
import { collectRulesFiles, readFilesAhead, uriToFsPath } from './workspace-files';

/** The word tokens a file's raw text is split into (contiguous identifier characters). */
const WORD_RE = /[A-Za-z0-9_]+/g;

/** Whether a query name is a single word, so word-containment equals raw substring containment. */
const IS_WORD_NAME = /^[A-Za-z0-9_]+$/;

/** How many `stat` calls run concurrently during a disk sync. */
const STAT_CONCURRENCY = 64;

/** One indexed file: its on-disk identity (to detect changes) and its distinct words. */
interface IndexedFile {
    path: string;
    size: number;
    mtimeMs: number;
    words: string[];
}

/**
 * Project-wide word index over the raw text of every `.rules` file, the pre-filter behind
 * find-all-references and rename. Those features previously re-read the whole project (the mod plus
 * the game tree) on every query just to find the files whose text mentions the symbol name. This
 * index answers that from memory: the files of every word that contains the name — equivalent to
 * the raw substring test for a pure-word name, because identifier characters are contiguous in the
 * text. A name that is not a pure word (spaces, path separators) is answered with undefined and the
 * caller falls back to the full scan.
 *
 * Every query first syncs with the disk by walking the folders and comparing each file's size and
 * mtime to the indexed state, re-reading only the files that changed — so a created, deleted, or
 * externally modified file (a `git pull`, a game update) is reflected with no watcher involved,
 * exactly like the stateless full scan it replaces, at the cost of a stat sweep instead of reading
 * every file. The result stays conservative either way: the caller re-reads and substring-checks
 * every candidate before parsing, so this index only pre-filters and never changes what is found.
 * Open editor buffers are not consulted here at all: the caller yields every open document
 * unfiltered, exactly as the full scan did.
 */
export class MentionIndex {
    private static _instance: MentionIndex;

    /** The folder-set signature the index currently covers, so a different set rebuilds cleanly. */
    private builtFor: string | undefined;
    /** The in-flight disk sync, shared so concurrent queries don't sync twice. */
    private syncPromise: Promise<void> | undefined;
    /** Normalized file key → the file's identity and words. */
    private readonly files = new Map<string, IndexedFile>();
    /** Word → normalized keys of the files whose text contains it. */
    private readonly byWord = new Map<string, Set<string>>();

    private constructor() {}

    public static get instance(): MentionIndex {
        if (!MentionIndex._instance) MentionIndex._instance = new MentionIndex();
        return MentionIndex._instance;
    }

    /** Forget everything (e.g. on workspace re-initialization). */
    public reset(): void {
        this.builtFor = undefined;
        this.syncPromise = undefined;
        this.files.clear();
        this.byWord.clear();
    }

    /**
     * The on-disk paths of every indexed file whose text can contain `name`: the files of each word
     * that includes the name as a substring. Syncs the index with the disk first.
     *
     * @param name the symbol name being searched.
     * @param folderPaths the project folders the index covers.
     * @param cancellationToken cancels a sync this query would start.
     * @returns the candidate paths, or undefined when `name` is not a pure word (caller falls back).
     */
    public async candidateFiles(
        name: string,
        folderPaths: string[],
        cancellationToken: CancellationToken
    ): Promise<string[] | undefined> {
        if (!IS_WORD_NAME.test(name)) return undefined;
        await this.ensureFresh(folderPaths, cancellationToken);
        const keys = new Set<string>();
        for (const [word, sources] of this.byWord) {
            if (!word.includes(name)) continue;
            for (const key of sources) keys.add(key);
        }
        const paths: string[] = [];
        for (const key of keys) {
            const file = this.files.get(key);
            if (file) paths.push(file.path);
        }
        return paths;
    }

    /**
     * Builds or refreshes the index without a query. Used by the startup warm-up so the first
     * find-all-references doesn't pay the one-time read of the whole project.
     *
     * @param folderPaths the project folders to cover.
     * @param cancellationToken cancels the sync.
     * @returns once the index is current.
     */
    public async ensureBuilt(folderPaths: string[], cancellationToken: CancellationToken): Promise<void> {
        await this.ensureFresh(folderPaths, cancellationToken);
    }

    /**
     * Brings the index in step with the disk. Concurrent callers share one sync. A folder-set
     * change (multi-root update, tests over different fixtures) drops the old state first.
     *
     * @param folderPaths the project folders to cover.
     * @param cancellationToken forwarded to the sync this call starts.
     * @returns once the index matches the disk.
     */
    private async ensureFresh(folderPaths: string[], cancellationToken: CancellationToken): Promise<void> {
        const signature = folderPaths
            .map((folder) => normalizeUri(uriToFsPath(folder)))
            .sort()
            .join(' ');
        if (this.builtFor !== signature) {
            // Never drop state under a running sync. The folder set only changes on multi-root
            // updates and between test fixtures, so waiting out the in-flight sync is fine.
            if (this.syncPromise) await this.syncPromise.catch(() => undefined);
            this.reset();
            this.builtFor = signature;
        }
        if (!this.syncPromise) {
            this.syncPromise = this.syncWithDisk(folderPaths, cancellationToken).finally(() => {
                this.syncPromise = undefined;
            });
        }
        await this.syncPromise;
    }

    /**
     * Walks the folders, stats every `.rules` file, and re-reads exactly the files whose identity
     * (size or mtime) differs from the indexed state — everything on a first run, near nothing on
     * a later query. Files that vanished from disk are dropped.
     *
     * @param folderPaths the project folders to walk.
     * @param cancellationToken cancels the walk and the re-reads.
     * @returns once the index matches the disk.
     */
    private async syncWithDisk(folderPaths: string[], cancellationToken: CancellationToken): Promise<void> {
        const firstBuild = this.files.size === 0;
        const work = async (): Promise<void> => {
            const onDisk: Array<{ key: string; path: string }> = [];
            const seen = new Set<string>();
            for (const folder of folderPaths) {
                for await (const path of collectRulesFiles(uriToFsPath(folder))) {
                    if (cancellationToken.isCancellationRequested) throw new CancellationError();
                    const key = normalizeUri(path);
                    if (seen.has(key)) continue;
                    seen.add(key);
                    onDisk.push({ key, path });
                }
            }
            for (const key of [...this.files.keys()]) {
                if (!seen.has(key)) this.removeSource(key);
            }
            const changed: Array<{ key: string; path: string; size: number; mtimeMs: number }> = [];
            let next = 0;
            const statWorker = async (): Promise<void> => {
                while (next < onDisk.length) {
                    if (cancellationToken.isCancellationRequested) throw new CancellationError();
                    const { key, path } = onDisk[next++];
                    try {
                        const info = await stat(path);
                        const known = this.files.get(key);
                        if (!known || known.size !== info.size || known.mtimeMs !== info.mtimeMs) {
                            changed.push({ key, path, size: info.size, mtimeMs: info.mtimeMs });
                        }
                    } catch {
                        this.removeSource(key);
                    }
                }
            };
            await Promise.all(Array.from({ length: Math.min(STAT_CONCURRENCY, onDisk.length || 1) }, statWorker));
            const metaByPath = new Map(changed.map((entry) => [entry.path, entry]));
            for await (const { file, text } of readFilesAhead(changed.map((entry) => entry.path))) {
                if (cancellationToken.isCancellationRequested) throw new CancellationError();
                const meta = metaByPath.get(file)!;
                if (text === undefined) this.removeSource(meta.key);
                else this.indexText(meta, text);
            }
        };
        // The first build reads the whole project, so show it as an indexing indicator. Later
        // syncs are a quick stat sweep and stay silent.
        if (firstBuild) {
            await CosmoteerWorkspaceService.instance.withIndexingProgress('Indexing mentions', () => work());
        } else {
            await work();
        }
    }

    /**
     * (Re)indexes one file's text, replacing whatever that file contributed before.
     *
     * @param meta the file's key, path, and on-disk identity.
     * @param text the file's raw text.
     */
    private indexText(meta: { key: string; path: string; size: number; mtimeMs: number }, text: string): void {
        this.removeSource(meta.key);
        const words = new Set<string>(text.match(WORD_RE) ?? []);
        this.files.set(meta.key, { path: meta.path, size: meta.size, mtimeMs: meta.mtimeMs, words: [...words] });
        for (const word of words) {
            (this.byWord.get(word) ?? this.byWord.set(word, new Set()).get(word)!).add(meta.key);
        }
    }

    /**
     * Removes everything a file contributed to the index.
     *
     * @param key the file's normalized key.
     */
    private removeSource(key: string): void {
        const file = this.files.get(key);
        if (file) {
            for (const word of file.words) {
                const sources = this.byWord.get(word);
                sources?.delete(key);
                if (sources && sources.size === 0) this.byWord.delete(word);
            }
        }
        this.files.delete(key);
    }
}
