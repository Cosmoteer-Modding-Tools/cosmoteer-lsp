import { Position, Uri, commands, window } from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';

/** The four things one caret-driven report differs in, everything else about them being the same. */
interface CaretReportKind {
    /** The server request the rendered markdown is asked for with. */
    method: string;
    /** The virtual-document scheme the report is served under. */
    scheme: string;
    /** The file name the preview tab carries. */
    documentName: string;
    /** The warning shown when the server has no report for the position. */
    missing: string;
}

/**
 * Requests a report for the position under the caret and opens it in the markdown preview. Shared
 * by every command that renders what the server knows about the thing the cursor sits in, each one
 * supplying only the request it sends and the document it renders into.
 *
 * @param client the running language client the request is sent through.
 * @param provider the content provider the rendered markdown is served from.
 * @param report the request, scheme, document name and missing-report warning of this command.
 * @param uri the file's uri, or undefined to use the active editor.
 * @param position the position to report on, or undefined to use the cursor.
 * @returns nothing, once the preview is open or the warning has been shown.
 */
export const showCaretReport = async (
    client: LanguageClient,
    provider: { set(uri: Uri, content: string): void },
    report: CaretReportKind,
    uri?: Uri,
    position?: Position
): Promise<void> => {
    const editor = window.activeTextEditor;
    const targetUri = uri ?? editor?.document.uri;
    const targetPosition = position ?? editor?.selection.active;
    if (!targetUri || !targetPosition) return;
    const markdown = await client.sendRequest<string | null>(report.method, {
        textDocument: { uri: targetUri.toString() },
        position: { line: targetPosition.line, character: targetPosition.character },
    });
    if (!markdown) {
        void window.showWarningMessage(report.missing);
        return;
    }
    // One stable uri per (file, line), so re-running refreshes the open preview instead of stacking
    // new tabs. The source file and line ride along in the query for reference.
    const reportUri = Uri.from({
        scheme: report.scheme,
        path: `/${report.documentName}`,
        query: `${targetUri.toString()}#${targetPosition.line}`,
    });
    provider.set(reportUri, markdown);
    await commands.executeCommand('markdown.showPreview', reportUri);
};
