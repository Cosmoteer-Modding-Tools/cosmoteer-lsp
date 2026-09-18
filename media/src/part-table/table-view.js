// Drawing: the table itself, the tree beside it, the widths and the freezing the reader dragged,
// and the lines under the toolbar that say what is on screen.

import { t } from '../shared/strings.js';
import { IDENTITY, LEVELS } from './constants.js';
import {
    emptyEl,
    legendEl,
    loadingEl,
    noticeEl,
    percentEl,
    stageEl,
    statusEl,
    toggleTreeEl,
    treeEl,
    vscode,
} from './dom.js';
import { editable, startEditing, updateEditButtons } from './editing.js';
import { recomputeFormulas } from './formulas.js';
import { headersFor } from './headers.js';
import {
    columnOf,
    comparisonClass,
    formatNumber,
    groupedRows,
    levelLabel,
    numberOf,
    orderedKeys,
    overrideOf,
    state,
    textOf,
    visibleRows,
} from './state.js';
import { persistState } from './views.js';

/** @import {PartRow} from './types.js' */

/**
 * Says whether the table is waiting on the server. The first build shows a spinner over an empty
 * page, a rebuild dims the table already on screen so the reader keeps their place, and a
 * rebuild that follows the reader's own typing says so in the status line alone, since dimming
 * the table on every keystroke would make it flicker.
 *
 * @param {boolean} busy whether a request is in flight.
 * @param {string} [message] what is being waited on.
 * @param {boolean} [quiet] whether to leave the table as it is while waiting.
 */
export function setBusy(busy, message, quiet) {
    if (quiet) {
        loadingEl.hidden = true;
        stageEl.classList.remove('busy');
        if (busy && message) statusEl.textContent = message;
        return;
    }
    if (busy && message) loadingEl.querySelector('.text').textContent = message;
    loadingEl.hidden = !busy;
    stageEl.classList.toggle('busy', busy && stageEl.childElementCount > 0);
}

/**
 * A label that wraps between its words rather than in the middle of one. Member names run
 * their words together, `ConstructionProgressMediaEffectsTimeout`, and a header cut at its
 * width would break them anywhere. A break opportunity ahead of each capital lets the header
 * wrap the way the name reads.
 *
 * @param {string} label the header text.
 * @returns {DocumentFragment} the text with break opportunities between its words.
 */
export function breakable(label) {
    const fragment = document.createDocumentFragment();
    const words = label.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/);
    words.forEach((word, index) => {
        if (index > 0) fragment.appendChild(document.createElement('wbr'));
        fragment.appendChild(document.createTextNode(word));
    });
    return fragment;
}

/**
 * Pins each identity column at the point the one before it ends. They are sticky columns sharing
 * one edge, and a shared `left` would stack them on top of each other.
 *
 * @param {HTMLTableElement} tableEl the drawn table.
 */
export function pinStickyColumns(tableEl) {
    const heads = [...tableEl.querySelectorAll('thead th.sticky')];
    let offset = 0;
    const offsets = heads.map((head) => {
        const at = offset;
        offset += head.getBoundingClientRect().width;
        return at;
    });
    for (const row of tableEl.querySelectorAll('tr')) {
        const cells = /** @type {NodeListOf<HTMLElement>} */ (row.querySelectorAll('.sticky'));
        cells.forEach((cell, index) => {
            cell.style.left = `${offsets[index] || 0}px`;
            cell.classList.toggle('last-sticky', index === cells.length - 1);
        });
    }
}

/**
 * The header rows of the summary: the average, the least and the most of every numeric column
 * over the rows on screen, which is what a part is balanced against.
 *
 * @param {Array} rows the visible rows.
 * @param {string[]} keys the columns in display order.
 * @returns {HTMLElement} the footer.
 */
