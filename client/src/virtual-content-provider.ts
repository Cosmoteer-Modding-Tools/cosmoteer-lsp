import { EventEmitter, TextDocumentContentProvider, Uri } from 'vscode';

/**
 * Serves generated text as a read-only virtual document, so the editor can render it without
 * writing a file into the user's mod. Every report and preview scheme the extension registers is
 * one of these, differing only in the sentence shown once the stored content is gone.
 */
export class VirtualContentProvider implements TextDocumentContentProvider {
    private readonly contentByUri = new Map<string, string>();
    private readonly changeEmitter = new EventEmitter<Uri>();
    public readonly onDidChange = this.changeEmitter.event;

    /**
     * Builds a provider serving nothing yet.
     *
     * @param goneMessage the sentence shown for a uri this provider has no content for. It is read
     * when the content is asked for rather than when the provider is built, so it is localized
     * against the bundle that has loaded by then.
     */
    public constructor(private readonly goneMessage: () => string) {}

    /**
     * Stores (or refreshes) the content behind a uri and notifies an already-open view of it.
     *
     * @param uri the virtual document's uri.
     * @param content the text to serve under it.
     * @returns nothing.
     */
    public set(uri: Uri, content: string): void {
        this.contentByUri.set(uri.toString(), content);
        this.changeEmitter.fire(uri);
    }

    public provideTextDocumentContent(uri: Uri): string {
        return this.contentByUri.get(uri.toString()) ?? this.goneMessage();
    }
}
