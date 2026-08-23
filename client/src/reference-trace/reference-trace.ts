import { Position, Uri, l10n } from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { showCaretReport } from '../caret-report';
import { VirtualContentProvider } from '../virtual-content-provider';

/** The virtual-document scheme the rendered reference report is served under. */
export const REFERENCE_TRACE_SCHEME = 'cosmoteer-reference-trace';

/**
 * Serves the generated report as a read-only virtual document, so the built-in markdown preview can
 * render it without writing a file into the user's mod.
 */
export class ReferenceTraceContentProvider extends VirtualContentProvider {
    public constructor() {
        super(() => l10n.t('The reference report is no longer available. Run the command again.'));
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
export const showReferenceTrace = (
    client: LanguageClient,
    provider: ReferenceTraceContentProvider,
    uri?: Uri,
    position?: Position
): Promise<void> =>
    showCaretReport(
        client,
        provider,
        {
            method: 'cosmoteer/explainReference',
            scheme: REFERENCE_TRACE_SCHEME,
            documentName: 'What This Reference Points At.md',
            missing: l10n.t('No report available: the cursor is not on a reference.'),
        },
        uri,
        position
    );