export function summaryFooter(rows, keys) {
    const foot = document.createElement('tfoot');
    const stats = [
        { label: t('Average'), of: (values) => values.reduce((sum, value) => sum + value, 0) / values.length },
        { label: t('Least'), of: (values) => Math.min(...values) },
        { label: t('Most'), of: (values) => Math.max(...values) },
    ];
    for (const stat of stats) {
        const footRow = document.createElement('tr');
        footRow.className = 'summary';
        keys.forEach((key, index) => {
            const cell = document.createElement('td');
            cell.dataset.key = key;
            if (state.frozen.includes(key)) cell.classList.add('sticky');
            if (index === 0) cell.textContent = stat.label;
            else if (!IDENTITY.includes(key)) {
                const values = rows.map((row) => numberOf(row, key)).filter((value) => value !== null);
                if (values.length > 0) {
                    cell.textContent = formatNumber(stat.of(values));
                    cell.classList.add('numeric');
                }
            }
            footRow.appendChild(cell);
        });
        foot.appendChild(footRow);
    }
    return foot;
}

/**
 * Draws the whole table from the current payload, filters, grouping and sort. While a value is
 * being typed the table stays as it is, since redrawing would take the box away mid-word, and
 * the typing's end draws it.
 */
export function render() {
    if (state.editing) return;
    const rows = visibleRows();
    const referenceRow = state.table.rows.find((row) => row.key === state.reference);
    stageEl.textContent = '';
    emptyEl.hidden = rows.length > 0;
    updateEditButtons();
    if (rows.length === 0) {
        emptyEl.textContent = state.table.rows.length === 0 ? t('No parts found.') : t('No part matches the filter.');
        updateStatus(rows.length);
        return;
    }

    const keys = orderedKeys();
    const headers = headersFor(keys.filter((key) => !IDENTITY.includes(key) && !key.startsWith('formula:')));
    const tableEl = document.createElement('table');
    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const key of keys) {
        const cell = document.createElement('th');
        const text = document.createElement('div');
        text.className = 'head';
        const formula = state.formulas.find((entry) => entry.id === key);
        const column = columnOf(key);
        if (IDENTITY.includes(key)) {
            text.appendChild(document.createTextNode(key === 'id' ? t('Part') : t('From')));
        } else if (formula) {
            text.appendChild(document.createTextNode(formula.name));
            cell.title = formula.formula;
            cell.classList.add('formula');
        } else {
            const header = headers.get(key);
            // Every header carries its context line, empty or not, so the labels of a column
            // with a context and one without sit on the same baseline.
            const context = document.createElement('span');
            context.className = 'group';
            context.textContent = header.context || ' ';
            text.appendChild(context);
            text.appendChild(breakable(header.label));
            cell.title = column.description ? `${key}\n${column.description}` : key;
            if (column.derived) cell.classList.add('derived');
        }
        text.appendChild(pinButton(key));
        cell.appendChild(text);
        cell.dataset.key = key;
        if (state.frozen.includes(key)) cell.classList.add('sticky');
        if (state.sort.key === key) {
            cell.classList.add('sorted');
            if (state.sort.descending) cell.classList.add('descending');
        }
        cell.addEventListener('click', () => {
            if (state.resizing) return;
            state.sort =
                state.sort.key === key ? { key, descending: !state.sort.descending } : { key, descending: false };
            render();
        });
        makeDraggable(cell, key);
        cell.appendChild(resizeHandle(key, cell));
        headRow.appendChild(cell);
    }
    head.appendChild(headRow);
    tableEl.appendChild(head);

    const body = document.createElement('tbody');
    for (const group of groupedRows(rows)) {
        if (group.name) body.appendChild(groupHeader(group, keys.length));
        if (state.collapsed.has(group.key)) continue;
        for (const row of group.rows) body.appendChild(bodyRowOf(row, keys, referenceRow));
    }
    tableEl.appendChild(body);
    if (rows.length > 1) tableEl.appendChild(summaryFooter(rows, keys));
    stageEl.appendChild(tableEl);
    applyWidths();
    updateStatus(rows.length);
    persistState();
}

/**
 * The row that heads a group: its name, how many parts it holds, and the fold that hides them.
 * An inner group is set in from the outer one it belongs to.
 *
 * @param {{key: string, name: string, depth: number, count: number}} group the group.
 * @param {number} span how many columns the table has.
 * @returns {HTMLElement} the row.
 */
