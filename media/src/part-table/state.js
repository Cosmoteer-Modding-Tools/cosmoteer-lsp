// The page's mutable state, and everything read straight off it: the numbers and the text a cell
// shows, the rows a filter leaves, the groups they fall into and the shade a cell takes against the
// compared part. One object holds the state, so the module that writes a value and the module that
// reads it still see the same one.

import { t } from '../shared/strings.js';
import { FAR_FACTOR, GROUPINGS, IDENTITY, LEVELS, SAME_BAND, TILES } from './constants.js';
import { categoryEl, componentEl, searchEl, sourceEl } from './dom.js';

/** @import {FormulaColumn, GroupLevel, PartColumn, PartRow, PartTable} from './types.js' */

/** Everything the page holds on to between draws. */
export const state = {
    /**
     * The whole payload, as the server last sent it.
     *
     * @type {PartTable}
     */
    table: {
        rows: [],
        columns: [],
        categories: [],
        componentTypes: [],
        sources: [],
        editorGroups: [],
        suggested: [],
    },

    /** The column paths shown, in display order. */
    shown: [],

    /**
     * Whether the reader has picked the columns themselves. Until they have, narrowing the table
     * re-picks the columns for the parts that are left, which is the point of narrowing: the fields
     * a shield generator has are not the fields a thruster has. Once they have picked, their pick
     * stands whatever the filter does.
     */
    picked: false,

    /**
     * The formula columns, each with its own computed values.
     *
     * @type {FormulaColumn[]}
     */
    formulas: [],

    /** The sort: a column path, an identity field, or a formula id, with its direction. */
    sort: { key: 'id', descending: false },

    /** The column keys pinned against the left edge, in the order they were pinned. */
    frozen: ['id'],

    /**
     * The order the reader dragged the columns into. Merged against the columns that actually exist
     * on every draw, so a column that comes and goes with a filter keeps its place while it is gone.
     */
    order: [],

    /** The widths the reader dragged, in pixels, by column key. A column with none sizes itself. */
    widths: {},

    /** Set while a resize is in flight, so the click that ends it does not also sort the column. */
    resizing: false,

    /** The row key the comparison shades against, empty when the table compares nothing. */
    reference: '',

    /** Whether numeric cells show the percentage of the reference rather than the value. */
    asPercent: false,

    /** Whether every number is divided by the cells the part covers. */
    perTile: false,

    /** What the rows are grouped under: the build menu group, a category, the mod, or nothing. */
    groupBy: '',

    /** The group names folded away, so a long table can be read one kind at a time. */
    collapsed: new Set(),

    /**
     * The values the reader typed over cells and has not written to the files yet, by row key and
     * then by column path. Each holds the number the formulas compute with and the text as typed,
     * which is what gets written. The rest of the table keeps reading the files, so a typed value
     * is a question asked of the table rather than a change made to the mod.
     */
    overrides: {},

    /** The cell being typed into, so a refresh waits until the typing is done. */
    editing: null,

    /** True when the server said the files changed while a cell was being typed into. */
    refreshPending: false,

    /** The saved views, by name, as the host last sent them. */
    views: {},

    /** The saved view being looked at, empty when the table is not on one. */
    activeView: '',

    /** Whether the working state the host kept has been put back yet. It is restored once. */
    restored: false,

    /** Hands out the formula column ids, restarted when a saved view brings its own formulas. */
    nextFormulaId: 0,

    /** The part of the tree the reader clicked, narrowing the rows to it. Null for every part. */
    treeSelection: null,

    /** Whether the tree at the left is folded away. */
    treeHidden: false,

    /** The pending write of the working state, so the typing settles before it is kept. */
    persistStateTimer: undefined,

    /** The pending recompute of the formula columns, so the search settles before they run. */
    recomputeAfterSearchTimer: undefined,
};

/**
 * The column record for a path, so a header can show what the path was called.
 *
 * @param {string} path the column path.
 * @returns {Partial<PartColumn> & {path: string, label?: string, group?: string, numeric?: number}}
 *          the column, or a stand-in when the payload no longer carries it.
 */
