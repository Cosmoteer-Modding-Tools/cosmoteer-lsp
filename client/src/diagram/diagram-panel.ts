import {
    Disposable,
    ExtensionContext,
    Position,
    Uri,
    ViewColumn,
    WebviewPanel,
    commands,
    l10n,
    window,
    workspace,
} from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { createCosmoteerPanel, disposeAll, stringsScript, webviewShell } from '../webview-util';
import { diagramViewStrings } from '../webview-strings';

/** The payload shape the server's diagram requests return. */
interface DiagramData {
    title: string;
    subtitle?: string;
    nodes: unknown[];
    edges: unknown[];
    legend: unknown[];
    notes?: string[];
}

/** What a diagram request needs beside the document and the position. */
export interface DiagramRequest {
    /** The server request the payload is asked for with. */
    readonly method: string;
    /** The panel's tab title. */
    readonly title: string;
    /** The warning shown when the server has no diagram for the position. */
    readonly missing: string;
}

/**
 * Owns the single diagram webview: a part's resource flow and its triggered-effects timeline both
 * render in it, one at a time. It asks the language server for the
 * payload of whichever diagram was invoked, hands it to the page, and re-asks when the document it
 * was built from changes. A second invocation reuses the panel.
 */
export class DiagramPanel {
    private static current: DiagramPanel | undefined;
    private readonly panel: WebviewPanel;
    private readonly disposables: Disposable[] = [];
    /** What is being drawn, re-queried when its document changes. */
    private tracked: { request: DiagramRequest; uri: Uri; position: Position } | undefined;
    /** Debounce timer so a burst of keystrokes coalesces into one rebuild. */
    private refreshTimer: ReturnType<typeof setTimeout> | undefined;
    /** Set once the page reports it is listening, since a payload posted earlier is dropped. */
    private ready = false;
    /** The payload posted before the page was ready, sent as soon as it is. */
    private queued: DiagramData | undefined;

    private constructor(
        private readonly context: ExtensionContext,
        private readonly client: LanguageClient
    ) {
        this.panel = createCosmoteerPanel(context, 'cosmoteerDiagram', l10n.t('Diagram'), ViewColumn.Beside);
        this.panel.onDidDispose(() => this.dispose());
        this.panel.webview.onDidReceiveMessage((message) => this.onMessage(message));
        this.disposables.push(workspace.onDidChangeTextDocument((event) => this.onDocumentChanged(event.document.uri)));
        this.panel.webview.html = this.html();
    }

    /** Tears down the panel's listeners and pending refresh, and clears the singleton. */
    private dispose(): void {
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        disposeAll(this.disposables);
        DiagramPanel.current = undefined;
    }

    /**
     * Re-draws (debounced) when the document the diagram was built from changes. Matching is by fs
     * path so the editor's and the server's uri encodings still line up.
     *
     * @param changed the document that changed.
     */
    private onDocumentChanged(changed: Uri): void {
        if (!this.tracked) return;
        if (changed.fsPath.toLowerCase() !== this.tracked.uri.fsPath.toLowerCase()) return;
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => {
            if (this.tracked) void this.render(this.tracked.request, this.tracked.uri, this.tracked.position);
        }, 300);
    }

    /**
     * Shows a diagram, creating the panel on first use and reusing it after.
     *
     * @param context the extension context, for resolving the bundled webview assets.
     * @param client the language client the payload is asked for through.
     * @param request which diagram to draw.
     * @param uri the document it is built from.
     * @param position the caret inside it.
     */
    public static async show(
        context: ExtensionContext,
        client: LanguageClient,
        request: DiagramRequest,
        uri: Uri,
        position: Position
    ): Promise<void> {
        if (!DiagramPanel.current) DiagramPanel.current = new DiagramPanel(context, client);
        const panel = DiagramPanel.current;
        panel.panel.reveal(ViewColumn.Beside);
        await panel.render(request, uri, position);
    }

    /**
     * Queries the server and posts the payload to the page.
     *
     * @param request which diagram to draw.
     * @param uri the document it is built from.
     * @param position the caret inside it.
     */
    private async render(request: DiagramRequest, uri: Uri, position: Position): Promise<void> {
        this.tracked = { request, uri, position };
        const data = await this.client.sendRequest<DiagramData | null>(request.method, {
            textDocument: { uri: uri.toString() },
            position: { line: position.line, character: position.character },
        });
        if (!data) {
            void window.showWarningMessage(request.missing);
            return;
        }
        this.panel.title = request.title;
        await this.post(data);
    }

    /**
     * Posts a payload, holding it back until the page says it is listening.
     *
     * @param data the diagram.
     */
    private async post(data: DiagramData): Promise<void> {
        if (!this.ready) {
            this.queued = data;
            return;
        }
        await this.panel.webview.postMessage({ type: 'diagram', diagram: data });
    }

    /**
     * Handles the page's messages: its readiness handshake, and the jump a click on a box asks for.
     *
     * @param message the message the page posted.
     */
    private async onMessage(message: { type: string; uri?: string; range?: unknown }): Promise<void> {
        if (message.type === 'ready') {
            this.ready = true;
            if (this.queued) {
                const queued = this.queued;
                this.queued = undefined;
                await this.post(queued);
            }
        } else if (message.type === 'openLocation' && message.uri) {
            await commands.executeCommand('vscode.open', Uri.parse(message.uri), {
                selection: message.range,
            });
        }
    }

    /**
     * The webview shell HTML, wiring in the bundled script and stylesheet by webview uri.
     *
     * @returns the page's HTML.
     */
    private html(): string {
        const { nonce, asset, csp } = webviewShell(this.panel.webview, this.context.extensionUri);
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="${asset('diagram-view.css')}" />
<title>Diagram</title>
</head>
<body>
<div id="page">
<div id="header">
<div id="title"></div>
<div id="subtitle" hidden></div>
<div id="controls">
<input id="filter" type="search" />
<button id="fit" type="button">${l10n.t('Fit')}</button>
<div id="legend"></div>
</div>
</div>
<div id="stage"><svg id="canvas"></svg><div id="empty"></div></div>
<ul id="notes" hidden></ul>
</div>
${stringsScript(nonce, diagramViewStrings())}
<script nonce="${nonce}" src="${asset('diagram-view.js')}"></script>
</body>
</html>`;
    }
}
