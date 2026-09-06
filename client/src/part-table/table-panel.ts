import {
    Disposable,
    ExtensionContext,
    Uri,
    ViewColumn,
    WebviewPanel,
    commands,
    env,
    l10n,
    window,
    workspace,
} from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { createCosmoteerPanel, disposeAll, stringsScript, webviewShell } from '../webview-util';
import { partTableStrings } from '../webview-strings';
import {
    PanelMessage,
    PartTableData,
    PartTableEdit,
    PartTableEditResult,
    PartTableFormulaResult,
} from './table-panel.types';

/**
 * Where the saved views live. Global rather than per workspace: a view is a way of looking at parts,
 * and the parts of the game are the same whichever mod is open.
 */
const VIEWS_KEY = 'cosmoteer.partTable.views';

/**
 * Where the working state lives: everything the reader had set up when the panel was last used,
 * named or not. Kept so closing the panel loses nothing, which a saved view alone cannot promise:
 * a view is a snapshot from the moment it was saved, and the reader goes on working after it.
 */
const STATE_KEY = 'cosmoteer.partTable.state';

/**
 * Owns the single live part table webview: the spreadsheet view of every part of the game and of
 * the mod being edited, with the members they carry resolved to the numbers the game computes.
 *
 * The panel is a courier. It asks the server for the table, hands it to the page, and sends the
 * page's column picks and formula columns back to be computed. Nothing about a part is decided
 * here, which is what keeps the view saying the same thing the rest of the language server says.
 */
export class PartTablePanel {
    private static current: PartTablePanel | undefined;
    private readonly panel: WebviewPanel;
    private readonly disposables: Disposable[] = [];
    /** The document the table is scoped to, re-queried when the page asks for a rebuild. */
    private tracked: Uri | undefined;
    /** True once the page has said it is listening, so nothing is posted into the void. */
    private ready = false;
    /** True while a table request is out, which is when the server's progress is worth relaying. */
    private waiting = false;
    /** Whether the page keeps its table on screen through the current wait. */
    private quietWait = false;
    /** The payload posted before the page was listening. */
    private queued: { table: PartTableData; columns?: string[]; pendingFormula?: string } | undefined;

    private constructor(
        private readonly context: ExtensionContext,
        private readonly client: LanguageClient
    ) {
        this.panel = createCosmoteerPanel(context, 'cosmoteerPartTable', l10n.t('Part Table'), ViewColumn.Active);
        this.panel.onDidDispose(() => this.dispose());
        this.panel.webview.onDidReceiveMessage((message) => void this.onMessage(message as PanelMessage));
        this.panel.webview.html = this.html();
    }

    /** Tears down the panel's listeners and clears the singleton. */
    private dispose(): void {
        disposeAll(this.disposables);
        PartTablePanel.current = undefined;
    }

    /**
     * Shows the part table, creating the panel on first use and reusing it after.
     *
     * @param context the extension context, for resolving the bundled webview assets.
     * @param client the language client the table is asked for through.
     * @param uri the document the table is scoped to, absent when no editor is open.
     */
    public static async show(context: ExtensionContext, client: LanguageClient, uri?: Uri): Promise<void> {
        if (!PartTablePanel.current) PartTablePanel.current = new PartTablePanel(context, client);
        const panel = PartTablePanel.current;
        panel.panel.reveal(ViewColumn.Active);
        // Opened with the table itself or a non-rules file in front, the table is still about the
        // mod the reader is working in, which any rules file they have open names.
        const fallback = workspace.textDocuments.find((document) => document.languageId === 'rules')?.uri;
        await panel.render(uri ?? panel.tracked ?? fallback);
    }

    /**
     * Tells the open table that the files moved under it, so it asks for its rows again. The server
     * sends the notice after every change that makes the last table stale, and with no table open
     * there is nothing to tell.
     */
    public static notifyChanged(): void {
        const panel = PartTablePanel.current;
        if (!panel || !panel.ready) return;
        void panel.panel.webview.postMessage({ type: 'changed' });
    }

