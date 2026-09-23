// Saved views and the working state the host keeps: everything the reader set up, written back
// after every change and put back the next time the table is opened.

import { t } from '../shared/strings.js';
import { GROUPINGS } from './constants.js';
import {
    categoryEl,
    componentEl,
    groupEl,
    percentEl,
    perTileEl,
    referenceEl,
    searchEl,
    sourceEl,
    viewListEl,
    viewsPanel,
    vscode,
} from './dom.js';
import { requestTable } from './host.js';
import { currentFilter, dropDeadFormulaSort, state } from './state.js';

/**
 * Everything the reader set up, in the shape a saved view is stored as. The compared part is
 * kept by its id rather than by its row key, since a key is rebuilt with the table and an id is
 * what the files themselves write. The typed values ride along so closing the panel loses no
 * question half asked, and the host leaves them out again of anything it offers in another
 * workspace, since a typed value belongs to the mod it was typed against.
 *
 * @returns {object} the view.
 */
export function currentView() {
    return {
        search: searchEl.value || '',
        filter: currentFilter(),
        picked: state.picked,
        shown: state.shown.slice(),
        // The id rides along with the name and the text, since the sort, the width and the dragged
        // position of a formula column all name it by its id.
        formulas: state.formulas.map((formula) => ({
            id: formula.id,
            name: formula.name,
            formula: formula.formula,
        })),
        frozen: state.frozen.slice(),
        order: state.order.slice(),
        widths: { ...state.widths },
        sort: { key: state.sort.key, descending: state.sort.descending },
        reference: state.referenceId,
        asPercent: state.asPercent,
        perTile: state.perTile,
        groupBy: state.groupBy,
        collapsed: [...state.collapsed],
        overrides: state.overrides,
        treeSelection: state.treeSelection,
        treeHidden: state.treeHidden,
    };
}

/**
 * Puts a saved view back: its filters, columns, formulas, freezing, sort and compared part. The
 * table is then asked for again, since the filter and the columns are the server's half of it.
 *
 * @param {Record<string, any>} view the saved view.
 */
export function applyView(view) {
    searchEl.value = view.search || '';
    // The filter goes on the page's state rather than into the dropdowns, which have no options
    // until the first table arrives and would drop every pick assigned into them before it does.
    const picked = (axis) => {
        const value = (view.filter && view.filter[axis] && view.filter[axis][0]) || '';
        return value ? [value] : [];
    };
    state.filter = { categories: picked('categories'), components: picked('components'), sources: picked('sources') };
    categoryEl.value = state.filter.categories[0] || '';
    componentEl.value = state.filter.components[0] || '';
    sourceEl.value = state.filter.sources[0] || '';
    state.picked = !!view.picked;
    state.shown = (view.shown || []).slice();
    // A formula comes back under the id it was written with, so a sort, a width or a dragged
    // position that names it still names it. A view kept before the ids were written down falls
    // back to the position, which is the order they were handed out in.
    state.formulas = (view.formulas || []).map((entry, index) => ({
        id: entry.id || `formula:${index}`,
        name: entry.name,
        formula: entry.formula,
        values: {},
    }));
    // The next one written is handed an id no restored column already holds.
    state.nextFormulaId = state.formulas.reduce(
        (next, entry) => Math.max(next, Number(entry.id.slice('formula:'.length)) + 1 || 0),
        0
    );
    state.frozen = (view.frozen || ['id']).slice();
    state.order = (view.order || []).slice();
    state.widths = { ...(view.widths || {}) };
    state.sort = view.sort && view.sort.key ? { key: view.sort.key, descending: !!view.sort.descending } : state.sort;
    // A sort on a formula column the view no longer carries names nothing, and a table sorted by
    // nothing marks no header while the rows fall back to part id order.
    dropDeadFormulaSort();
    state.reference = '';
    state.referenceId = view.reference || '';
    referenceEl.value = state.referenceId;
    state.asPercent = !!view.asPercent;
    percentEl.checked = state.asPercent;
    state.perTile = !!view.perTile;
    perTileEl.checked = state.perTile;
    state.groupBy = GROUPINGS[view.groupBy] ? view.groupBy : '';
    groupEl.value = state.groupBy;
    state.collapsed = new Set(view.collapsed || []);
    state.treeSelection = view.treeSelection && view.treeSelection.ship ? view.treeSelection : null;
    state.treeHidden = !!view.treeHidden;
    state.overrides = view.overrides && typeof view.overrides === 'object' ? view.overrides : {};
    requestTable(t('Putting the view back…'));
}

/**
 * Keeps the working state on the host, so closing the panel loses nothing. Everything the reader
 * set up is written back after every change, named or not, and put back the next time the table
 * is opened. A saved view is then a way of keeping several of these to switch between rather
 * than the only thing that survives the panel.
 */
export function persistState() {
    if (!state.restored) return;
    clearTimeout(state.persistStateTimer);
    state.persistStateTimer = setTimeout(
        () => vscode.postMessage({ type: 'saveState', view: currentView(), activeView: state.activeView }),
        250
    );
}

/** Redraws the list of saved views. */
export function renderViewList() {
    viewListEl.textContent = '';
    const names = Object.keys(state.views).sort((left, right) => left.localeCompare(right));
    if (names.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'hint';
        empty.textContent = t('No view saved yet.');
        viewListEl.appendChild(empty);
        return;
    }
    for (const name of names) {
        const row = document.createElement('div');
        row.className = 'row';
        const open = document.createElement('button');
        open.type = 'button';
        open.className = name === state.activeView ? 'secondary path active' : 'secondary path';
        open.textContent = name;
        open.addEventListener('click', () => {
            viewsPanel.hidden = true;
            state.activeView = name;
            // A saved view is offered in every workspace, so it brings no typed values with it. A
            // question asked about one mod's numbers is not part of a way of looking at parts, and
            // a view kept before this was so may still carry one.
            applyView({ ...state.views[name], overrides: {} });
        });
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'secondary';
        remove.textContent = t('Delete');
        remove.addEventListener('click', () => vscode.postMessage({ type: 'deleteView', name }));
        row.appendChild(open);
        row.appendChild(remove);
        viewListEl.appendChild(row);
    }
}
