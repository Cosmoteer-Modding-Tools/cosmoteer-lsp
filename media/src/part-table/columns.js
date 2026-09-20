// The filter bar and the column picker: the dropdowns that narrow the table, the compared part,
// and the list every column can be put on the table from.

import { t } from '../shared/strings.js';
import { GROUPINGS } from './constants.js';
import { columnListEl, columnSearchEl, groupEl, referenceEl, referenceListEl } from './dom.js';
import { headerOf } from './headers.js';
import { state } from './state.js';

/**
 * Fills a dropdown with the values a filter axis offers, keeping the current pick where it still
 * exists.
 *
 * @param {HTMLSelectElement} select the dropdown.
 * @param {readonly string[]} values the values to offer.
 * @param {string} anyLabel the label of the entry that filters nothing.
 */
export function fillFilter(select, values, anyLabel) {
    const previous = select.value;
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
    select.value = values.includes(previous) ? previous : '';
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
 * Fills the compared-part list with the rows the table currently holds. It is a text box with a
 * suggestion list rather than a dropdown, so a part is found by typing part of its name instead
 * of by scrolling a hundred and sixty entries.
 */
export function fillReference() {
    const previous = state.table.rows.find((row) => row.key === state.reference);
    referenceListEl.textContent = '';
    for (const row of state.table.rows) {
        const option = document.createElement('option');
        option.value = row.id;
        referenceListEl.appendChild(option);
    }
    // A part that the filter has taken off the table cannot be compared against any more.
    state.reference = previous ? previous.key : '';
    referenceEl.value = previous ? previous.id : '';
}

/**
 * Reads the compared part out of the text box, matching the id a reader typed or picked without
 * regard to case. Text that names no part compares nothing rather than guessing.
 */
export function readReference() {
    const typed = (referenceEl.value || '').trim().toLowerCase();
    const row = typed ? state.table.rows.find((entry) => entry.id.toLowerCase() === typed) : undefined;
    state.reference = row ? row.key : '';
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
        check.checked = state.shown.includes(column.path);
        check.addEventListener('change', () => {
            if (check.checked) state.shown.push(column.path);
            else state.shown = state.shown.filter((path) => path !== column.path);
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
