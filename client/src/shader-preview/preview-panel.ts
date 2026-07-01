import { Disposable, ExtensionContext, Position, Uri, ViewColumn, WebviewPanel, commands, window, workspace } from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { readFileSync, statSync } from 'fs';

/** The preview payload shape returned by the server's `cosmoteer/shaderPreview` request. */
interface ShaderPreviewData {
    shaderName: string;
    shaderUri: string | null;
    glsl: string | null;
    translationOk: boolean;
    reason?: string;
    constants: Array<{
        name: string;
        kind: string;
        hlslType: string;
        default?: string;
        value?: string;
        components?: number[];
    }>;
    textureUri: string | null;
    blendMode: string | null;
    tint: string | null;
    isParticle: boolean;
}

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
    /** The lower-cased fs path of the shader the last render resolved, so an edit to it triggers a refresh. */
    private previewedShaderPath: string | undefined;
    /** Debounce timer so a burst of keystrokes coalesces into one re-render. */
    private refreshTimer: ReturnType<typeof setTimeout> | undefined;

    private constructor(
        private readonly context: ExtensionContext,
        private readonly client: LanguageClient
    ) {
        this.panel = window.createWebviewPanel('cosmoteerShaderPreview', 'Shader Preview', ViewColumn.Beside, {
            enableScripts: true,
            retainContextWhenHidden: true,
            // Only the bundled webview assets need to load as resources. The sprite texture can live
            // anywhere under the game or a workshop mod (outside any workspace folder), so it is inlined
            // as a data URI instead of relying on localResourceRoots.
            localResourceRoots: [Uri.joinPath(context.extensionUri, 'media')],
        });
        this.panel.onDidDispose(() => this.dispose());
        this.panel.webview.onDidReceiveMessage((message) => this.onMessage(message));
        // Live update: re-render when the previewed material's document, or its resolved shader file,
        // changes. The server reads open buffers, so this reflects unsaved edits too.
        this.disposables.push(workspace.onDidChangeTextDocument((event) => this.onDocumentChanged(event.document.uri)));
        this.panel.webview.html = this.html();
    }

    /** Tears down the panel's listeners and pending refresh, and clears the singleton. */
    private dispose(): void {
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        for (const disposable of this.disposables) disposable.dispose();
        this.disposables.length = 0;
        ShaderPreviewPanel.current = undefined;
    }

    /**
     * Re-render (debounced) when the changed document is the tracked material or the shader it resolved
     * to. Matching is by fs path (case-insensitive) so editor and server URI encodings still line up.
     */
    private onDocumentChanged(changed: Uri): void {
        if (!this.tracked) return;
        const path = changed.fsPath.toLowerCase();
        if (path !== this.tracked.uri.fsPath.toLowerCase() && path !== this.previewedShaderPath) return;
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
            this.previewedShaderPath = undefined;
            await this.panel.webview.postMessage({ type: 'empty' });
            return;
        }
        this.previewedShaderPath = data.shaderUri ? Uri.parse(data.shaderUri).fsPath.toLowerCase() : undefined;
        this.panel.title = `Shader Preview — ${data.shaderName}`;
        await this.panel.webview.postMessage({
            type: 'render',
            data,
            textureUri: textureDataUri(data.textureUri),
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
        const nonce = nonceString();
        // A per-panel cache-buster so a rebuilt media script is fetched fresh, not served from the
        // webview's resource cache.
        const asset = (...parts: string[]): string =>
            `${this.panel.webview
                .asWebviewUri(Uri.joinPath(this.context.extensionUri, 'media', ...parts))
                .toString()}?v=${nonce}`;
        const csp =
            `default-src 'none'; img-src ${this.panel.webview.cspSource} blob: data:; ` +
            `style-src ${this.panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
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
<script nonce="${nonce}" src="${asset('shader-preview.js')}"></script>
</body>
</html>`;
    }
}

/** The image kinds the preview can inline, keyed by file extension. */
const IMAGE_MIME: Readonly<Record<string, string>> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
};

/** The largest texture inlined as a data URI, above which it is skipped to keep the message small. */
const MAX_TEXTURE_BYTES = 16 * 1024 * 1024;

/**
 * Reads a texture file into a `data:` URI so the webview can show it without a localResourceRoots
 * grant. Returns null when there is no texture, it is too large, or it cannot be read.
 *
 * @param fileUri the `file://` URI of the texture the server resolved.
 * @returns a base64 data URI, or null.
 */
const textureDataUri = (fileUri: string | null): string | null => {
    if (!fileUri) return null;
    try {
        const path = Uri.parse(fileUri).fsPath;
        if (statSync(path).size > MAX_TEXTURE_BYTES) return null;
        const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
        const mime = IMAGE_MIME[extension];
        if (!mime) return null;
        return `data:${mime};base64,${readFileSync(path).toString('base64')}`;
    } catch {
        return null;
    }
};

/** A random nonce for the webview content-security-policy script allowance. */
const nonceString = (): string => {
    let text = '';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
    return text;
};
