// The filter bar and the column picker: the dropdowns that narrow the table, the compared part,
// and the list every column can be put on the table from.

import { t } from '../shared/strings.js';
import { GROUPINGS } from './constants.js';
import { columnListEl, columnSearchEl, groupEl, referenceEl, referenceListEl } from './dom.js';
import { headerOf } from './headers.js';
import { state } from './state.js';

/**
 * Fills a dropdown with the values a filter axis offers, keeping the pick the page holds where the
 * values still offer it. A pick they no longer offer is dropped from the page's state as well as
 * from the dropdown, since a value nothing on the table carries would narrow it to nothing while
 * the bar said it was narrowing to something else.
 *
 * @param {HTMLSelectElement} select the dropdown.
 * @param {readonly string[]} values the values to offer.
 * @param {string} anyLabel the label of the entry that filters nothing.
 * @param {'categories'|'components'|'sources'} axis which axis of the filter the dropdown picks.
 */
export function fillFilter(select, values, anyLabel, axis) {
    const previous = (state.filter[axis] || [])[0] || '';
    select.textContent = '';
    const any = document.createElement('option');
    any.value = '';
    any.textContent = anyLabel;
    select.appendChild(any);
    for (const value of values) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = value;
        select.appendChild(option);
    }
    const kept = values.includes(previous) ? previous : '';
    state.filter[axis] = kept ? [kept] : [];
    select.value = kept;
}

/** Fills the grouping dropdown, once, with the ways the rows can be grouped. */
export function fillGrouping() {
    groupEl.textContent = '';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = t('No grouping');
    groupEl.appendChild(none);
    for (const [key, grouping] of Object.entries(GROUPINGS)) {
        const option = document.createElement('option');
        option.value = key;
        option.textContent = t(grouping.label);
        groupEl.appendChild(option);
    }
    groupEl.value = state.groupBy;
}

/**
 * What the compared-part box offers for each row, by row key.
 *
 * A part id names one row on most tables and several on a modded one: a mod that replaces a
 * vanilla part declares the vanilla part's id, and a base template declares no id at all and is
 * listed under the name of its group, which is `Part` for dozens of rows of one mod. Offering the
 * id alone would leave every row but the first of them unreachable.
 *
 * @type {Map<string, string>}
 */
const referenceLabels = new Map();

/**
 * The file a row is read from, without the member the key names.
 *
 * @param {object} row the row.
 * @returns {string} the path, with forward slashes.
 */
const pathOf = (row) =>
    String(row.uri || row.key || '')
        .replace(/\\/g, '/')
        .split('#')[0];

/**
 * Works out what each row is offered as: the part's id where it names one row, and the id with as
 * much of the file's path as it takes to tell the rows of one id apart where it names several.
 */
const labelRows = () => {
    referenceLabels.clear();
    const byId = new Map();
    for (const row of state.table.rows) {
        const id = row.id.toLowerCase();
        if (!byId.has(id)) byId.set(id, []);
        byId.get(id).push(row);
    }
    for (const rows of byId.values()) {
        if (rows.length === 1) {
            referenceLabels.set(rows[0].key, rows[0].id);
            continue;
        }
        const segments = rows.map((row) => pathOf(row).split('/'));
        let depth = 1;
        const tails = () => segments.map((parts) => parts.slice(-depth).join('/'));
        const longest = Math.max(...segments.map((parts) => parts.length));
        while (depth < longest && new Set(tails()).size < rows.length) depth++;
        const written = tails();
        rows.forEach((row, index) => referenceLabels.set(row.key, `${row.id} (${written[index]})`));
    }
};

/**
 * Fills the compared-part list with the rows the table currently holds. It is a text box with a
 * suggestion list rather than a dropdown, so a part is found by typing part of its name instead
 * of by scrolling a hundred and sixty entries.
 */
