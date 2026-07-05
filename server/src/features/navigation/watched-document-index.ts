import { CancellationToken, WorkDoneProgressReporter } from 'vscode-languageserver';
import { AbstractNodeDocument } from '../../core/ast/ast';
import { parseFilePath } from '../../utils/ast.utils';
import { CancellationError } from '../../utils/cancellation';
import { ParserResultRegistrar } from '../../registrar/parser-result-registrar';
import { CosmoteerWorkspaceService } from '../../workspace/cosmoteer-workspace.service';
import { saveIndexCache, tryLoadIndexCache } from '../../workspace/index-cache';
import { normalizeUri } from './reference-location';
import { projectDocuments, uriToFsPath } from './workspace-files';

/**
 * Shared machinery for a project-wide index that is built once and kept correct by the
 * client file watcher — the same freshness model the reference index and the workspace
 * symbol table both need.
 *
 * Subclasses own their data, keyed by a document's canonical source uri, and implement
 * how to (re)index and drop one document. This base handles the lazy `built` flag, the
 * `dirty` set fed by `markDirty`/`remove`, and the disk-aware reconcile that re-reads
 * changed-but-unopened files (so `git pull`, external edits, and new files are picked up).
 */
export abstract class WatchedDocumentIndex {
    protected built = false;
    /** The in-flight (or completed) one-time build, shared so concurrent queries don't rebuild. */
    private buildPromise?: Promise<void>;
    private readonly dirty = new Set<string>();

    /** This index's slot name in the persistent game-tree cache, or undefined when it doesn't
     *  participate (an index whose scope excludes the game tree must not, see {@link buildTogether}). */
    public readonly cacheId: string | undefined = undefined;

    /**
     * Serializes this index's current state for the persistent game-tree cache. Called only while
     * the state is pure game-tree (before any live workspace folder was indexed). Must return plain
     * JSON-safe data.
     *
     * @returns the serialized state, or undefined when this index doesn't participate.
     */
    public saveState(): unknown {
        return undefined;
    }

    /**
     * Primes this index from a previously saved state, replacing any current content.
     *
     * @param state the value a prior {@link saveState} returned, parsed from disk.
     * @returns true when the state was accepted, false to reject it (malformed or wrong shape).
     */
    public loadState(state: unknown): boolean {
        void state;
        return false;
    }

    /** Mark a document changed so it is re-indexed before the next query. */
    public markDirty(uri: string): void {
        this.dirty.add(uri);
    }

    /** Drop a deleted document from the index immediately. */
    public remove(uri: string): void {
        this.dirty.delete(uri);
        this.removeSource(normalizeUri(uri));
    }

    /** Forget everything (e.g. on workspace re-initialization). */
    public reset(): void {
        this.dirty.clear();
        this.built = false;
        this.buildPromise = undefined;
        this.clear();
    }

    /**
     * Run the one-time `build` if needed, then reconcile any documents marked changed.
     *
     * The build is shared via {@link buildPromise} and runs to completion independently of
     * the triggering request: a large project (e.g. the whole Cosmoteer Data tree) can take
     * a while, and if the build were tied to the request's token, a client that cancels the
     * slow first request would abort it — leaving `built` false and the next request to
     * rebuild from scratch, so it could appear permanently empty. Decoupled, the build
     * completes and caches even across a cancelled request, making the next query instant.
     * `build` therefore must use a request-independent token (e.g. `CancellationToken.None`).
     *
     * @param build (re)builds the index, given a progress reporter to post a running file count.
     * @param cancellationToken cancels the post-build reconcile of changed documents.
     * @param indexLabel the progress title shown while the one-time build runs (e.g. `Indexing symbols`).
     */
    protected async ensureFresh(
        build: (progress?: WorkDoneProgressReporter) => Promise<void>,
        cancellationToken: CancellationToken,
        indexLabel?: string
    ): Promise<void> {
        if (!this.built) {
            if (!this.buildPromise) {
                // Surface the one-time build as an LSP progress notification so a large project scan
                // shows an "indexing" indicator rather than an unexplained pause.
                const run = indexLabel
                    ? CosmoteerWorkspaceService.instance.withIndexingProgress(indexLabel, (progress) => build(progress))
                    : build();
                this.buildPromise = run
                    .then(() => {
                        this.built = true;
                    })
                    .catch((error) => {
                        // Let a failed build be retried by the next query.
                        this.buildPromise = undefined;
                        throw error;
                    });
            }
            await this.buildPromise;
        }
        await this.reconcileDirty(cancellationToken);
    }

    /**
     * Re-index documents marked changed since the last query. An open buffer is used as-is;
     * otherwise the file is re-read from disk — so external edits, `git pull`, and newly
     * created files are picked up — and a file that no longer parses (deleted) is dropped.
     */
    private async reconcileDirty(cancellationToken: CancellationToken): Promise<void> {
        for (const uri of this.dirty) {
            if (cancellationToken.isCancellationRequested) throw new CancellationError();
            const open = ParserResultRegistrar.instance.getResult(uri);
            if (open) {
                await this.indexDocument(open, cancellationToken);
                continue;
            }
            const fromDisk = await parseFilePath(uriToFsPath(uri), cancellationToken).catch(() => null);
            if (fromDisk) await this.indexDocument(fromDisk, cancellationToken);
            else this.removeSource(normalizeUri(uri));
        }
        this.dirty.clear();
    }

