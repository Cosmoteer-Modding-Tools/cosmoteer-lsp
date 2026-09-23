// Talking to the host: the requests the page makes, the answers it takes, and the wiring that hangs
// the page's behaviour off its controls. startPage is the whole runtime half of the page, in the
// order it has always run in.

import { t } from '../shared/strings.js';
import { GROUPINGS } from './constants.js';
import {
    applyColumnDraft,
    discardColumnDraft,
    fillFilter,
    fillGrouping,
    fillReference,
    readReference,
    renderColumnList,
    startColumnDraft,
} from './columns.js';
import {
    applyEditsEl,
    byId,
    categoryEl,
    columnSearchEl,
    columnsPanel,
    componentEl,
    discardEditsEl,
    formulaErrorEl,
    formulaNameEl,
    formulaPanel,
    formulaTextEl,
    groupEl,
    initDom,
    percentEl,
    perTileEl,
    referenceEl,
    searchEl,
    sourceEl,
    toggleTreeEl,
    viewNameEl,
    viewsPanel,
    vscode,
} from './dom.js';
import { clearOverride, reconcileOverrides } from './editing.js';
import { exportModel } from './export-model.js';
import {
    fillFormulaExamples,
    recomputeFormulas,
    renderFormulaColumns,
    requestFormula,
    submitFormula,
} from './formulas.js';
import { currentFilter, dropDeadFormulaSort, state } from './state.js';
import { render, renderTree, setBusy, showNotice, updatePercentSwitch } from './table-view.js';
import { applyView, currentView, persistState, renderViewList } from './views.js';

/**
 * Asks the host to build the table again.
 *
 * @param {string} message what the page says while it waits.
 * @param {boolean} [refresh] whether to read the parts from disk again.
 * @param {boolean} [quiet] whether to leave the table on screen as it is while waiting.
 */
export function requestTable(message, refresh, quiet) {
    setBusy(true, message, quiet);
    // The columns already here are named, so the answer can leave them out while they stand:
    // they are the larger part of a table by far and change only with the parts or the filter.
    vscode.postMessage({
        type: 'columns',
        columns: state.picked ? state.shown : undefined,
        filter: currentFilter(),
        refresh: !!refresh,
        columnsVersion: state.table.columnsVersion || undefined,
        quiet: !!quiet,
    });
}

/** Recomputes the formulas after the rows on screen change, once the typing has paused. */
export function recomputeAfterSearch() {
    clearTimeout(state.recomputeAfterSearchTimer);
    state.recomputeAfterSearchTimer = setTimeout(recomputeFormulas, 300);
}

/** Hangs the filter bar, the tree fold, the two switches and the compared part off their controls. */
function wireFilters() {
    const narrow = () => requestTable(t('Narrowing to the parts you picked…'));

    searchEl.addEventListener('input', () => {
        render();
        recomputeAfterSearch();
    });
    // The dropdown is how the reader picks, and the page's own state is what the pick is kept in.
    const pick = (select, axis) =>
        select.addEventListener('change', () => {
            state.filter[axis] = select.value ? [select.value] : [];
            narrow();
        });
    pick(categoryEl, 'categories');
    pick(componentEl, 'components');
    pick(sourceEl, 'sources');
    groupEl.addEventListener('change', () => {
        state.groupBy = GROUPINGS[groupEl.value] ? groupEl.value : '';
        render();
    });
    toggleTreeEl.addEventListener('click', () => {
        state.treeHidden = !state.treeHidden;
        renderTree();
        persistState();
    });
    percentEl.addEventListener('change', () => {
        state.asPercent = percentEl.checked;
        render();
    });
    perTileEl.addEventListener('change', () => {
        state.perTile = perTileEl.checked;
        render();
    });
    referenceEl.addEventListener('change', () => {
        const before = state.reference;
        readReference();
        if (state.reference === before) return;
        updatePercentSwitch();
        recomputeFormulas();
        render();
    });
}

/** What the last write said about the typed values it left alone, kept until the host answers. */
let leftAloneNotice = '';

