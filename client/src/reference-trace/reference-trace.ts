import { EventEmitter, Position, TextDocumentContentProvider, Uri, commands, l10n, window } from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';

/** The virtual-document scheme the rendered reference report is served under. */
export const REFERENCE_TRACE_SCHEME = 'cosmoteer-reference-trace';

/**
 * Serves the generated report as a read-only virtual document, so the built-in markdown preview can
 * render it without writing a file into the user's mod.
 */
export class ReferenceTraceContentProvider implements TextDocumentContentProvider {
    private readonly contentByUri = new Map<string, string>();
    private readonly changeEmitter = new EventEmitter<Uri>();
    public readonly onDidChange = this.changeEmitter.event;

    /** Stores (or refreshes) the markdown behind a report uri and notifies open previews. */
    public set(uri: Uri, markdown: string): void {
        this.contentByUri.set(uri.toString(), markdown);
        this.changeEmitter.fire(uri);
    }

    public provideTextDocumentContent(uri: Uri): string {
        return (
            this.contentByUri.get(uri.toString()) ??
            l10n.t('The reference report is no longer available. Run the command again.')
        );
    }
}

/**
 * Requests the explanation of the reference at a position and opens it in the markdown preview.
 * Bound to `cosmoteer.explainReference`, which the palette invokes with the cursor.
 *
 * @param client the running language client the request is sent through.
 * @param provider the content provider the rendered markdown is served from.
 * @param uri the file's uri, or undefined to use the active editor.
 * @param position a position on the reference, or undefined to use the cursor.
 * @returns nothing, once the preview is open or the warning has been shown.
 */
export async function showReferenceTrace(
    client: LanguageClient,
    provider: ReferenceTraceContentProvider,
    uri?: Uri,
    position?: Position
): Promise<void> {
    const editor = window.activeTextEditor;
    const targetUri = uri ?? editor?.document.uri;
    const targetPosition = position ?? editor?.selection.active;
    if (!targetUri || !targetPosition) return;
    const markdown = await client.sendRequest<string | null>('cosmoteer/explainReference', {
        textDocument: { uri: targetUri.toString() },
        position: { line: targetPosition.line, character: targetPosition.character },
    });
    if (!markdown) {
        void window.showWarningMessage(l10n.t('No report available: the cursor is not on a reference.'));
        return;
    }
    // One stable uri per (file, line), so re-running refreshes the open preview instead of stacking
    // new tabs. The source file and line ride along in the query for reference.
    const reportUri = Uri.from({
        scheme: REFERENCE_TRACE_SCHEME,
        path: '/What This Reference Points At.md',
        query: `${targetUri.toString()}#${targetPosition.line}`,
    });
    provider.set(reportUri, markdown);
    await commands.executeCommand('markdown.showPreview', reportUri);
}
