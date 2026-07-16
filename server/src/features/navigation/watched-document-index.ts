import { CancellationToken, WorkDoneProgressReporter } from 'vscode-languageserver';
import { AbstractNodeDocument } from '../../core/ast/ast';
import { parseFilePath } from '../../utils/ast.utils';
import { CancellationError } from '../../utils/cancellation';
import { ParserResultRegistrar } from '../../registrar/parser-result-registrar';
import { CosmoteerWorkspaceService } from '../../workspace/cosmoteer-workspace.service';
import {
    beginStatSweepWindow,
    endStatSweepWindow,
    saveIndexCache,
    saveProjectCache,
    statProjectFiles,
    sweepRulesFiles,
    tryLoadIndexCache,
    tryLoadProjectCache,
} from '../../workspace/index-cache';
import { MentionIndex } from './mention.index';
import { filePathToUri } from './navigation-strategy';
import { normalizeUri } from './reference-location';
import { projectDocuments, uriToFsPath } from './workspace-files';

/**
 * Shared machinery for a project-wide index that is built once and kept correct by the
 * client file watcher, the same freshness model the reference index and the workspace
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
    private _revision = 0;

    /**
     * A counter that moves whenever this index's content may have changed: a completed build, a
     * reconcile of dirty documents, a removal, or a reset. Consumers whose own caches depend on
     * this index (the schema-context memos on fragment rooting) compare it before and after a
     * freshness call instead of invalidating unconditionally.
     *
     * @returns the current revision number.
     */
    public get revision(): number {
        return this._revision;
    }

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

    /**
     * Tells the index its loaded state is already converged over the whole project, so any
     * work {@link loadState} deferred to the next build (the reverse-include fixpoint reparse)
     * can be dropped. Only the combined project cache may call this: the game-tree cache loads
     * a partial state that the workspace walk still has to converge. A no-op by default.
     */
    public stateLoadedConverged(): void {}

    /** Mark a document changed so it is re-indexed before the next query. */
    public markDirty(uri: string): void {
        this.dirty.add(uri);
    }

    /** Drop a deleted document from the index immediately. */
    public remove(uri: string): void {
        this.dirty.delete(uri);
        this._revision++;
        this.removeSource(normalizeUri(uri));
    }

    /** Forget everything (e.g. on workspace re-initialization). */
    public reset(): void {
        this.dirty.clear();
        this.built = false;
        this.buildPromise = undefined;
        this._revision++;
        this.clear();
    }

    /**
     * Run the one-time `build` if needed, then reconcile any documents marked changed.
     *
     * The build is shared via {@link buildPromise} and runs to completion independently of
     * the triggering request: a large project (e.g. the whole Cosmoteer Data tree) can take
     * a while, and if the build were tied to the request's token, a client that cancels the
     * slow first request would abort it, leaving `built` false and the next request to
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
                        this._revision++;
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

    /** Serializes reconciles: two concurrent scan workers must not iterate and clear the dirty
     *  set at the same time, or one worker's iteration ends early when the other clears. */
    private reconcilePromise: Promise<void> = Promise.resolve();

    /**
     * Re-index documents marked changed since the last query. An open buffer is used as-is,
     * otherwise the file is re-read from disk (so external edits, `git pull`, and newly created
     * files are picked up), and a file that no longer parses (deleted) is dropped. Runs are
     * serialized, and the revision moves only after the changed documents are actually ingested,
     * so a revision-keyed consumer memo can never capture a pre-ingest state under the final
     * revision number. A re-ingest whose contribution came out identical (an `indexDocument`
     * returning `false`) does not move the revision: every open-buffer keystroke dirties every
     * index, and bumping unconditionally wiped the revision-keyed consumer memos (the
     * schema-context memos, the merged localization key set) once per edit even though nothing
     * those consumers read had changed. A cancelled run returns the not-yet-ingested documents to
     * the dirty set (they would otherwise look reconciled forever) and still bumps the revision
     * for the documents it did ingest.
     *
     * @param cancellationToken cancels the re-ingest between documents.
     */
    private async reconcileDirty(cancellationToken: CancellationToken): Promise<void> {
        const run = this.reconcilePromise.then(() => this.reconcileDirtySerialized(cancellationToken));
        this.reconcilePromise = run.catch(() => undefined);
        await run;
    }

    private async reconcileDirtySerialized(cancellationToken: CancellationToken): Promise<void> {
        if (this.dirty.size === 0) return;
        const uris = [...this.dirty];
        this.dirty.clear();
        let ingested = 0;
        let changed = false;
        try {
            for (const uri of uris) {
                if (cancellationToken.isCancellationRequested) {
                    for (const remaining of uris.slice(ingested)) this.dirty.add(remaining);
                    throw new CancellationError();
                }
                const open = ParserResultRegistrar.instance.getResult(uri);
                if (open) {
                    if ((await this.indexDocument(open, cancellationToken)) !== false) changed = true;
                } else {
                    const fromDisk = await parseFilePath(uriToFsPath(uri), cancellationToken).catch(() => null);
                    if (fromDisk) {
                        if ((await this.indexDocument(fromDisk, cancellationToken)) !== false) changed = true;
                    } else {
                        this.removeSource(normalizeUri(uri));
                        changed = true;
                    }
                }
                ingested++;
            }
        } finally {
            if (ingested > 0 && changed) this._revision++;
        }
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
     * saved, in both cases before any live folder is indexed, so the cache only ever holds pure
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
                // One walk+stat sweep per folder serves the cache manifest checks, the stamp
                // diffs, and (through the startup chain's outer window) the mention index sync.
                beginStatSweepWindow();
                try {
                    await WatchedDocumentIndex.buildAll(pending, folderPaths, progress);
                } finally {
                    endStatSweepWindow();
                }
            });
            for (const index of pending) {
                index.buildPromise = run
                    .then(() => {
                        index.built = true;
                        index._revision++;
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

    /**
     * The body of one shared build run: cache loads, the disk walks, and the cache saves. Runs
     * inside a stat-sweep window, so the manifest checks, the stamp diffs, and the mention feed
     * below all share one walk+stat per folder.
     *
     * @param pending the indexes being built.
     * @param folderPaths the project folders to walk.
     * @param progress the indexing progress reporter.
     * @returns once every pending index is converged.
     */
    private static async buildAll(
        pending: WatchedDocumentIndex[],
        folderPaths: string[],
        progress: WorkDoneProgressReporter
    ): Promise<void> {
        const dataRoot = CosmoteerWorkspaceService.instance.dataRootPath;
        const isDataRoot = (folder: string): boolean =>
            !!dataRoot && normalizeUri(uriToFsPath(folder)) === normalizeUri(dataRoot);
        const gameFolders = folderPaths.filter(isDataRoot);
        const liveFolders = folderPaths.filter((folder) => !isDataRoot(folder));
        const liveFolderPaths = liveFolders.map((folder) => uriToFsPath(folder));
        let count = 0;
        const indexAll = async (folders: string[], diskOnly: boolean): Promise<void> => {
            if (folders.length === 0 && diskOnly) return;
            // The walk has every disk file's raw text in hand anyway. Feeding it to the mention
            // index (with the identity from the shared sweep) spares the mention build that
            // follows the project build a re-read of the same files.
            const identityByKey = new Map<string, { size: number; mtimeMs: number }>();
            for (const folder of folders) {
                for (const { path, size, mtimeMs } of await sweepRulesFiles(uriToFsPath(folder))) {
                    identityByKey.set(normalizeUri(path), { size, mtimeMs });
                }
            }
            const onDiskText = (file: string, text: string): void => {
                const identity = identityByKey.get(normalizeUri(file));
                if (identity) MentionIndex.instance.ingestDiskText(file, identity.size, identity.mtimeMs, text);
            };
            for await (const document of projectDocuments(folders, CancellationToken.None, { diskOnly, onDiskText })) {
                for (const index of pending) await index.indexDocument(document, CancellationToken.None);
                progress.report(`${++count} files`);
            }
        };
        const cacheable = gameFolders.length === 1 && !!dataRoot && pending.every((index) => index.cacheId);
        // Whether the workspace files were served from the project cache, so the disk walk
        // of the live folders can be skipped (their changed files are dirty-marked instead).
        let liveFromCache = false;
        if (cacheable) {
            // The combined project cache first: game plus workspace state in one load, with
            // a per-workspace-file stamp diff standing in for the walk.
            const project = liveFolders.length > 0 ? await tryLoadProjectCache(dataRoot!, liveFolderPaths) : undefined;
            const projectLoaded = !!project && pending.every((index) => {
                const state = project.states[index.cacheId!];
                return state !== undefined && index.loadState(state);
            });
            if (projectLoaded) {
                const current = await statProjectFiles(liveFolderPaths);
                const savedByKey = new Map(project!.stamps.map((stamp) => [normalizeUri(stamp[0]), stamp]));
                const currentKeys = new Set<string>();
                let changed = 0;
                for (const [path, size, mtimeMs] of current) {
                    const key = normalizeUri(path);
                    currentKeys.add(key);
                    const saved = savedByKey.get(key);
                    if (saved && saved[1] === size && saved[2] === mtimeMs) continue;
                    for (const index of pending) index.markDirty(filePathToUri(path));
                    changed++;
                }
                for (const [key, saved] of savedByKey) {
                    if (currentKeys.has(key)) continue;
                    for (const index of pending) index.remove(filePathToUri(saved[0]));
                    changed++;
                }
                for (const index of pending) index.stateLoadedConverged();
                progress.report(changed === 0 ? 'project from cache' : `project from cache, ${changed} changed`);
                liveFromCache = true;
            } else {
                // A partially accepted cache would leave mixed state, so start clean. The
                // game-tree cache still applies on its own.
                if (project) for (const index of pending) index.clear();
                const cached = await tryLoadIndexCache(dataRoot!);
                const loaded = !!cached && pending.every((index) => {
                    const state = cached[index.cacheId!];
                    return state !== undefined && index.loadState(state);
                });
                if (loaded) {
                    progress.report('game data from cache');
                } else {
                    for (const index of pending) index.clear();
                    await indexAll(gameFolders, true);
                    for (const index of pending) await index.finishBuild(progress);
                    const states: Record<string, unknown> = {};
                    for (const index of pending) states[index.cacheId!] = index.saveState();
                    await saveIndexCache(dataRoot!, states);
                }
            }
        } else {
            // No recognizable game root in the folder set (or a non-cacheable index in the
            // group): plain uncached walk of those folders.
            await indexAll(gameFolders, true);
        }
        // With the workspace served from the cache, an empty non-diskOnly walk still runs
        // so open editor buffers re-ingest over the loaded disk state (buffers win).
        await indexAll(liveFromCache ? [] : liveFolders, false);
        for (const index of pending) await index.finishBuild(progress);
        if (cacheable && !liveFromCache && liveFolders.length > 0) {
            // Persist the converged combined state for the next start. A file currently
            // open in the editor is saved without its stamp: its indexed content may be
            // the buffer, and a missing stamp makes the next start re-ingest it from disk.
            const stamps = (await statProjectFiles(liveFolderPaths)).filter(
                ([path]) => !ParserResultRegistrar.instance.getResultByPath(path)
            );
            const states: Record<string, unknown> = {};
            for (const index of pending) states[index.cacheId!] = index.saveState();
            await saveProjectCache(dataRoot!, liveFolderPaths, stamps, states);
        }
        for (const index of pending) index.buildCompleted();
    }

    /**
     * (Re)index one document, replacing any prior contribution from the same source.
     *
     * @param document the parsed document to ingest.
     * @param cancellationToken cancels slow ingest work.
     * @returns `false` when the document's contribution is identical to what was already indexed
     * (so a reconcile need not move the revision), anything else counts as a change.
     */
    protected abstract indexDocument(
        document: AbstractNodeDocument,
        cancellationToken: CancellationToken
    ): Promise<void | boolean> | void | boolean;

    /** Remove everything a source document (by canonical uri) previously contributed. */
    protected abstract removeSource(source: string): void;

    /** Wipe all indexed data (called by {@link reset}). */
    protected abstract clear(): void;
}