export function columnOf(path) {
    return state.table.columns.find((column) => column.path === path) || { path, label: path, group: '', numeric: 0 };
}

/**
 * The value typed over a cell, when there is one.
 *
 * @param {PartRow} row the row.
 * @param {string} key the column path.
 * @returns {{value: number|null, text: string}|undefined} the typed value.
 */
export function overrideOf(row, key) {
    const own = state.overrides[row.key];
    return own ? own[key] : undefined;
}

/**
 * The number a row holds for a key, as the file has it or as the reader typed it, before the
 * per-tile division. This is what the server's formulas see.
 *
 * @param {PartRow} row the row.
 * @param {string} key a column path or a formula id.
 * @returns {number|null} the number, or null when the row has none.
 */
export function rawNumberOf(row, key) {
    const formula = state.formulas.find((entry) => entry.id === key);
    if (formula) {
        const value = formula.values[row.key];
        return value === undefined ? null : value;
    }
    const typed = overrideOf(row, key);
    if (typed) return typed.value;
    const cell = row.cells[key];
    return cell ? cell.value : null;
}

/**
 * The number a row shows for a sort, a comparison, a footer or the export: the raw number, or
 * that number over the cells the part covers when the per-tile switch is on.
 *
 * @param {PartRow} row the row.
 * @param {string} key a column path or a formula id.
 * @returns {number|null} the number, or null when the row has none.
 */
export function numberOf(row, key) {
    const value = rawNumberOf(row, key);
    if (value === null || !state.perTile || key === TILES) return value;
    const tiles = row.cells[TILES] ? row.cells[TILES].value : null;
    return tiles ? value / tiles : null;
}

/**
 * The text a row shows for a key.
 *
 * @param {PartRow} row the row.
 * @param {string} key a column path, a formula id or an identity field.
 * @returns {string} the display text.
 */
export function textOf(row, key) {
    if (key === 'id') return row.id;
    if (key === 'source') return row.source;
    const formula = state.formulas.find((entry) => entry.id === key);
    if (formula) {
        const value = numberOf(row, key);
        return value === null ? '' : formatNumber(value);
    }
    const typed = overrideOf(row, key);
    if (state.perTile && key !== TILES) {
        const value = numberOf(row, key);
        if (value !== null) return formatNumber(value);
    }
    if (typed) return typed.text;
    const cell = row.cells[key];
    return cell ? cell.text : '';
}

/**
 * A number rendered the way a table column reads best: no exponent, at most four decimals, and
 * no trailing zeroes.
 *
 * @param {number} value the number.
 * @returns {string} the display text.
 */
export function formatNumber(value) {
    if (!isFinite(value)) return '';
    if (Number.isInteger(value)) return String(value);
    return String(Number(value.toFixed(4)));
}

/**
 * The rows the filters leave, in the sorted order.
 *
 * @returns {Array} the rows to draw.
 */
export function visibleRows() {
    const needle = (searchEl.value || '').trim().toLowerCase();
    // The category, component and mod axes are applied on the server, which is what lets the
    // column picker offer only the fields the narrowed parts really carry. The text search stays
    // here: it changes per keystroke and narrows nothing the columns depend on.
    const rows = state.table.rows.filter(
        (row) => (!needle || `${row.id} ${row.name} ${row.file}`.toLowerCase().includes(needle)) && inTreeSelection(row)
    );
    const key = state.sort.key;
    const identity = IDENTITY.includes(key);
    rows.sort((left, right) => {
        let order;
        if (identity) {
            order = textOf(left, key).localeCompare(textOf(right, key));
        } else {
            const a = numberOf(left, key);
            const b = numberOf(right, key);
            // A row with no value in the sorted column sits at the end whichever way the sort
            // runs, so flipping the direction never buries the rows that do have one.
            if (a === null && b === null) order = left.id.localeCompare(right.id);
            else if (a === null) return 1;
            else if (b === null) return -1;
            else order = a - b;
        }
        return state.sort.descending ? -order : order;
    });
    return rows;
}

/**
 * The label a row carries at one level of a grouping, with the fallback for a row that has none.
 *
 * @param {GroupLevel} level the level.
 * @param {PartRow} row the row.
 * @returns {string} the label.
 */
