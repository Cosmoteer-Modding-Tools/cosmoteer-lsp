import { EventEmitter, Position, TextDocumentContentProvider, Uri, commands, l10n, window } from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';

/** The virtual-document scheme the rendered effective-group markdown is served under. */
export const EFFECTIVE_GROUP_SCHEME = 'cosmoteer-effective-group';

/**
 * Serves the generated report as a read-only virtual document, so the built-in markdown preview can
 * render it without writing a file into the user's mod.
 */
export class EffectiveGroupContentProvider implements TextDocumentContentProvider {
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
            l10n.t('The effective-group report is no longer available. Run the command again.')
        );
    }
}

/**
 * Requests the effective-member report for the group at a position and opens it in the markdown
 * preview. Bound to `cosmoteer.showEffectiveGroup`, which the palette invokes with the cursor.
 *
 * @param client the running language client the request is sent through.
 * @param provider the content provider the rendered markdown is served from.
 * @param uri the file's uri, or undefined to use the active editor.
 * @param position a position inside the group, or undefined to use the cursor.
 * @returns nothing, once the preview is open or the warning has been shown.
 */
export async function showEffectiveGroup(
    client: LanguageClient,
    provider: EffectiveGroupContentProvider,
    uri?: Uri,
    position?: Position
): Promise<void> {
    const editor = window.activeTextEditor;
    const targetUri = uri ?? editor?.document.uri;
    const targetPosition = position ?? editor?.selection.active;
    if (!targetUri || !targetPosition) return;
    const markdown = await client.sendRequest<string | null>('cosmoteer/effectiveGroup', {
        textDocument: { uri: targetUri.toString() },
        position: { line: targetPosition.line, character: targetPosition.character },
    });
    if (!markdown) {
        void window.showWarningMessage(l10n.t('No report available: the cursor is not inside a readable group.'));
        return;
    }
    // One stable uri per (file, line), so re-running refreshes the open preview instead of stacking
    // new tabs. The source file and line ride along in the query for reference.
    const reportUri = Uri.from({
        scheme: EFFECTIVE_GROUP_SCHEME,
        path: '/What The Game Loads.md',
        query: `${targetUri.toString()}#${targetPosition.line}`,
    });
    provider.set(reportUri, markdown);
    await commands.executeCommand('markdown.showPreview', reportUri);
}
