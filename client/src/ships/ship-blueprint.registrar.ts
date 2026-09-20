import { commands, ExtensionContext, Uri, workspace } from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { SHIP_BLUEPRINT_SCHEME, ShipBlueprintContentProvider, showShipBlueprint } from './ship-blueprint';

/**
 * Registers the ship blueprint report: what a `.ship.png` places, read out of the low bits of the
 * picture.
 *
 * @param context the extension context the registrations are disposed with.
 * @param client the language client the blueprint is read by.
 */
export function registerShipBlueprint(context: ExtensionContext, client: LanguageClient): void {
    const provider = new ShipBlueprintContentProvider();
    context.subscriptions.push(
        workspace.registerTextDocumentContentProvider(SHIP_BLUEPRINT_SCHEME, provider),
        commands.registerCommand('cosmoteer.showShipBlueprint', async (uri?: Uri) => {
            await showShipBlueprint(client, provider, uri);
        })
    );
}
