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
import { currentFilter, state } from './state.js';

/**
 * Everything the reader set up, in the shape a saved view is stored as. The compared part is
 * kept by its id rather than by its row key, since a key is rebuilt with the table and an id is
 * what the files themselves write. The typed values ride along so closing the panel loses no
 * question half asked.
 *
 * @returns {object} the view.
 */
export function currentView() {
    return {
        search: searchEl.value || '',
        filter: currentFilter(),
        picked: state.picked,
        shown: state.shown.slice(),
        formulas: state.formulas.map((formula) => ({ name: formula.name, formula: formula.formula })),
        frozen: state.frozen.slice(),
        order: state.order.slice(),
        widths: { ...state.widths },
        sort: { key: state.sort.key, descending: state.sort.descending },
        reference: referenceEl.value || '',
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
    categoryEl.value = (view.filter && view.filter.categories && view.filter.categories[0]) || '';
    componentEl.value = (view.filter && view.filter.components && view.filter.components[0]) || '';
    sourceEl.value = (view.filter && view.filter.sources && view.filter.sources[0]) || '';
    state.picked = !!view.picked;
    state.shown = (view.shown || []).slice();
    // The ids are handed out in order, so a sort saved on a formula column still names the same
    // column after the view is put back.
    state.nextFormulaId = 0;
    state.formulas = (view.formulas || []).map((entry) => ({
        id: `formula:${state.nextFormulaId++}`,
        name: entry.name,
        formula: entry.formula,
        values: {},
    }));
    state.frozen = (view.frozen || ['id']).slice();
    state.order = (view.order || []).slice();
    state.widths = { ...(view.widths || {}) };
    state.sort = view.sort && view.sort.key ? { key: view.sort.key, descending: !!view.sort.descending } : state.sort;
    referenceEl.value = view.reference || '';
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
            applyView(state.views[name]);
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
