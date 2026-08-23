import { Position, Uri, l10n } from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { showCaretReport } from '../caret-report';
import { VirtualContentProvider } from '../virtual-content-provider';

/** The virtual-document scheme the rendered effective-group markdown is served under. */
export const EFFECTIVE_GROUP_SCHEME = 'cosmoteer-effective-group';

/**
 * Serves the generated report as a read-only virtual document, so the built-in markdown preview can
 * render it without writing a file into the user's mod.
 */
export class EffectiveGroupContentProvider extends VirtualContentProvider {
    public constructor() {
        super(() => l10n.t('The effective-group report is no longer available. Run the command again.'));
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
export const showEffectiveGroup = (
    client: LanguageClient,
    provider: EffectiveGroupContentProvider,
    uri?: Uri,
    position?: Position
): Promise<void> =>
    showCaretReport(
        client,
        provider,
        {
            method: 'cosmoteer/effectiveGroup',
            scheme: EFFECTIVE_GROUP_SCHEME,
            documentName: 'What The Game Loads.md',
            missing: l10n.t('No report available: the cursor is not inside a readable group.'),
        },
        uri,
        position
    );