export function fillReference() {
    labelRows();
    // The row key is what the page compares by, and the id is what a kept view names the part by,
    // so a restored view is matched on its id until the rows it was kept against come back.
    const wanted = state.referenceId.toLowerCase();
    const previous =
        state.table.rows.find((row) => row.key === state.reference) ||
        (wanted ? state.table.rows.find((row) => row.id.toLowerCase() === wanted) : undefined);
    referenceListEl.textContent = '';
    for (const row of state.table.rows) {
        const option = document.createElement('option');
        option.value = referenceLabels.get(row.key) || row.id;
        referenceListEl.appendChild(option);
    }
    // A part that the filter has taken off the table cannot be compared against any more.
    state.reference = previous ? previous.key : '';
    state.referenceId = previous ? previous.id : '';
    referenceEl.value = previous ? referenceLabels.get(previous.key) || previous.id : '';
}

/**
 * Reads the compared part out of the text box, matching what the list offered or, failing that,
 * the bare id a reader typed, in both cases without regard to case. Text that names no part
 * compares nothing rather than guessing.
 */
export function readReference() {
    const typed = (referenceEl.value || '').trim().toLowerCase();
    const offered = typed
        ? state.table.rows.find((entry) => (referenceLabels.get(entry.key) || entry.id).toLowerCase() === typed)
        : undefined;
    const row = offered || (typed ? state.table.rows.find((entry) => entry.id.toLowerCase() === typed) : undefined);
    state.reference = row ? row.key : '';
    state.referenceId = row ? row.id : '';
}

/**
 * The ticks made while the column picker is open, which the Show these button turns into the
 * columns on the table. Null while the panel is closed.
 *
 * The ticks are held here rather than written straight onto the table because the table's columns
 * are the server's to compute: a column ticked and drawn without asking for it again is a column
 * of empty cells, which reads as a field no part carries.
 *
 * @type {string[]|null}
 */
let draft = null;

/** Opens the column picker on the columns the table is showing. */
export function startColumnDraft() {
    draft = state.shown.slice();
}

/** Drops the ticks, so closing the picker leaves the table as it was. */
export function discardColumnDraft() {
    draft = null;
}

/** Puts the ticks on the table, which is what the request that follows asks the server for. */
export function applyColumnDraft() {
    if (draft) state.shown = draft;
    draft = null;
}

/** Redraws the column picker's list against its search box. */
export function renderColumnList() {
    const needle = (columnSearchEl.value || '').trim().toLowerCase();
    columnListEl.textContent = '';
    // Matched against the shortened name as well as the path, so a column can be searched for
    // the way its header spells it rather than the way the file nests it.
    const matching = state.table.columns.filter((column) => {
        if (!needle) return true;
        const header = headerOf(column.path);
        return `${column.path} ${header.context} ${header.label} ${column.description || ''}`
            .toLowerCase()
            .includes(needle);
    });
    for (const column of matching.slice(0, 400)) {
        const row = document.createElement('label');
        row.className = 'row check';
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.checked = (draft || state.shown).includes(column.path);
        check.addEventListener('change', () => {
            if (!draft) return;
            if (check.checked) draft.push(column.path);
            else draft = draft.filter((path) => path !== column.path);
        });
        const path = document.createElement('span');
        path.className = 'path';
        const header = headerOf(column.path);
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = header.context ? `${header.context} › ${header.label}` : header.label;
        if (column.derived) {
            const badge = document.createElement('span');
            badge.className = 'badge';
            badge.textContent = t('computed');
            name.appendChild(document.createTextNode(' '));
            name.appendChild(badge);
        }
        const full = document.createElement('span');
        full.className = 'full';
        full.textContent = column.description || column.path;
        path.appendChild(name);
        path.appendChild(full);
        const count = document.createElement('span');
        count.className = 'count';
        count.textContent = t('{0} parts', column.rows);
        row.appendChild(check);
        row.appendChild(path);
        row.appendChild(count);
        columnListEl.appendChild(row);
    }
    if (matching.length === 0) {
        const empty = document.createElement('div');
        empty.textContent = t('No column matches.');
        columnListEl.appendChild(empty);
    }
}