    /**
     * Tells the open table how far the server's walk has come, so the wait for a large mod says
     * which part it is on rather than nothing.
     *
     * @param done how many parts have been read.
     * @param total how many parts the walk reads in all.
     */
    public static notifyProgress(done: number, total: number): void {
        const panel = PartTablePanel.current;
        if (!panel || !panel.ready || !panel.waiting) return;
        void panel.panel.webview.postMessage({
            type: 'loading',
            text: l10n.t('Reading part {0} of {1}…', done, total),
            quiet: panel.quietWait,
        });
    }

    /**
     * Asks the server for the table and hands it to the page.
     *
     * @param uri the document the table is scoped to.
     * @param columns the column paths to compute, absent to let the server rank them.
     * @param pendingFormula the formula the page is waiting to have computed once the columns land.
     * @param filter which parts to narrow to, forwarded from the page's filter bar.
     * @param refresh whether to read the parts from disk again rather than from the last walk.
     * @param columnsVersion the columns version the page holds, so the answer can leave them out.
     * @param quiet whether the page keeps its table on screen while it waits, as it does following an edit.
     */
    private async render(
        uri?: Uri,
        columns?: string[],
        pendingFormula?: string,
        filter?: unknown,
        refresh?: boolean,
        columnsVersion?: string,
        quiet?: boolean
    ): Promise<void> {
        if (uri) this.tracked = uri;
        // The page says it is waiting rather than sitting on a stale table with nothing happening.
        // The first build walks every part of the install, which is seconds rather than an instant.
        this.quietWait = !!quiet;
        if (this.ready) {
            await this.panel.webview.postMessage({
                type: 'loading',
                text: l10n.t('Reading the parts…'),
                quiet: this.quietWait,
            });
        }
        this.waiting = true;
        const table = await this.client
            .sendRequest<PartTableData | null>('cosmoteer/partTable', {
                textDocument: this.tracked ? { uri: this.tracked.toString() } : undefined,
                columns,
                filter,
                refresh,
                columnsVersion,
            })
            .finally(() => {
                this.waiting = false;
            });
        if (!table) {
            void window.showWarningMessage(l10n.t('The parts could not be read.'));
            return;
        }
        if (table.emptyReason === 'noGamePath') {
            void window.showWarningMessage(
                l10n.t('Set the path to the game data before comparing parts: cosmoteerLSPRules.cosmoteerPath.')
            );
        }
        await this.post({ table, columns, pendingFormula });
    }

    /**
     * Posts a payload, holding it back until the page says it is listening.
     *
     * @param payload the table with the columns it was built for.
     */
    private async post(payload: { table: PartTableData; columns?: string[]; pendingFormula?: string }): Promise<void> {
        if (!this.ready) {
            this.queued = payload;
            return;
        }
        await this.panel.webview.postMessage({ type: 'table', ...payload });
    }

