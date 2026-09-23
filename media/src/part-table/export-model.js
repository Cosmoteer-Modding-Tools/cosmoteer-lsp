// The table in the shape the host builds a workbook out of. The numbers go over as numbers rather
// than as the text of a cell, so the workbook holds what the game computes rather than a rendering
// of it.

import { t } from '../shared/strings.js';
import { GROUPINGS, IDENTITY } from './constants.js';
import { searchEl } from './dom.js';
import { headersFor } from './headers.js';
import { currentFilter, levelLabel, numberOf, orderedKeys, overrideOf, state, textOf, visibleRows } from './state.js';

/**
 * The unit a column's numbers carry, read off the first row that has the column at all. Every
 * value of one column is the same member of a different part, so the unit is the column's.
 *
 * @param {string} key the column path.
 * @param {Array} rows the rows being exported.
 * @returns {string|undefined} the unit, absent for a column that carries none.
 */
export function unitOf(key, rows) {
    for (const row of rows) {
        const cell = row.cells[key];
        if (cell && cell.unit) return cell.unit;
    }
    return undefined;
}

/**
 * The table as it stands, in the shape the host builds a workbook out of: the columns with
 * everything that decides how they are written, the rows in the order and the grouping on
 * screen, and what the table was narrowed and compared by.
 *
 * The numbers go over as numbers rather than as the text of a cell, so the workbook holds what
 * the game computes rather than a rendering of it.
 *
 * @returns {object} the model.
 */
export function exportModel() {
    const keys = orderedKeys();
    const grouping = GROUPINGS[state.groupBy];
    const rows = visibleRows();
    // The screen paints the rows under their groups, so the sheet reads the same way down the page
    // rather than scattering a group over it. The rows arrive in the sort the reader set, and the
    // sort is stable, so ordering them by their group labels keeps that sort inside each group. A
    // group the reader folded away is still exported: the sheet is the whole of what was narrowed
    // to, and the totals and the live formula columns are written over all of it.
    if (grouping) {
        rows.sort((left, right) => {
            for (const level of grouping.levels) {
                const order = levelLabel(level, left).localeCompare(levelLabel(level, right));
                if (order !== 0) return order;
            }
            return 0;
        });
    }
    const headers = headersFor(keys.filter((key) => !IDENTITY.includes(key) && !key.startsWith('formula:')));
    const columns = keys.map((key) => {
        const shared = { key, width: state.widths[key], frozen: state.frozen.includes(key) };
        if (key === 'id') return { ...shared, label: t('Part'), numeric: false };
        if (key === 'source') return { ...shared, label: t('From'), numeric: false };
        const formula = state.formulas.find((entry) => entry.id === key);
        if (formula) return { ...shared, label: formula.name, numeric: true, formula: formula.formula };
        const header = headers.get(key);
        return {
            ...shared,
            path: key,
            label: header.label,
            context: header.context,
            numeric: rows.some((row) => numberOf(row, key) !== null),
            unit: unitOf(key, rows),
        };
    });
    const filters = [];
    const narrowed = currentFilter();
    if (narrowed.categories[0]) filters.push({ label: t('Category'), value: narrowed.categories[0] });
    if (narrowed.components[0]) filters.push({ label: t('Component'), value: narrowed.components[0] });
    if (narrowed.sources[0]) filters.push({ label: t('Mod'), value: narrowed.sources[0] });
    if (state.treeSelection) {
        const selected = state.treeSelection.group
            ? `${state.treeSelection.ship} › ${state.treeSelection.group}`
            : state.treeSelection.ship;
        filters.push({ label: t('Ship class'), value: selected });
    }
    const referenceRow = state.table.rows.find((row) => row.key === state.reference);
    return {
        columns,
        rows: rows.map((row) => ({
            id: row.id,
            file: row.file,
            uri: row.uri,
            groups: grouping ? grouping.levels.map((level) => levelLabel(level, row)) : undefined,
            cells: keys.map((key) => {
                if (IDENTITY.includes(key)) return textOf(row, key);
                const value = numberOf(row, key);
                return value === null ? textOf(row, key) || null : value;
            }),
            // The view paints a typed-over cell differently from one read out of a file, and the
            // workbook says which cells those are for the same reason: a reader of the file is
            // otherwise told a number the game never computed.
            typed: keys.map((key, index) => (overrideOf(row, key) ? index : -1)).filter((index) => index >= 0),
        })),
        groupHeaders: grouping ? grouping.levels.map((level) => t(level.header)) : undefined,
        mod: state.table.mod || '',
        total: state.table.total || state.table.rows.length,
        search: (searchEl.value || '').trim(),
        filters,
        referenceId: referenceRow ? referenceRow.id : undefined,
        perTile: state.perTile,
        asPercent: state.asPercent,
    };
}