/** Hangs the buttons that write the typed values to the files and that drop them off their clicks. */
function wireEditButtons() {
    applyEditsEl.addEventListener('click', () => {
        const edits = [];
        let unseen = 0;
        for (const [rowKey, own] of Object.entries(state.overrides)) {
            // Only a row the reader can see is written. A typed value whose row is not on the
            // table belongs to a question asked of some other set of parts, and a row key is a path
            // that resolves in any workspace, so writing it here would edit a file on the strength
            // of a number typed somewhere else.
            const onScreen = state.table.rows.some((row) => row.key === rowKey);
            for (const [column, typed] of Object.entries(own)) {
                if (onScreen) edits.push({ row: rowKey, column, text: typed.text });
                else unseen++;
            }
        }
        leftAloneNotice =
            unseen === 0
                ? ''
                : unseen === 1
                  ? t('1 typed value belongs to a part this table is not showing, and was left alone.')
                  : t('{0} typed values belong to parts this table is not showing, and were left alone.', unseen);
        showNotice(leftAloneNotice);
        if (edits.length === 0) return;
        vscode.postMessage({ type: 'applyEdits', edits });
    });
    discardEditsEl.addEventListener('click', () => {
        state.overrides = {};
        showNotice('');
        recomputeFormulas();
        render();
    });
}

/** Hangs the column picker off its button, its search box and the two buttons that close it. */
function wireColumnsPanel() {
    byId('pick-columns').addEventListener('click', () => {
        columnsPanel.hidden = false;
        startColumnDraft();
        renderColumnList();
        columnSearchEl.focus();
    });
    columnSearchEl.addEventListener('input', renderColumnList);
    byId('columns-apply').addEventListener('click', () => {
        columnsPanel.hidden = true;
        applyColumnDraft();
        state.picked = true;
        requestTable(t('Reading the picked columns…'));
    });
    byId('columns-close').addEventListener('click', () => {
        // Close cancels: the ticks are dropped and the table stays on the columns it was already
        // showing. A ticked column drawn without asking the server for it would be a column of
        // empty cells, which reads as a field no part carries.
        columnsPanel.hidden = true;
        discardColumnDraft();
    });
}

/** Hangs the formula panel off its button, the two buttons that close it, and the one that clears. */
function wireFormulaPanel() {
    byId('add-formula').addEventListener('click', () => {
        formulaPanel.hidden = false;
        renderFormulaColumns();
        formulaNameEl.focus();
    });
    byId('formula-apply').addEventListener('click', submitFormula);
    byId('formula-close').addEventListener('click', () => {
        formulaPanel.hidden = true;
        formulaErrorEl.hidden = true;
    });
    byId('clear-formulas').addEventListener('click', () => {
        state.formulas = [];
        dropDeadFormulaSort();
        render();
    });
}

/** Hangs the saved views panel and the workbook export off their buttons. */
function wireViewsPanel() {
    byId('pick-views').addEventListener('click', () => {
        viewsPanel.hidden = false;
        // Prefilled with the view being looked at, so saving writes the changes back to it rather
        // than asking for the name again.
        viewNameEl.value = state.activeView;
        renderViewList();
        viewNameEl.focus();
    });
    byId('views-close').addEventListener('click', () => {
        viewsPanel.hidden = true;
    });
    byId('view-save').addEventListener('click', () => {
        const name = (viewNameEl.value || '').trim();
        if (!name) return;
        state.activeView = name;
        vscode.postMessage({ type: 'saveView', name, view: currentView() });
        persistState();
    });
    byId('export-excel').addEventListener('click', () =>
        vscode.postMessage({ type: 'exportExcel', model: exportModel() })
    );
}

/**
 * Takes one message from the host: the saved views, a word about what is being waited on, a notice
 * that the files moved, a table, one formula column's values, or the outcome of a write.
 *
 * @param {Record<string, any>} message the message.
 */
function onHostMessage(message) {
    if (!message) return;
    if (message.type === 'views') {
        state.views = message.views || {};
        // The working state is put back once, on the first answer, so a panel opened again picks
        // up exactly where it was left rather than at the default table.
        if (!state.restored) {
            state.restored = true;
            state.activeView = message.activeView || '';
            if (message.state) {
                applyView(message.state);
                return;
            }
        }
        renderViewList();
        return;
    }
    if (message.type === 'loading') {
        setBusy(true, message.text || t('Reading the parts…'), !!message.quiet);
        return;
    }
    if (message.type === 'changed') {
        // The files moved under the table. While a value is being typed the refresh waits, since
        // redrawing the table would take the box away mid-word.
        if (state.editing) {
            state.refreshPending = true;
            return;
        }
        requestTable(t('Following your edit…'), false, true);
        return;
    }
    if (message.type === 'table') {
        takeTable(message);
        return;
    }
    if (message.type === 'formulaResult') {
        takeFormulaResult(message);
        return;
    }
    if (message.type === 'editsApplied') {
        takeEditsApplied(message);
        return;
    }
    if (message.type === 'notice') {
        showNotice(message.text || '');
    }
}