export function levelLabel(level, row) {
    return level.of(row) || t(level.none);
}

/**
 * Whether a row is inside the part of the tree the reader clicked.
 *
 * @param {PartRow} row the row.
 * @returns {boolean} true when nothing is selected or the row belongs to the selection.
 */
export function inTreeSelection(row) {
    if (!state.treeSelection) return true;
    if (levelLabel(LEVELS.ship, row) !== state.treeSelection.ship) return false;
    return !state.treeSelection.group || levelLabel(LEVELS.editorGroup, row) === state.treeSelection.group;
}

/**
 * The visible rows in their groups, in group name order, each group keeping the sort inside it.
 * A grouping with two levels yields the outer group ahead of its inner ones, the inner ones
 * carrying the rows, and a folded outer group hides its inner ones with it. With no grouping
 * there is one unnamed group holding everything.
 *
 * @param {Array} rows the visible rows.
 * @returns {Array<{key: string, name: string, depth: number, count: number, rows: Array}>} the
 *          groups, in the order they are drawn.
 */
export function groupedRows(rows) {
    const grouping = GROUPINGS[state.groupBy];
    if (!grouping) return [{ key: '', name: '', depth: 0, count: rows.length, rows }];
    const out = [];
    const nest = (members, depth, prefix) => {
        const level = grouping.levels[depth];
        const groups = new Map();
        for (const row of members) {
            const name = levelLabel(level, row);
            if (!groups.has(name)) groups.set(name, []);
            groups.get(name).push(row);
        }
        const names = [...groups.keys()].sort((left, right) => left.localeCompare(right));
        for (const name of names) {
            const key = prefix ? `${prefix} / ${name}` : name;
            const inner = groups.get(name);
            const last = depth === grouping.levels.length - 1;
            out.push({ key, name, depth, count: inner.length, rows: last ? inner : [] });
            if (!last && !state.collapsed.has(key)) nest(inner, depth + 1, key);
        }
    };
    nest(rows, 0, '');
    return out;
}

/**
 * The class that shades a cell against the reference row.
 *
 * @param {number|null} value the row's number.
 * @param {number|null} base the reference row's number in the same column.
 * @returns {string} the class name, empty when nothing can be compared.
 */
export function comparisonClass(value, base) {
    if (value === null || base === null || base === 0) return '';
    const ratio = value / base;
    if (Math.abs(ratio - 1) <= SAME_BAND) return 'same';
    if (ratio > FAR_FACTOR) return 'far-above';
    if (ratio > 1) return 'above';
    if (ratio < 1 / FAR_FACTOR) return 'far-below';
    return 'below';
}

/**
 * The columns in display order: the frozen ones first, so they can sit against the left edge,
 * then the rest in the order the reader dragged them into.
 *
 * The stored order is merged against the columns that really exist rather than replacing them.
 * A filter takes columns off the table and puts them back, and a column coming back belongs
 * where the reader left it rather than at the end.
 *
 * @returns {string[]} the keys to draw.
 */
export function orderedKeys() {
    const present = state.shown.filter((path) => state.table.columns.some((column) => column.path === path));
    const all = [...IDENTITY, ...present, ...state.formulas.map((formula) => formula.id)];
    // A column the filter has taken off the table keeps its place in the remembered order rather
    // than being dropped from it, so it comes back where the reader put it rather than at the end.
    const placed = new Set(state.order);
    for (const key of all) if (!placed.has(key)) state.order.push(key);
    const known = new Set(all);
    const pinned = state.frozen.filter((key) => known.has(key));
    return [...pinned, ...state.order.filter((key) => known.has(key) && !pinned.includes(key))];
}

/**
 * The filter as the dropdowns stand, sent to the server so the columns it answers with are the
 * ones the narrowed parts really carry.
 *
 * @returns {object} the filter, with an empty axis for each dropdown left at its any entry.
 */
export function currentFilter() {
    return {
        categories: categoryEl.value ? [categoryEl.value] : [],
        components: componentEl.value ? [componentEl.value] : [],
        sources: sourceEl.value ? [sourceEl.value] : [],
    };
}
