import { Disposable, ExtensionContext, Position, Uri, ViewColumn, WebviewPanel, commands, window, workspace } from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { WorkspaceEdit as LspWorkspaceEdit } from 'vscode-languageclient';
import { imageDataUri, nonceString } from '../webview-util';

/**
 * The payload shape returned by the server's `cosmoteer/partGridData` request (client-side mirror
 * of `server/src/features/part-editor/part-grid.types.ts`, only the members the panel touches are
 * typed, the webview consumes the rest as-is).
 */
interface PartGridData {
    partName: string;
    dataVersion: number;
    anchor: { line: number; character: number };
    sprites: Array<{ id: string; uri: string | null }>;
}

/** The result shape of the server's `cosmoteer/partGridEdit` request. */
interface PartGridEditResult {
    status: 'ok' | 'stale' | 'notFound' | 'error';
    message?: string;
    edit?: LspWorkspaceEdit;
}

/** A mutation message posted by the webview (forwarded to the server verbatim). */
interface EditMessage {
    type: 'edit';
    mutation: unknown;
    dataVersion: number;
}

/**
 * Owns the single live part grid editor webview. It asks the language server for the part at the
 * invocation position (its grid size, sprites, per-cell field layers, and rotation fields), inlines
 * the sprites as data URIs, and hands the payload to the webview, which renders the interactive
 * grid. Webview clicks come back as mutations, are turned into WorkspaceEdits by the server, and
 * applied here so undo stays native. The resulting document change triggers a re-render.
 */
export class PartGridEditorPanel {
    private static current: PartGridEditorPanel | undefined;
    private readonly panel: WebviewPanel;
    private readonly disposables: Disposable[] = [];
    /** The part document and position being edited, re-queried when the document changes. */
    private tracked: { uri: Uri; position: Position } | undefined;
    /** The anchor of the part group in the last payload, echoed by edit requests. */
    private anchor: { line: number; character: number } | undefined;
    /** Debounce timer so a burst of edits coalesces into one re-render. */
    private refreshTimer: ReturnType<typeof setTimeout> | undefined;
    /** True while an edit request is in flight, serializing webview mutations. */
    private editInFlight = false;

    private constructor(
        private readonly context: ExtensionContext,
        private readonly client: LanguageClient
    ) {
        this.panel = window.createWebviewPanel('cosmoteerPartGridEditor', 'Part Grid Editor', ViewColumn.Beside, {
            enableScripts: true,
            retainContextWhenHidden: true,
            // Only the bundled webview assets need to load as resources. The part sprites can live
            // anywhere under the game or a workshop mod (outside any workspace folder), so they are
            // inlined as data URIs instead of relying on localResourceRoots.
            localResourceRoots: [Uri.joinPath(context.extensionUri, 'media')],
        });
        this.panel.onDidDispose(() => this.dispose());
        this.panel.webview.onDidReceiveMessage((message) => void this.onMessage(message));
        // Live update: re-render when the edited part document changes, whether through the grid
        // editor itself or by typing in the text editor.
        this.disposables.push(workspace.onDidChangeTextDocument((event) => this.onDocumentChanged(event.document.uri)));
        this.panel.webview.html = this.html();
    }

    /** Tears down the panel's listeners and pending refresh, and clears the singleton. */
    private dispose(): void {
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        for (const disposable of this.disposables) disposable.dispose();
        this.disposables.length = 0;
        PartGridEditorPanel.current = undefined;
    }

