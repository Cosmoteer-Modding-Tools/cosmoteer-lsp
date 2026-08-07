import { DiagnosticCollection, languages } from 'vscode';
import { DiagnosticCollectionProvider, DiagnosticCollectionSource } from 'vscode-languageclient/node';

/**
 * The name the shared collection is created under. VS Code shows it as the source label on every
 * entry in the Problems panel, so it is pinned here rather than taken from whichever model happened
 * to ask first (the push model would pass the client id, the pull model the server's diagnostic
 * identifier, which the server does not set).
 */
const COLLECTION_NAME = 'cosmoteer';

/**
 * Hands the push and the pull diagnostic model the same {@link DiagnosticCollection}.
 *
 * The server uses both models at once: the whole-mod validation pass pushes results for files that
 * are not open (`textDocument/publishDiagnostics`), while an open file answers `textDocument/diagnostic`.
 * The client's default provider gives each model its own collection, so a file that moves between
 * the two is briefly present in both and every one of its problems is listed twice. The server
 * retracts the push entry when the pull request for that file arrives, which closes the window but
 * cannot remove it: the retraction is a separate message from the pull response.
 *
 * With one collection there is no window at all, because writing the pull result for a uri replaces
 * whatever the push model wrote for it. The server keeps its retraction either way, both because it
 * still runs against a client that does not share (the JetBrains plugin) and because on a shared
 * collection the retraction is a no-op that the pull result overwrites: notification and response
 * travel the same connection, so the order is fixed.
 */
export class SharedDiagnosticCollectionProvider implements DiagnosticCollectionProvider {
    private collection: DiagnosticCollection | undefined;
    /** The models currently holding the collection, so it is disposed once the last one lets go. */
    private readonly holders = new Set<DiagnosticCollectionSource>();

    /**
     * Returns the one collection both models share, creating it on the first call.
     *
     * @param _name the name the asking model would have used, ignored in favour of a stable one.
     * @param source the model asking, remembered so the collection outlives a release by the other.
     * @returns the shared collection.
     */
    create(_name: string | undefined, source: DiagnosticCollectionSource): DiagnosticCollection {
        this.collection ??= languages.createDiagnosticCollection(COLLECTION_NAME);
        this.holders.add(source);
        return this.collection;
    }

    /**
     * Releases the collection on behalf of one model, and disposes it once no model holds it.
     *
     * The pull model disposes its collection whenever the server unregisters the capability, which
     * on a shared collection must not take the pushed whole-mod results with it.
     *
     * @param collection the collection the model releases.
     * @param source the model releasing it.
     */
    dispose(collection: DiagnosticCollection, source: DiagnosticCollectionSource): void {
        this.holders.delete(source);
        if (collection !== this.collection || this.holders.size > 0) return;
        this.collection = undefined;
        collection.dispose();
    }
}