export function groupHeader(group, span) {
    const headRow = document.createElement('tr');
    headRow.className = group.depth > 0 ? 'group-row inner' : 'group-row';
    const cell = document.createElement('td');
    cell.colSpan = span;
    cell.style.paddingLeft = `${8 + group.depth * 18}px`;
    const folded = state.collapsed.has(group.key);
    cell.textContent = `${folded ? '▸' : '▾'} ${group.name}  ·  ${t('{0} parts', group.count)}`;
    cell.title = folded ? t('Show these parts') : t('Hide these parts');
    cell.addEventListener('click', () => {
        if (folded) state.collapsed.delete(group.key);
        else state.collapsed.add(group.key);
        render();
    });
    headRow.appendChild(cell);
    return headRow;
}

/**
 * One part's row.
 *
 * @param {PartRow} row the row.
 * @param {string[]} keys the columns in display order.
 * @param {PartRow|undefined} referenceRow the row being compared against.
 * @returns {HTMLElement} the row.
 */
export function bodyRowOf(row, keys, referenceRow) {
    const bodyRow = document.createElement('tr');
    if (row.key === state.reference) bodyRow.classList.add('reference');
    for (const key of keys) {
        const cell = document.createElement('td');
        cell.dataset.key = key;
        if (state.frozen.includes(key)) cell.classList.add('sticky');
        if (IDENTITY.includes(key)) {
            cell.classList.add('value');
            cell.textContent = textOf(row, key);
            if (key === 'id') {
                cell.title = row.file;
                cell.addEventListener('click', () => open(row.uri, row.line, row.character));
            }
            bodyRow.appendChild(cell);
            continue;
        }
        const formula = state.formulas.find((entry) => entry.id === key);
        const value = numberOf(row, key);
        const written = textOf(row, key);
        if (formula) cell.classList.add('formula');
        if (key.startsWith('@')) cell.classList.add('derived');
        if (value !== null) cell.classList.add('numeric');
        if (!written && value === null) cell.classList.add('missing');

        const base = referenceRow ? numberOf(referenceRow, key) : null;
        if (state.asPercent && value !== null && base !== null && base !== 0) {
            cell.textContent = `${formatNumber((value / base) * 100)}%`;
        } else {
            cell.textContent = written;
        }
        if (referenceRow) {
            const shade = comparisonClass(value, base);
            if (shade) cell.classList.add(shade);
        }

        const source = row.cells[key];
        const typed = overrideOf(row, key);
        if (typed) {
            cell.classList.add('changed');
            cell.title = source
                ? t('Typed over {0}. Write the changes to put it in the file.', source.text)
                : t('Typed over. Write the changes to put it in the file.');
        }
        if (source || typed) {
            if (source && source.inherited) cell.classList.add('inherited');
            cell.classList.add('value');
            if (!typed && source) {
                cell.title = source.inherited
                    ? t('Inherited. Click to open the declaration, double-click to try a value.')
                    : t('Click to open the declaration, double-click to try a value.');
            }
            // A double-click is two clicks, and the first of them must not open the file.
            let pendingOpen;
            if (source) {
                cell.addEventListener('click', () => {
                    clearTimeout(pendingOpen);
                    pendingOpen = setTimeout(() => open(source.uri, source.line, source.character), 250);
                });
            }
            if (editable(key)) {
                cell.addEventListener('dblclick', (event) => {
                    event.preventDefault();
                    clearTimeout(pendingOpen);
                    startEditing(cell, row, key);
                });
            }
        }
        bodyRow.appendChild(cell);
    }
    return bodyRow;
}

/**
 * Puts a dragged column in front of another one.
 *
 * @param {string} dragged the column being moved.
 * @param {string} before the column it is dropped on.
 */
export function moveColumn(dragged, before) {
    if (dragged === before) return;
    const without = state.order.filter((key) => key !== dragged);
    const at = without.indexOf(before);
    if (at === -1) return;
    without.splice(at, 0, dragged);
    state.order = without;
    render();
}

