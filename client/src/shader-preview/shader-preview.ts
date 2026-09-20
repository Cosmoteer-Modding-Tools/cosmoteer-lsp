import { commands, ExtensionContext, languages, Position, Uri, window } from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { ShaderPreviewCodeLensProvider } from './codelens';
import { ShaderPreviewPanel } from './preview-panel';

/**
 * Registers the live shader preview: a CodeLens above each `Shader = …` and a command that opens the
 * WebGL preview for the material at a position. The lens passes the position, the palette entry uses
 * the cursor.
 *
 * @param context the extension context the registrations are disposed with.
 * @param client the language client the preview reads its material from.
 */
export function registerShaderPreview(context: ExtensionContext, client: LanguageClient): void {
    context.subscriptions.push(
        languages.registerCodeLensProvider({ scheme: 'file', language: 'rules' }, new ShaderPreviewCodeLensProvider()),
        commands.registerCommand('cosmoteer.previewShader', async (uri?: Uri, position?: Position) => {
            const editor = window.activeTextEditor;
            const targetUri = uri ?? editor?.document.uri;
            const targetPosition = position ?? editor?.selection.active;
            if (!targetUri || !targetPosition) return;
            await ShaderPreviewPanel.show(context, client, targetUri, targetPosition);
        })
    );
}
