import { Position, Uri, l10n } from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { showCaretReport } from '../caret-report';
import { VirtualContentProvider } from '../virtual-content-provider';

/** The virtual-document scheme the rendered comparison markdown is served under. */
export const BASE_DIFF_SCHEME = 'cosmoteer-base-diff';

/**
 * Serves the generated comparison as a read-only virtual document, so the built-in markdown preview
 * can render it without writing a file into the user's mod.
 */
export class BaseDiffContentProvider extends VirtualContentProvider {
    public constructor() {
        super(() => l10n.t('The comparison is no longer available. Run the command again.'));
    }
}

/**
 * Requests what the group at a position loads differently from the game's own version of it and
 * opens the answer in the markdown preview. Bound to `cosmoteer.diffAgainstBase`, which the palette
 * invokes with the cursor.
 *
 * @param client the running language client the request is sent through.
 * @param provider the content provider the rendered markdown is served from.
 * @param uri the file's uri, or undefined to use the active editor.
 * @param position a position inside the group, or undefined to use the cursor.
 * @returns nothing, once the preview is open or the warning has been shown.
 */
export const showBaseDiff = (
    client: LanguageClient,
    provider: BaseDiffContentProvider,
    uri?: Uri,
    position?: Position
): Promise<void> =>
    showCaretReport(
        client,
        provider,
        {
            method: 'cosmoteer/baseDiff',
            scheme: BASE_DIFF_SCHEME,
            documentName: 'What This Group Changes.md',
            missing: l10n.t('No comparison available: this group does not derive from a file the game ships.'),
        },
        uri,
        position
    );