    /** Re-render (debounced) when the changed document is the tracked part file. */
    private onDocumentChanged(changed: Uri): void {
        if (!this.tracked) return;
        if (changed.fsPath.toLowerCase() !== this.tracked.uri.fsPath.toLowerCase()) return;
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => {
            if (this.tracked) void this.render(this.tracked.uri, this.tracked.position);
        }, 250);
    }

    /**
     * Shows the grid editor for the part at a position, creating the panel on first use and reusing
     * it after. Reveals the panel and requests a fresh render.
     *
     * @param context the extension context, for resolving the bundled webview assets.
     * @param client the language client used to query the server.
     * @param uri the document containing the part.
     * @param position a position inside the part group.
     */
    public static async show(
        context: ExtensionContext,
        client: LanguageClient,
        uri: Uri,
        position: Position
    ): Promise<void> {
        if (!PartGridEditorPanel.current) {
            PartGridEditorPanel.current = new PartGridEditorPanel(context, client);
        }
        const panel = PartGridEditorPanel.current;
        panel.panel.reveal(ViewColumn.Beside);
        await panel.render(uri, position);
    }

    /** Queries the server and posts the payload with inlined sprite images to the webview. */
    private async render(uri: Uri, position: Position): Promise<void> {
        this.tracked = { uri, position };
        const data = await this.client.sendRequest<PartGridData | null>('cosmoteer/partGridData', {
            textDocument: { uri: uri.toString() },
            position: { line: position.line, character: position.character },
        });
        if (!data) {
            this.anchor = undefined;
            await this.panel.webview.postMessage({ type: 'empty' });
            return;
        }
        this.anchor = data.anchor;
        this.panel.title = `Part Grid — ${data.partName}`;
        const spriteData: Record<string, string | null> = {};
        for (const sprite of data.sprites) spriteData[sprite.id] = imageDataUri(sprite.uri);
        await this.panel.webview.postMessage({ type: 'render', data, spriteData });
    }

    /**
     * Handles messages from the webview: `edit` mutations (sent to the server, the returned
     * WorkspaceEdit applied locally so undo stays native), `openLocation` jumps to a value's
     * source, and `refresh` re-renders on demand.
     */
    private async onMessage(message: {
        type: string;
        uri?: string;
        range?: unknown;
        mutation?: unknown;
        dataVersion?: number;
    }): Promise<void> {
        if (message.type === 'edit' && this.tracked && this.anchor) {
            await this.applyMutation({ type: 'edit', mutation: message.mutation, dataVersion: message.dataVersion ?? -1 });
        } else if (message.type === 'openLocation' && message.uri) {
            const target = Uri.parse(message.uri);
            const options = message.range ? { selection: message.range } : undefined;
            await commands.executeCommand('vscode.open', target, options);
        } else if (message.type === 'refresh' && this.tracked) {
            await this.render(this.tracked.uri, this.tracked.position);
        }
    }

    /** Sends one mutation to the server and applies the returned edit, reporting rejections back. */
    private async applyMutation(message: EditMessage): Promise<void> {
        if (!this.tracked || !this.anchor) return;
        // Serialize mutations: the webview queues clicks and sends the next one only after this
        // resolves, but guard here too so a racing message cannot interleave edits.
        if (this.editInFlight) {
            await this.panel.webview.postMessage({ type: 'editRejected', reason: 'busy' });
            return;
        }
        this.editInFlight = true;
        try {
            const result = await this.client.sendRequest<PartGridEditResult | null>('cosmoteer/partGridEdit', {
                textDocument: { uri: this.tracked.uri.toString() },
                anchor: this.anchor,
                dataVersion: message.dataVersion,
                mutation: message.mutation,
            });
            if (result?.status === 'ok' && result.edit) {
                const edit = await this.client.protocol2CodeConverter.asWorkspaceEdit(result.edit);
                const applied = await workspace.applyEdit(edit);
                if (!applied) {
                    await this.panel.webview.postMessage({ type: 'editRejected', reason: 'applyFailed' });
                    return;
                }
                // Ack with the document's new version so queued follow-up clicks are not judged
                // stale against the version this edit just advanced. The apply also fires
                // onDidChangeTextDocument, which re-renders the webview authoritatively.
                const version = workspace.textDocuments.find(
                    (candidate) => candidate.uri.toString() === this.tracked?.uri.toString()
                )?.version;
                await this.panel.webview.postMessage({ type: 'editDone', dataVersion: version });
            } else {
                await this.panel.webview.postMessage({ type: 'editRejected', reason: result?.status ?? 'error' });
                if (result?.message) void window.showWarningMessage(result.message);
                // A stale click means the webview rendered outdated geometry, resync it.
                if (result?.status === 'stale' && this.tracked) {
                    await this.render(this.tracked.uri, this.tracked.position);
                }
            }
        } finally {
            this.editInFlight = false;
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
<link rel="stylesheet" href="${asset('part-grid-editor.css')}" />
<title>Part Grid Editor</title>
</head>
<body>
<div id="editor">
<div id="stage"><canvas id="grid"></canvas><div id="status"></div></div>
<div id="sidebar"></div>
</div>
<script nonce="${nonce}" src="${asset('part-grid-editor.js')}"></script>
</body>
</html>`;
    }
}