/**
 * The grip at a header's right edge that sets the column's width.
 *
 * @param {string} key the column's key.
 * @param {HTMLElement} cell the header cell it belongs to.
 * @returns {HTMLElement} the grip.
 */
export function resizeHandle(key, cell) {
    const grip = document.createElement('span');
    grip.className = 'resizer';
    grip.title = t('Drag to set the width, double-click to let the column size itself');
    grip.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        state.resizing = true;
        // A header is draggable so it can be reordered, which would otherwise take over the grip.
        cell.draggable = false;
        const startX = event.clientX;
        const startWidth = cell.getBoundingClientRect().width;
        grip.setPointerCapture(event.pointerId);
        const onMove = (move) => {
            state.widths[key] = Math.max(40, Math.round(startWidth + move.clientX - startX));
            applyWidths();
        };
        const onUp = () => {
            grip.removeEventListener('pointermove', onMove);
            grip.removeEventListener('pointerup', onUp);
            cell.draggable = true;
            // A width drag never redraws the table, so it has to keep the state itself.
            persistState();
            // The click that ends the drag lands on the header, which sorts. Let it pass first.
            setTimeout(() => {
                state.resizing = false;
            }, 0);
        };
        grip.addEventListener('pointermove', onMove);
        grip.addEventListener('pointerup', onUp);
    });
    grip.addEventListener('dblclick', (event) => {
        event.stopPropagation();
        delete state.widths[key];
        render();
    });
    return grip;
}

/** Writes the dragged widths onto the cells, without redrawing the table. */
export function applyWidths() {
    for (const cell of /** @type {NodeListOf<HTMLElement>} */ (stageEl.querySelectorAll('[data-key]'))) {
        const width = state.widths[cell.getAttribute('data-key')];
        cell.classList.toggle('sized', width !== undefined);
        cell.style.width = width === undefined ? '' : `${width}px`;
        cell.style.maxWidth = width === undefined ? '' : `${width}px`;
    }
    const tableEl = stageEl.querySelector('table');
    if (tableEl) pinStickyColumns(tableEl);
}

/**
 * Makes a header the handle for dragging its column somewhere else.
 *
 * @param {HTMLElement} cell the header cell.
 * @param {string} key the column's key.
 */
export function makeDraggable(cell, key) {
    cell.draggable = true;
    cell.addEventListener('dragstart', (event) => {
        event.dataTransfer.setData('text/plain', key);
        event.dataTransfer.effectAllowed = 'move';
        cell.classList.add('dragging');
    });
    cell.addEventListener('dragend', () => cell.classList.remove('dragging'));
    cell.addEventListener('dragover', (event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        cell.classList.add('drop-target');
    });
    cell.addEventListener('dragleave', () => cell.classList.remove('drop-target'));
    cell.addEventListener('drop', (event) => {
        event.preventDefault();
        cell.classList.remove('drop-target');
        moveColumn(event.dataTransfer.getData('text/plain'), key);
    });
}

/**
 * The freeze toggle a header carries. Freezing pins the column against the left edge so it stays
 * readable while the values scroll past it.
 *
 * @param {string} key the column's key.
 * @returns {HTMLElement} the button.
 */
export function pinButton(key) {
    const pin = document.createElement('span');
    const isFrozen = state.frozen.includes(key);
    pin.className = isFrozen ? 'pin frozen' : 'pin';
    pin.textContent = isFrozen ? '◀' : '▷';
    pin.title = isFrozen ? t('Unfreeze this column') : t('Freeze this column at the left edge');
    pin.addEventListener('click', (event) => {
        // The header itself sorts, so the toggle has to keep its click to itself.
        event.stopPropagation();
        state.frozen = isFrozen ? state.frozen.filter((entry) => entry !== key) : state.frozen.concat(key);
        render();
    });
    return pin;
}