    /**
     * Handles the page's messages: its readiness handshake, the jump a click on a cell asks for, a
     * changed column set, a formula column, a rebuild and the export.
     *
     * @param message the message the page posted.
     */
    private async onMessage(message: PanelMessage): Promise<void> {
        switch (message.type) {
            case 'ready': {
                this.ready = true;
                if (this.queued) {
                    const queued = this.queued;
                    this.queued = undefined;
                    await this.post(queued);
                }
                return;
            }
            case 'openLocation': {
                if (!message.uri) return;
                await commands.executeCommand('vscode.open', Uri.parse(message.uri), { selection: message.range });
                return;
            }
            case 'columns':
            case 'refresh': {
                await this.render(
                    undefined,
                    message.columns,
                    message.pendingFormula,
                    message.filter,
                    message.refresh,
                    message.columnsVersion,
                    message.quiet
                );
                return;
            }
            case 'listViews': {
                await this.postViews();
                return;
            }
            case 'saveState': {
                await this.context.globalState.update(STATE_KEY, {
                    view: message.view,
                    activeView: message.activeView ?? '',
                });
                return;
            }
            case 'saveView': {
                if (!message.name || !message.view) return;
                await this.context.globalState.update(VIEWS_KEY, {
                    ...this.savedViews(),
                    [message.name]: message.view,
                });
                await this.postViews();
                return;
            }
            case 'deleteView': {
                if (!message.name) return;
                const remaining = { ...this.savedViews() };
                delete remaining[message.name];
                await this.context.globalState.update(VIEWS_KEY, remaining);
                await this.postViews();
                return;
            }
            case 'formula': {
                if (!message.id || !message.formula) return;
                const result = await this.client.sendRequest<PartTableFormulaResult>('cosmoteer/partTableFormula', {
                    formula: message.formula,
                    reference: message.reference || undefined,
                    formulas: message.formulas,
                    rows: message.rows,
                    overrides: message.overrides,
                });
                await this.panel.webview.postMessage({ type: 'formulaResult', id: message.id, ...result });
                return;
            }
            case 'applyEdits': {
                await this.applyEdits(message.edits ?? []);
                return;
            }
            case 'copyCsv': {
                if (!message.text) return;
                await env.clipboard.writeText(message.text);
                void window.showInformationMessage(l10n.t('The table is on the clipboard, ready to paste.'));
                return;
            }
        }
    }

    /**
     * Writes the values the reader typed over cells into their files, one edit at a time so two
     * edits into one file cannot race, and tells the page how each one fared. The edit is built on
     * the server and applied here, so it lands in the editor with its undo.
     *
     * @param edits the typed values, each naming its row and column.
     */
    private async applyEdits(edits: readonly PartTableEdit[]): Promise<void> {
        const results: Array<PartTableEdit & { status: string; message?: string; note?: string }> = [];
        for (const edit of edits) {
            const result = await this.client
                .sendRequest<PartTableEditResult | null>('cosmoteer/partTableEdit', edit)
                .catch(() => null);
            if (!result) {
                results.push({ ...edit, status: 'error', message: l10n.t('The value could not be written.') });
                continue;
            }
            if (result.status === 'ok' && result.edit) {
                const workspaceEdit = await this.client.protocol2CodeConverter.asWorkspaceEdit(result.edit);
                const applied = await workspace.applyEdit(workspaceEdit);
                results.push(
                    applied
                        ? { ...edit, status: 'ok', note: result.note }
                        : { ...edit, status: 'error', message: l10n.t('The value could not be written.') }
                );
                continue;
            }
            results.push({ ...edit, status: result.status, message: result.message });
        }
        await this.panel.webview.postMessage({ type: 'editsApplied', results });
    }

    /**
     * The views saved on this machine, keyed by the name the reader gave them.
     *
     * @returns the saved views, empty when none has been saved yet.
     */
    private savedViews(): Record<string, unknown> {
        return this.context.globalState.get<Record<string, unknown>>(VIEWS_KEY) ?? {};
    }

