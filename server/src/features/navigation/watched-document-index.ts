import { CancellationToken, WorkDoneProgressReporter } from 'vscode-languageserver';
import { AbstractNodeDocument } from '../../core/ast/ast';
import { parseFilePath } from '../../utils/ast.utils';
import { CancellationError } from '../../utils/cancellation';
import { ParserResultRegistrar } from '../../registrar/parser-result-registrar';
import { CosmoteerWorkspaceService } from '../../workspace/cosmoteer-workspace.service';
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
