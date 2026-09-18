// Typing a value over a cell. A typed value is a question asked of the table rather than a change
// made to the mod, so it lives on the page until the reader writes it to the files.

import { t } from '../shared/strings.js';
import { IDENTITY } from './constants.js';
import { applyEditsEl, discardEditsEl } from './dom.js';
import { parseTyped } from './headers.js';
import { requestTable } from './host.js';
import { overrideOf, state } from './state.js';
import { render } from './table-view.js';
import { recomputeFormulas } from './formulas.js';

/** @import {PartRow} from './types.js' */

/**
 * Whether a column's cells can be typed over: a value read from a file, which a computed column
 * and a formula column are not.
 *
 * @param {string} key the column key.
 * @returns {boolean} true when the cells take typed values.
 */
export function editable(key) {
    return !IDENTITY.includes(key) && !key.startsWith('formula:') && !key.startsWith('@');
}

/**
 * Turns a cell into a box the reader types a value into. Enter keeps the value as a typed-over
 * one, Escape leaves the cell as it was, and an empty box takes a typed value back.
 *
 * @param {HTMLElement} cell the cell.
 * @param {PartRow} row the row.
 * @param {string} key the column path.
 */
export function startEditing(cell, row, key) {
    if (state.editing) return;
    const typed = overrideOf(row, key);
    const source = row.cells[key];
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'cell-input';
    input.value = typed ? typed.text : source ? source.text : '';
    cell.textContent = '';
    cell.appendChild(input);
    state.editing = { cell, row, key };
    const finish = (commit) => {
        if (!state.editing) return;
        state.editing = null;
        if (commit) {
            const text = input.value.trim();
            if (!text || (source && text === source.text)) clearOverride(row, key);
            else {
                const parsed = parseTyped(text);
                if (!parsed) {
                    input.classList.add('invalid');
                    input.title = t('Write a number, with the % d or r suffix the value already has.');
                    state.editing = { cell, row, key };
                    return;
                }
                if (!state.overrides[row.key]) state.overrides[row.key] = {};
                state.overrides[row.key][key] = parsed;
            }
            recomputeFormulas();
        }
        render();
        if (state.refreshPending) {
            state.refreshPending = false;
            requestTable(t('Following your edit…'), false, true);
        }
    };
    input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') finish(true);
        else if (event.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    input.focus();
    input.select();
}

/**
 * Takes a typed value back, so the cell reads the file's value again.
 *
 * @param {PartRow} row the row.
 * @param {string} key the column path.
 */
export function clearOverride(row, key) {
    const own = state.overrides[row.key];
    if (!own) return;
    delete own[key];
    if (Object.keys(own).length === 0) delete state.overrides[row.key];
}

/**
 * How many cells hold a typed value.
 *
 * @returns {number} the count.
 */
export function overrideCount() {
    let count = 0;
    for (const own of Object.values(state.overrides)) count += Object.keys(own).length;
    return count;
}

/**
 * Drops the typed values the files now hold, after the host wrote them and the table was read
 * again. A typed value the file still disagrees with stays typed.
 */
export function reconcileOverrides() {
    for (const row of state.table.rows) {
        const own = state.overrides[row.key];
        if (!own) continue;
        for (const [key, typed] of Object.entries(own)) {
            const cell = row.cells[key];
            if (cell && (cell.text === typed.text || cell.value === typed.value)) delete own[key];
        }
        if (Object.keys(own).length === 0) delete state.overrides[row.key];
    }
}

/** Shows or hides the buttons that write and discard the typed values, with their count. */
export function updateEditButtons() {
    const count = overrideCount();
    applyEditsEl.hidden = count === 0;
    discardEditsEl.hidden = count === 0;
    applyEditsEl.textContent =
        count === 1 ? t('Write 1 change to the files') : t('Write {0} changes to the files', count);
    discardEditsEl.textContent = t('Discard typed values');
}