    /**
     * Hands the page the saved views, after a save, a delete, or on its first request. The working
     * state rides along, which is what the page puts back when it opens.
     */
    private async postViews(): Promise<void> {
        const kept = this.context.globalState.get<{ view?: unknown; activeView?: string }>(STATE_KEY);
        await this.panel.webview.postMessage({
            type: 'views',
            views: this.savedViews(),
            state: kept?.view,
            activeView: kept?.activeView ?? '',
        });
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
<link rel="stylesheet" href="${asset('part-table.css')}" />
<title>Part Table</title>
</head>
<body>
<div id="page">
<div id="toolbar">
<input id="search" type="search" />
<select id="category"></select>
<select id="component"></select>
<select id="source"></select>
<select id="group"></select>
<button id="toggle-tree" type="button" class="secondary">${l10n.t('Hide tree')}</button>
<button id="pick-columns" type="button" class="secondary">${l10n.t('Columns…')}</button>
<button id="add-formula" type="button" class="secondary">${l10n.t('Add formula')}</button>
<button id="clear-formulas" type="button" class="secondary">${l10n.t('Clear formulas')}</button>
<button id="pick-views" type="button" class="secondary">${l10n.t('Views…')}</button>
<label class="check">${l10n.t('Compare with')} <input id="reference" type="search" list="reference-options" /></label>
<datalist id="reference-options"></datalist>
<label class="check"><input id="percent" type="checkbox" disabled />${l10n.t('Show as % of that part')}</label>
<span id="legend" class="legend" hidden><span class="swatch below"></span>${l10n.t('below')} <span class="swatch same"></span>${l10n.t('same')} <span class="swatch above"></span>${l10n.t('above')}</span>
<label class="check"><input id="per-tile" type="checkbox" />${l10n.t('Per tile')}</label>
<button id="copy-csv" type="button" class="secondary">${l10n.t('Copy as CSV')}</button>
<button id="refresh" type="button" class="secondary">${l10n.t('Refresh')}</button>
<button id="apply-edits" type="button" hidden></button>
<button id="discard-edits" type="button" class="secondary" hidden></button>
<div id="status"></div>
<div id="notice" hidden></div>
</div>
<div id="loading"><span class="spinner"></span><span class="text">${l10n.t('Reading the parts…')}</span></div>
<div id="body">
<div id="tree" hidden></div>
<div id="main">
<div id="stage"></div>
<div id="empty" hidden></div>
</div>
</div>
<div id="columns-panel" class="panel" hidden>
<h2>${l10n.t('Columns')}</h2>
<input id="column-search" type="search" />
<div id="column-list" class="list"></div>
<div class="actions">
<button id="columns-close" type="button" class="secondary">${l10n.t('Close')}</button>
<button id="columns-apply" type="button">${l10n.t('Show these')}</button>
</div>
</div>
<div id="views-panel" class="panel" hidden>
<h2>${l10n.t('Saved views')}</h2>
<div class="hint">${l10n.t('A view keeps the filters, the grouping, the columns, the formulas, the frozen columns, the sort, the compared part and any values you typed.')}</div>
<div class="row"><input id="view-name" type="text" placeholder="${l10n.t('Name this view')}" /><button id="view-save" type="button">${l10n.t('Save')}</button></div>
<div id="view-list" class="list"></div>
<div class="actions">
<button id="views-close" type="button" class="secondary">${l10n.t('Close')}</button>
</div>
</div>
<div id="formula-panel" class="panel" hidden>
<h2>${l10n.t('Formula column')}</h2>
<input id="formula-name" type="text" />
<input id="formula-text" type="text" />
<div id="formula-error" hidden></div>
<div class="hint">${l10n.t('Write column paths in square brackets, exactly as the column picker spells them. A path with no slashes may be written bare, and another formula is named by its name. A * in a path matches every column it fits, so sum([Resources/*]) adds every resource. The functions of the rules math are available (round, min, max, sum, avg, abs, sqrt, …), plus if(condition, then, else), coalesce(a, b, …) for the first value that exists, has(column), ref(column) for the value of the compared part, and colmin, colmax, colavg, colsum, colcount, colmedian and rank over the parts on screen. Double-click a cell to try a value: the formulas follow it, and writing the changes puts it in the file.')}</div>
<div class="hint">${l10n.t('Pick an example to start from:')}</div>
<div id="formula-examples" class="examples list"></div>
<div class="hint">${l10n.t('Insert a column on screen:')}</div>
<div id="formula-columns" class="examples list"></div>
<div class="actions">
<button id="formula-close" type="button" class="secondary">${l10n.t('Close')}</button>
<button id="formula-apply" type="button">${l10n.t('Add column')}</button>
</div>
</div>
</div>
${stringsScript(nonce, partTableStrings())}
<script nonce="${nonce}" src="${asset('part-table.js')}"></script>
</body>
</html>`;
    }
}
