import { Disposable, ExtensionContext, Position, Uri, ViewColumn, WebviewPanel, commands, l10n, workspace } from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { createCosmoteerPanel, disposeAll, imageDataUri, stringsScript, webviewShell } from '../webview-util';
import { shaderPreviewStrings } from '../webview-strings';
import { ShaderPreviewData } from './preview-panel.types';

/**
 * Owns the single live shader-preview webview. It asks the language server for the material under the
 * cursor (its translated shader, constants, texture, and blend mode), converts the on-disk URIs to
 * webview URIs, and hands the whole payload to the webview, which compiles the GLSL and renders the
 * material the way the game does. A second invocation reuses the existing panel.
 */
export class ShaderPreviewPanel {
    private static current: ShaderPreviewPanel | undefined;
    private readonly panel: WebviewPanel;
    private readonly disposables: Disposable[] = [];
    /** The material being previewed, re-queried when its document or its shader changes. */
    private tracked: { uri: Uri; position: Position } | undefined;
    /**
     * The lower-cased fs paths of every file the last render read, the shader and its whole `#include`
     * chain, so editing a base library refreshes a shader that only includes it.
     */
    private previewedSourcePaths: ReadonlySet<string> = new Set();
    /** Debounce timer so a burst of keystrokes coalesces into one re-render. */
    private refreshTimer: ReturnType<typeof setTimeout> | undefined;

    private constructor(
        private readonly context: ExtensionContext,
        private readonly client: LanguageClient
    ) {
        this.panel = createCosmoteerPanel(context, 'cosmoteerShaderPreview', l10n.t('Shader Preview'), ViewColumn.Beside);
        this.panel.onDidDispose(() => this.dispose());
        this.panel.webview.onDidReceiveMessage((message) => this.onMessage(message));
        // Live update: re-render when the previewed material's document, or any file in its shader's
        // include chain, changes. The server reads open buffers, so this reflects unsaved edits too,
        // and the watcher adds the changes that happen outside the editor (a git checkout, a build).
        this.disposables.push(workspace.onDidChangeTextDocument((event) => this.onDocumentChanged(event.document.uri)));
        const watcher = workspace.createFileSystemWatcher('**/*.shader');
        this.disposables.push(watcher);
        this.disposables.push(watcher.onDidChange((uri) => this.onDocumentChanged(uri)));
        this.disposables.push(watcher.onDidCreate((uri) => this.onDocumentChanged(uri)));
        this.disposables.push(watcher.onDidDelete((uri) => this.onDocumentChanged(uri)));
        this.panel.webview.html = this.html();
    }

    /** Tears down the panel's listeners and pending refresh, and clears the singleton. */
    private dispose(): void {
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        disposeAll(this.disposables);
        ShaderPreviewPanel.current = undefined;
    }

    /**
     * Re-render (debounced) when the changed file is the tracked material or any file in the shader's
     * include chain. Matching is by fs path (case-insensitive) so editor and server URI encodings still
     * line up.
     */
    private onDocumentChanged(changed: Uri): void {
        if (!this.tracked) return;
        const path = changed.fsPath.toLowerCase();
        if (path !== this.tracked.uri.fsPath.toLowerCase() && !this.previewedSourcePaths.has(path)) return;
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => {
            if (this.tracked) void this.render(this.tracked.uri, this.tracked.position);
        }, 250);
    }

    /**
     * Shows the preview for the material at a position, creating the panel on first use and reusing it
     * after. Reveals the panel and requests a fresh render.
     *
     * @param context the extension context, for resolving the bundled webview assets.
     * @param client the language client used to query the server.
     * @param uri the document containing the material.
     * @param position the position of the material's `Shader` assignment.
     */
    public static async show(
        context: ExtensionContext,
        client: LanguageClient,
        uri: Uri,
        position: Position
    ): Promise<void> {
        if (!ShaderPreviewPanel.current) {
            ShaderPreviewPanel.current = new ShaderPreviewPanel(context, client);
        }
        const panel = ShaderPreviewPanel.current;
        panel.panel.reveal(ViewColumn.Beside);
        await panel.render(uri, position);
    }

    /** Queries the server and posts the resolved, webview-ready payload to the webview. */
    private async render(uri: Uri, position: Position): Promise<void> {
        // Remember what we are previewing so a later document change can trigger a live re-render.
        this.tracked = { uri, position };
        const data = await this.client.sendRequest<ShaderPreviewData | null>('cosmoteer/shaderPreview', {
            textDocument: { uri: uri.toString() },
            position: { line: position.line, character: position.character },
        });
        if (!data) {
            this.previewedSourcePaths = new Set();
            await this.panel.webview.postMessage({ type: 'empty' });
            return;
        }
        const sources = data.sourceUris?.length ? data.sourceUris : data.shaderUri ? [data.shaderUri] : [];
        this.previewedSourcePaths = new Set(sources.map((uri) => Uri.parse(uri).fsPath.toLowerCase()));
        this.panel.title = l10n.t('Shader Preview: {0}', data.shaderName);
        // Every bound texture is inlined as a data URI keyed by its sampler uniform, so noise and ramp
        // textures load in the webview the same way the base texture does.
        const textureData: Record<string, string | null> = {};
        for (const texture of data.textures) textureData[texture.name] = imageDataUri(texture.uri);
        await this.panel.webview.postMessage({
            type: 'render',
            data,
            textureData,
        });
    }

    /** Handles messages from the webview (currently only the "open shader source" affordance). */
    private async onMessage(message: { type: string; uri?: string }): Promise<void> {
        if (message.type === 'openShader' && message.uri) {
            await commands.executeCommand('vscode.open', Uri.parse(message.uri));
        }
    }

    /** The webview shell HTML, wiring in the bundled script and stylesheet by webview URI. */
    private html(): string {
        const { nonce, asset, csp } = webviewShell(this.panel.webview, this.context.extensionUri);
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="${asset('shader-preview.css')}" />
<title>Shader Preview</title>
</head>
<body>
<div id="stage"><canvas id="gl" width="320" height="320"></canvas><div id="status"></div></div>
<div id="meta"></div>
<div id="controls"></div>
${stringsScript(nonce, shaderPreviewStrings())}
<script nonce="${nonce}" src="${asset('shader-preview.js')}"></script>
</body>
</html>`;
    }
}
