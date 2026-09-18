import { commands, ExtensionContext, languages, Position, Uri, workspace } from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import {
    PART_WIRING_SCHEME,
    PartWiringCodeLensProvider,
    PartWiringContentProvider,
    showPartWiring,
} from './part-wiring';

/**
 * Registers the part wiring report: a CodeLens above each root `Part` group and a command that
 * render what the part still needs before the game can build it. The lens passes the part's line,
 * the palette entry uses the cursor.
 *
 * @param context the extension context the registrations are disposed with.
 * @param client the language client the report is built by.
 */
export function registerPartWiring(context: ExtensionContext, client: LanguageClient): void {
    const provider = new PartWiringContentProvider();
    context.subscriptions.push(
        workspace.registerTextDocumentContentProvider(PART_WIRING_SCHEME, provider),
        languages.registerCodeLensProvider({ scheme: 'file', language: 'rules' }, new PartWiringCodeLensProvider()),
        commands.registerCommand('cosmoteer.showPartWiring', async (uri?: Uri, position?: Position) => {
            await showPartWiring(client, provider, uri, position);
        })
    );
}