/**
 * Takes a table the server built: its filters, its compared part, its tree and its columns, then
 * computes the formula columns over it and draws it.
 *
 * @param {Record<string, any>} message the table message.
 */
function takeTable(message) {
    // A host that could not read the parts still answers, so the page says so and stays usable.
    // Taking the missing table would leave the page holding nothing, and every later click, every
    // keystroke in the filter box and even the next good table would fail against it.
    if (!message.table) {
        setBusy(false);
        showNotice(t('The parts could not be read.'));
        return;
    }
    // An answer without columns is one for the version already here, which stays.
    const kept = state.table.columns;
    state.table = message.table;
    if (!state.table.columns) state.table.columns = kept;
    setBusy(false);
    // The columns the answer names are the ones the request asked for, and an answer naming none is
    // one for a request that asked for none. Until the reader has picked, that is the page asking
    // the server to rank the columns and taking what it ranks. Once they have picked, their pick
    // stands: the host asks for it again on their behalf, and taking the ranking here would drop it.
    if (message.columns && message.columns.length) state.shown = message.columns.slice();
    else if (!state.picked) state.shown = state.table.suggested.slice();
    fillFilter(categoryEl, state.table.categories, t('Every category'), 'categories');
    fillFilter(componentEl, state.table.componentTypes, t('Every component'), 'components');
    fillFilter(sourceEl, state.table.sources, t('Everywhere'), 'sources');
    fillReference();
    updatePercentSwitch();
    reconcileOverrides();
    renderTree();
    if (message.pendingFormula) {
        const formula = state.formulas.find((entry) => entry.id === message.pendingFormula);
        if (formula) requestFormula(formula);
    }
    recomputeFormulas();
    render();
}

/**
 * Takes one formula column's values, or the reason the server could not compute them, which puts
 * the panel back up with the error against the formula that was written.
 *
 * @param {Record<string, any>} message the formula result message.
 */
function takeFormulaResult(message) {
    const formula = state.formulas.find((entry) => entry.id === message.id);
    if (!formula) return;
    if (message.error) {
        state.formulas = state.formulas.filter((entry) => entry.id !== message.id);
        // The column is gone, and a sort left on it would name nothing.
        dropDeadFormulaSort();
        formulaPanel.hidden = false;
        formulaErrorEl.hidden = false;
        formulaErrorEl.textContent = message.error;
    } else {
        formula.values = message.values || {};
    }
    render();
}

/**
 * Takes the outcome of a write. A value the host wrote is the file's now, so it stops being a typed
 * one. The table reads itself again on the change notice that follows the write.
 *
 * @param {Record<string, any>} message the edits-applied message.
 */
function takeEditsApplied(message) {
    // The values the write left alone are said again beside its outcome, since the reader is told
    // about them once and the answer would otherwise take the line away.
    const lines = leftAloneNotice ? [leftAloneNotice] : [];
    leftAloneNotice = '';
    for (const result of message.results || []) {
        if (result.status === 'ok') {
            const row = state.table.rows.find((entry) => entry.key === result.row);
            if (row) clearOverride(row, result.column);
            if (result.note) lines.push(result.note);
        } else if (result.message) lines.push(result.message);
    }
    showNotice(lines.join('  ·  '));
    render();
}

/**
 * Starts the page: looks the elements up, labels the boxes, fills the grouping dropdown, hangs the
 * behaviour off the controls, and asks the host for the table and the saved views.
 */
export function startPage() {
    initDom();
    searchEl.placeholder = t('Filter parts');
    columnSearchEl.placeholder = t('Search columns');
    formulaNameEl.placeholder = t('Column name');
    formulaTextEl.placeholder = t('[MaxHealth] / [@Tiles]');
    fillGrouping();
    setBusy(true, t('Reading the parts…'));
    fillFormulaExamples();
    wireFilters();
    wireEditButtons();
    wireColumnsPanel();
    wireFormulaPanel();
    byId('refresh').addEventListener('click', () => requestTable(t('Reading the parts…'), true));
    wireViewsPanel();
    window.addEventListener('message', (event) => onHostMessage(event.data));
    vscode.postMessage({ type: 'ready' });
    vscode.postMessage({ type: 'listViews' });
}
