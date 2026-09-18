// Formula columns: the panel they are written in, the columns a formula names, and the requests
// that send them to the server, which is what computes them.

import { t } from '../shared/strings.js';
import { EXAMPLES, IDENTITY, MAX_GLOB_COLUMNS } from './constants.js';
import {
    formulaColumnsEl,
    formulaErrorEl,
    formulaExamplesEl,
    formulaNameEl,
    formulaPanel,
    formulaTextEl,
    vscode,
} from './dom.js';
import { headerOf } from './headers.js';
import { currentFilter, orderedKeys, state, visibleRows } from './state.js';
import { setBusy } from './table-view.js';

/** @import {FormulaColumn} from './types.js' */

/**
 * The regular expression a wildcard column reference stands for, matching the way the server
 * matches it: `*` within one segment, `**` across segments.
 *
 * @param {string} glob the bracketed path with wildcards.
 * @returns {RegExp} the matcher.
 */
export function globMatcher(glob) {
    const source = glob
        .split('**')
        .map((piece) =>
            piece
                .split('*')
                .map((literal) => literal.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
                .join('[^/]*')
        )
        .join('.*');
    return new RegExp(`^${source}$`, 'i');
}

/**
 * The column paths a formula names, so the table can make sure it is showing them before the
 * server computes over them. A wildcard names every column it matches, a name that is another
 * formula's names no column.
 *
 * @param {string} formula the written formula.
 * @returns {string[]} the paths.
 */
export function pathsIn(formula) {
    const paths = [];
    const names = new Set(state.formulas.map((entry) => entry.name.toLowerCase()));
    const add = (path) => {
        if (path.includes('*')) {
            const matcher = globMatcher(path);
            state.table.columns
                .filter((column) => matcher.test(column.path))
                .slice(0, MAX_GLOB_COLUMNS)
                .forEach((column) => paths.push(column.path));
        } else if (!names.has(path.toLowerCase())) paths.push(path);
    };
    const bracketed = /\[([^\]]+)\]/g;
    let match = bracketed.exec(formula);
    while (match) {
        add(match[1].trim());
        match = bracketed.exec(formula);
    }
    for (const bare of formula.replace(/\[[^\]]*\]/g, ' ').match(/[A-Za-z_][A-Za-z0-9_]*/g) || []) {
        if (state.table.columns.some((column) => column.path === bare)) paths.push(bare);
    }
    return paths;
}

/**
 * The typed values in the shape the server's formulas read them: the numbers alone.
 *
 * @returns {object} the overrides by row key and column path.
 */
export function overrideNumbers() {
    const numbers = {};
    for (const [rowKey, own] of Object.entries(state.overrides)) {
        numbers[rowKey] = {};
        for (const [key, typed] of Object.entries(own)) numbers[rowKey][key] = typed.value;
    }
    return numbers;
}

/**
 * Asks the server for one formula column, with everything its formula may read: the other
 * formulas by name, the rows on screen for the column aggregates, the compared part and the
 * typed values.
 *
 * @param {FormulaColumn} formula the formula column.
 */
export function requestFormula(formula) {
    const others = {};
    for (const entry of state.formulas) if (entry.id !== formula.id) others[entry.name] = entry.formula;
    vscode.postMessage({
        type: 'formula',
        id: formula.id,
        formula: formula.formula,
        reference: state.reference,
        formulas: others,
        rows: visibleRows().map((row) => row.key),
        overrides: overrideNumbers(),
    });
}

/** Sends the pending formula to the server, adding the columns it reads to the table first. */
export function submitFormula() {
    const formula = (formulaTextEl.value || '').trim();
    if (!formula) return;
    const name = (formulaNameEl.value || '').trim() || formula;
    const missing = pathsIn(formula).filter(
        (path) => !state.shown.includes(path) && state.table.columns.some((column) => column.path === path)
    );
    const id = `formula:${state.nextFormulaId++}`;
    const entry = { id, name, formula, values: {} };
    state.formulas.push(entry);
    if (missing.length > 0) {
        state.shown = state.shown.concat(missing);
        state.picked = true;
        setBusy(true, t('Reading the picked columns…'));
        vscode.postMessage({
            type: 'columns',
            columns: state.shown,
            filter: currentFilter(),
            pendingFormula: id,
        });
    } else {
        requestFormula(entry);
    }
    formulaPanel.hidden = true;
    formulaErrorEl.hidden = true;
    formulaTextEl.value = '';
    formulaNameEl.value = '';
}

/**
 * Asks the server to recompute every formula column, which a new reference row, a typed value
 * or a change in which rows are on screen changes.
 */
export function recomputeFormulas() {
    for (const formula of state.formulas) requestFormula(formula);
}

/**
 * Writes a column reference in at the caret. A header is shortened for reading and a formula
 * names the whole path, so the two do not match up by eye and the path is offered rather than
 * left to be typed out.
 *
 * @param {string} path the column path to insert.
 */
export function insertColumn(path) {
    const reference = `[${path}]`;
    const text = formulaTextEl.value || '';
    const at = formulaTextEl.selectionStart === null ? text.length : formulaTextEl.selectionStart;
    const to = formulaTextEl.selectionEnd === null ? at : formulaTextEl.selectionEnd;
    formulaTextEl.value = text.slice(0, at) + reference + text.slice(to);
    formulaTextEl.focus();
    formulaTextEl.setSelectionRange(at + reference.length, at + reference.length);
}

/**
 * Lists the columns on screen and the other formulas as buttons that write themselves into the
 * formula.
 */
export function renderFormulaColumns() {
    formulaColumnsEl.textContent = '';
    const paths = orderedKeys().filter((key) => !IDENTITY.includes(key) && !key.startsWith('formula:'));
    const entries = paths.map((path) => {
        const header = headerOf(path);
        return { path, what: header.context ? `${header.context} › ${header.label}` : header.label };
    });
    for (const formula of state.formulas)
        entries.push({ path: formula.name, what: t('Formula: {0}', formula.formula) });
    for (const entry of entries) {
        const button = document.createElement('button');
        button.type = 'button';
        button.appendChild(document.createTextNode(`[${entry.path}]`));
        const what = document.createElement('span');
        what.className = 'what';
        what.textContent = entry.what;
        button.appendChild(what);
        button.addEventListener('click', () => insertColumn(entry.path));
        formulaColumnsEl.appendChild(button);
    }
    if (entries.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'hint';
        empty.textContent = t('No column is on screen to insert.');
        formulaColumnsEl.appendChild(empty);
    }
}

/** Lists the worked examples under the formula box, each of which writes itself into it. */
export function fillFormulaExamples() {
    for (const example of EXAMPLES) {
        const button = document.createElement('button');
        button.type = 'button';
        button.appendChild(document.createTextNode(example.formula));
        const what = document.createElement('span');
        what.className = 'what';
        what.textContent = t(example.what);
        button.appendChild(what);
        button.addEventListener('click', () => {
            formulaTextEl.value = example.formula;
            if (!formulaNameEl.value) formulaNameEl.value = t(example.what);
            formulaTextEl.focus();
        });
        formulaExamplesEl.appendChild(button);
    }
}