/** Redraws the tree at the left: every ship class, and under it every build menu group, with counts. */
export function renderTree() {
    treeEl.hidden = state.treeHidden;
    toggleTreeEl.textContent = state.treeHidden ? t('Show tree') : t('Hide tree');
    treeEl.textContent = '';
    if (state.treeHidden) return;
    const ships = new Map();
    for (const row of state.table.rows) {
        const ship = levelLabel(LEVELS.ship, row);
        const group = levelLabel(LEVELS.editorGroup, row);
        if (!ships.has(ship)) ships.set(ship, { count: 0, groups: new Map() });
        const entry = ships.get(ship);
        entry.count++;
        entry.groups.set(group, (entry.groups.get(group) || 0) + 1);
    }
    const item = (label, count, depth, selected, onClick) => {
        const node = document.createElement('div');
        node.className = selected ? 'tree-item selected' : 'tree-item';
        node.style.paddingLeft = `${6 + depth * 14}px`;
        const text = document.createElement('span');
        text.textContent = label;
        const badge = document.createElement('span');
        badge.className = 'count';
        badge.textContent = String(count);
        node.appendChild(text);
        node.appendChild(badge);
        node.addEventListener('click', () => {
            onClick();
            renderTree();
            recomputeFormulas();
            render();
        });
        treeEl.appendChild(node);
    };
    item(t('All parts'), state.table.rows.length, 0, !state.treeSelection, () => {
        state.treeSelection = null;
    });
    for (const ship of [...ships.keys()].sort((left, right) => left.localeCompare(right))) {
        const entry = ships.get(ship);
        item(
            ship,
            entry.count,
            1,
            !!state.treeSelection && state.treeSelection.ship === ship && !state.treeSelection.group,
            () => {
                state.treeSelection = { ship };
            }
        );
        for (const group of [...entry.groups.keys()].sort((left, right) => left.localeCompare(right))) {
            item(
                group,
                entry.groups.get(group),
                2,
                !!state.treeSelection && state.treeSelection.ship === ship && state.treeSelection.group === group,
                () => {
                    state.treeSelection = { ship, group };
                }
            );
        }
    }
}

/**
 * Enables the percentage switch only while a part is being compared against, since a percentage
 * of nothing is nothing, and shows the key to the shading beside it for the same span. The key
 * is there because the colours say only where a value stands against the compared part, and
 * without it a blue column of health reads as a verdict.
 */
export function updatePercentSwitch() {
    percentEl.disabled = !state.reference;
    if (!state.reference && percentEl.checked) {
        percentEl.checked = false;
        state.asPercent = false;
    }
    percentEl.parentElement.title = state.reference
        ? t('Every number is shown as its percentage of the compared part, so 200% is twice as much.')
        : t('Pick a part to compare against first.');
    legendEl.hidden = !state.reference;
    legendEl.title = t(
        'Blue is below the compared part, grey within half a percent of it, red above it. The deeper shade is past twice or under half. The colour says where the number stands, not whether that is better.'
    );
}

/**
 * Writes the line under the toolbar that says what the table is showing.
 *
 * @param {number} count how many rows survived the filters.
 */
export function updateStatus(count) {
    const showing = orderedKeys().length - IDENTITY.length;
    const parts = [
        t('{0} of {1} parts', count, state.table.total || state.table.rows.length),
        t('{0} of {1} columns shown', showing, state.table.columns.length),
    ];
    if (state.perTile) parts.push(t('Every number is per tile.'));
    parts.push(
        state.table.mod
            ? t('The game and {0}', state.table.mod)
            : t('The game alone. Open a file of your mod to add it.')
    );
    if (state.table.truncated) parts.push(t('The project holds more parts than the table reads.'));
    statusEl.textContent = parts.join('  ·  ');
}

/**
 * Shows a line the host or the server had to say, such as why a value could not be written.
 *
 * @param {string} text the message, empty to clear it.
 */
export function showNotice(text) {
    noticeEl.textContent = text || '';
    noticeEl.hidden = !text;
}

/**
 * Asks the host to open a declaration.
 *
 * @param {string} uri the file.
 * @param {number} line the line.
 * @param {number} character the column.
 */
export function open(uri, line, character) {
    vscode.postMessage({
        type: 'openLocation',
        uri,
        range: { start: { line, character }, end: { line, character } },
    });
}
