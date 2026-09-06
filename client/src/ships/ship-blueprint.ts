import { Uri, commands, l10n, window } from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { VirtualContentProvider } from '../virtual-content-provider';

/** The virtual-document scheme the rendered blueprint report is served under. */
export const SHIP_BLUEPRINT_SCHEME = 'cosmoteer-ship-blueprint';

/**
 * Serves the generated report as a read-only virtual document, so the built-in markdown preview can
 * render it without writing a file into the user's mod.
 */
export class ShipBlueprintContentProvider extends VirtualContentProvider {
    public constructor() {
        super(() => l10n.t('The blueprint report is no longer available. Run the command again.'));
    }
}

/**
 * Asks for the blueprint to read, for the reader who ran the command with something else in front of
 * them. A saved ship is a picture rather than a rules file, so it is rarely the file being edited.
 *
 * @returns the chosen file, or undefined when the dialog was dismissed.
 */
const pickBlueprint = async (): Promise<Uri | undefined> => {
    const chosen = await window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: { [l10n.t('Saved ships')]: ['png'] },
        openLabel: l10n.t('Read this blueprint'),
    });
    return chosen?.[0];
};

/**
 * The file open in front of the reader, whatever kind of editor holds it. A `.ship.png` opens in the
 * image preview rather than as text, so the active text editor alone answers for nothing here.
 *
 * @returns the uri of the active tab, or undefined when nothing is open.
 */
const activeResourceUri = (): Uri | undefined => {
    if (window.activeTextEditor) return window.activeTextEditor.document.uri;
    const input = window.tabGroups.activeTabGroup?.activeTab?.input as { uri?: unknown } | undefined;
    return input?.uri instanceof Uri ? input.uri : undefined;
};

/**
 * Requests what a `.ship.png` places and opens the answer in the markdown preview. Bound to
 * `cosmoteer.showShipBlueprint`, which the explorer context menu passes the file to. Invoked from
 * the command palette it reads the file in front of the reader, and asks for one when that is not a
 * blueprint.
 *
 * @param client the running language client the request is sent through.
 * @param provider the content provider the rendered markdown is served from.
 * @param uri the blueprint's uri, or undefined to use the active editor.
 */
export async function showShipBlueprint(
    client: LanguageClient,
    provider: ShipBlueprintContentProvider,
    uri?: Uri
): Promise<void> {
    const active = uri ?? activeResourceUri();
    const targetUri = active?.path.toLowerCase().endsWith('.ship.png') ? active : await pickBlueprint();
    if (!targetUri) return;
    const markdown = await client.sendRequest<string | null>('cosmoteer/shipBlueprint', {
        textDocument: { uri: targetUri.toString() },
    });
    if (!markdown) {
        void window.showWarningMessage(l10n.t('No blueprint here: this file does not carry a saved ship.'));
        return;
    }
    const reportUri = Uri.from({
        scheme: SHIP_BLUEPRINT_SCHEME,
        path: '/Ship Blueprint.md',
        query: targetUri.toString(),
    });
    provider.set(reportUri, markdown);
    await commands.executeCommand('markdown.showPreview', reportUri);
}