    /**
     * The shared one-time build every subclass uses: walk every `.rules` document in the project
     * folders and index it, posting a running file count to the progress reporter. Uses a request-
     * independent token so the build caches even if the triggering query is cancelled.
     *
     * @param folderPaths the project folders (the mod plus the game `Data` tree) to index.
     * @param progress the reporter to post a running count to, when a build is shown to the user.
     */
    protected async buildFromProject(folderPaths: string[], progress?: WorkDoneProgressReporter): Promise<void> {
        let count = 0;
        for await (const document of projectDocuments(folderPaths, CancellationToken.None)) {
            await this.indexDocument(document, CancellationToken.None);
            progress?.report(`${++count} files`);
        }
        await this.finishBuild(progress);
        this.buildCompleted();
    }

    /**
     * Completes a one-time build after every project document has been streamed through
     * {@link indexDocument} once. A no-op by default. An index whose entries depend on each other
     * (the reverse-include fixpoint) overrides this to run its follow-up passes here, so the shared
     * multi-index walk of {@link buildTogether} and the solo {@link buildFromProject} both finish it.
     * May run more than once per build (once over the cacheable game tree, once after the live
     * folders), so an override must leave its working data usable for a follow-up run.
     *
     * @param progress the reporter of the running build, to post follow-up pass counts to.
     * @returns once the index is complete.
     */
    protected finishBuild(progress?: WorkDoneProgressReporter): Promise<void> | void {
        void progress;
    }

    /**
     * Called once at the very end of a one-time build, after the last {@link finishBuild} run, so
     * an index can release build-scoped working data (retained documents). A no-op by default.
     */
    protected buildCompleted(): void {}

    /**
     * Builds several project indexes over one shared document walk, so the project's files are read
     * and parsed once instead of once per index. The first feature request used to pay a separate
     * whole-project parse for each index it touched, which is what made the server slow to become
     * fully usable. Indexes that are already built or building are skipped and keep their own run.
     * Each pending index adopts the shared run as its one-time build, so a concurrent query awaits
     * the same run and a later one sees the index as built.
     *
     * The game `Data` root in the folder set is served from the persistent index cache when its
     * saved state is still valid (see `index-cache.ts`), and is otherwise walked from disk and then
     * saved — in both cases before any live folder is indexed, so the cache only ever holds pure
     * game-tree state and mod files are re-scanned on every build.
     *
     * @param indexes the indexes to build, all scanning the same folder set.
     * @param folderPaths the project folders (the mod plus the game `Data` tree) to walk once.
     * @param indexLabel the progress title shown while the shared walk runs.
     * @returns once every given index is built (or its failed build has been cleared for retry).
     */
    public static async buildTogether(
        indexes: WatchedDocumentIndex[],
        folderPaths: string[],
        indexLabel: string
    ): Promise<void> {
        const pending = indexes.filter((index) => !index.built && !index.buildPromise);
        if (pending.length > 0) {
            const run = CosmoteerWorkspaceService.instance.withIndexingProgress(indexLabel, async (progress) => {
                const dataRoot = CosmoteerWorkspaceService.instance.dataRootPath;
                const isDataRoot = (folder: string): boolean =>
                    !!dataRoot && normalizeUri(uriToFsPath(folder)) === normalizeUri(dataRoot);
                const gameFolders = folderPaths.filter(isDataRoot);
                const liveFolders = folderPaths.filter((folder) => !isDataRoot(folder));
                let count = 0;
                const indexAll = async (folders: string[], diskOnly: boolean): Promise<void> => {
                    if (folders.length === 0 && diskOnly) return;
                    for await (const document of projectDocuments(folders, CancellationToken.None, { diskOnly })) {
                        for (const index of pending) await index.indexDocument(document, CancellationToken.None);
                        progress.report(`${++count} files`);
                    }
                };
                if (gameFolders.length === 1 && dataRoot && pending.every((index) => index.cacheId)) {
                    const cached = await tryLoadIndexCache(dataRoot);
                    const loaded = !!cached && pending.every((index) => {
                        const state = cached[index.cacheId!];
                        return state !== undefined && index.loadState(state);
                    });
                    if (loaded) {
                        progress.report('game data from cache');
                    } else {
                        // A partially accepted cache would leave mixed state, so start clean, walk
                        // the game tree from disk, converge it, and save that pure state.
                        for (const index of pending) index.clear();
                        await indexAll(gameFolders, true);
                        for (const index of pending) await index.finishBuild(progress);
                        const states: Record<string, unknown> = {};
                        for (const index of pending) states[index.cacheId!] = index.saveState();
                        await saveIndexCache(dataRoot, states);
                    }
                } else {
                    // No recognizable game root in the folder set (or a non-cacheable index in the
                    // group): plain uncached walk of those folders.
                    await indexAll(gameFolders, true);
                }
                await indexAll(liveFolders, false);
                for (const index of pending) await index.finishBuild(progress);
                for (const index of pending) index.buildCompleted();
            });
            for (const index of pending) {
                index.buildPromise = run
                    .then(() => {
                        index.built = true;
                    })
                    .catch((error) => {
                        // Let a failed shared build be retried by the next query on this index.
                        index.buildPromise = undefined;
                        throw error;
                    });
            }
        }
        await Promise.all(indexes.map((index) => index.buildPromise?.catch(() => undefined)));
    }

    /** (Re)index one document, replacing any prior contribution from the same source. */
    protected abstract indexDocument(
        document: AbstractNodeDocument,
        cancellationToken: CancellationToken
    ): Promise<void> | void;

    /** Remove everything a source document (by canonical uri) previously contributed. */
    protected abstract removeSource(source: string): void;

    /** Wipe all indexed data (called by {@link reset}). */
    protected abstract clear(): void;
}
