import { commands, ExtensionContext, languages, Position, Uri, window } from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { PartGridCodeLensProvider } from './codelens';
import { PartGridEditorPanel } from './editor-panel';

/**
 * Registers the part grid editor: a CodeLens above each root `Part` group and a command that opens
 * the interactive grid editor for the part at a position. The lens passes the position, the palette
 * entry uses the cursor.
 *
 * @param context the extension context the registrations are disposed with.
 * @param client the language client the editor reads the grid from and writes edits through.
 */
export function registerPartEditor(context: ExtensionContext, client: LanguageClient): void {
    context.subscriptions.push(
        languages.registerCodeLensProvider({ scheme: 'file', language: 'rules' }, new PartGridCodeLensProvider()),
        commands.registerCommand('cosmoteer.editPartGrid', async (uri?: Uri, position?: Position) => {
            const editor = window.activeTextEditor;
            const targetUri = uri ?? editor?.document.uri;
            const targetPosition = position ?? editor?.selection.active;
            if (!targetUri || !targetPosition) return;
            await PartGridEditorPanel.show(context, client, targetUri, targetPosition);
        })
    );
}
