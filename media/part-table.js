// @ts-nocheck
// The part table webview: draws the row-and-column payload the server builds out of the project's
// parts. It knows nothing about Cosmoteer. Every value in it was resolved and computed on the
// server, so this page only sorts, filters, groups and compares what it is given.
//
// IDE-agnostic: VS Code provides acquireVsCodeApi natively, the JetBrains plugin shims it and
// replays host messages as MessageEvents after the page posts {type:'ready'}.
(function () {
    'use strict';

    // ---------------------------------------------------------------------------------------------
    // Pure header shortening, exported for Node unit tests (nothing above this block touches the DOM
    // or the host when imported).
    // ---------------------------------------------------------------------------------------------

    /**
     * A member path turned into something a header can be read at a glance: a name, and the context
     * above it.
     *
     * The path itself is a poor header. It is long, it repeats the same leading segments on every
     * component field, and its last segment is often the least telling part of it: the `0` of
     * `Size/0` and the `BaseValue` of a modifiable field say nothing on their own. So an index and a
     * base value fold into the field they belong to, the `Components` every component field starts
     * with is dropped, and what is left is the component or the group the field sits in. The game's
     * own stats block reads as `Stats`, since its index and its wrapper say nothing a reader needs.
     * A computed column is named by its name alone.
     *
     * @param {string} path the column path.
     * @returns {{context: string, label: string}} the two lines of the header.
     */
    function headerOf(path) {
        if (path.startsWith('@')) return { context: '', label: path.slice(1) };
        const segments = path.split('/');
        let label = segments[segments.length - 1];
        let above = segments.slice(0, -1);
        if (/^\d+$/.test(label) && above.length) label = `${above.pop()} ${label}`;
        else if (label.toLowerCase() === 'basevalue' && above.length) label = above.pop();
        // Every component field starts with the same segment, so it distinguishes nothing.
        if (above[0] === 'Components') above.shift();
        // The stats block is one wrapper around one list: `StatsByCategory/0/Stats` is the stats,
        // and only a second category needs its number to tell it from the first.
        if (above[0] === 'StatsByCategory' && /^\d+$/.test(above[1] || '') && above[2] === 'Stats') {
            above = [above[1] === '0' ? 'Stats' : `Stats ${above[1]}`].concat(above.slice(3));
        }
        const context = [];
        for (const segment of above) {
            if (/^\d+$/.test(segment) && context.length) context[context.length - 1] += ` ${segment}`;
            else context.push(segment);
        }
        return { context: context.join(' › '), label };
    }

    /**
     * The headers of the shown columns, keyed by path. Two different fields can shorten to the same
     * header, and a header that names two columns names neither, so those keep their whole path.
     *
     * @param {readonly string[]} keys the columns being drawn.
     * @returns {Map<string, {context: string, label: string}>} the header of each column path.
     */
    function headersFor(keys) {
        const headers = new Map();
        const seen = new Map();
        for (const key of keys) {
            const header = headerOf(key);
            const spelling = `${header.context}/${header.label}`;
            seen.set(spelling, (seen.get(spelling) ?? 0) + 1);
            headers.set(key, header);
        }
        for (const [key, header] of headers) {
            if (seen.get(`${header.context}/${header.label}`) > 1) headers.set(key, { context: '', label: key });
        }
        return headers;
    }

    /**
     * The number a value typed over a cell stands for, read the way the game reads a literal: a
     * percentage is a fraction, a degree count is radians, a plain number is itself.
     *
     * @param {string} text the typed text.
     * @returns {{value: number, text: string}|null} the number and the trimmed text, or null when
     *          the text is not a number.
     */
    function parseTyped(text) {
        const trimmed = String(text || '').trim();
        const match = /^(-?\d*\.?\d+(?:[eE][-+]?\d+)?)([%dr])?$/.exec(trimmed);
        if (!match) return null;
        const number = Number(match[1]);
        if (!isFinite(number)) return null;
        if (match[2] === '%') return { value: number / 100, text: trimmed };
        if (match[2] === 'd') return { value: (number * Math.PI) / 180, text: trimmed };
        return { value: number, text: trimmed };
    }

    if (typeof module !== 'undefined' && typeof acquireVsCodeApi === 'undefined') {
        module.exports = { headerOf, headersFor, parseTyped };
        return;
    }

    // ---------------------------------------------------------------------------------------------
    // Webview runtime.
    // ---------------------------------------------------------------------------------------------

    const vscode = acquireVsCodeApi();
    const STRINGS = window.cosmoteerStrings || {};

    /**
     * The localized text for a message, with `{0}` placeholders filled in.
     *
     * @param {string} message the English source string.
     * @param {...unknown} args the placeholder values.
     * @returns {string} the localized text.
     */
    function t(message, ...args) {
        const template = STRINGS[message] || message;
        if (!args.length) return template;
        return template.replace(/\{(\d+)\}/g, (match, index) =>
            args[index] === undefined ? match : String(args[index])
        );
    }

    /** How far from the reference a value has to be before its cell takes the stronger shade. */
    const FAR_FACTOR = 2;

    /** How close to the reference a value counts as the same. */
    const SAME_BAND = 0.005;

    /** The identity columns every table opens with, ahead of the picked ones. */
    const IDENTITY = ['id', 'source'];

    /** The column the per-tile switch divides by, which the server computes for every row. */
    const TILES = '@Tiles';

    /** How many columns a wildcard in a formula may pull onto the table. */
    const MAX_GLOB_COLUMNS = 40;

    /** The whole payload, as the server last sent it. */
    let table = {
        rows: [],
        columns: [],
        categories: [],
        componentTypes: [],
        sources: [],
        editorGroups: [],
        suggested: [],
    };

    /** The column paths shown, in display order. */
    let shown = [];

    /**
     * Whether the reader has picked the columns themselves. Until they have, narrowing the table
     * re-picks the columns for the parts that are left, which is the point of narrowing: the fields
     * a shield generator has are not the fields a thruster has. Once they have picked, their pick
     * stands whatever the filter does.
     */
    let picked = false;

    /** The formula columns, each with its own computed values. */
    let formulas = [];

    /** The sort: a column path, an identity field, or a formula id, with its direction. */
    let sort = { key: 'id', descending: false };

    /** The column keys pinned against the left edge, in the order they were pinned. */
    let frozen = ['id'];

    /**
     * The order the reader dragged the columns into. Merged against the columns that actually exist
     * on every draw, so a column that comes and goes with a filter keeps its place while it is gone.
     */
    let order = [];

    /** The widths the reader dragged, in pixels, by column key. A column with none sizes itself. */
    let widths = {};

    /** Set while a resize is in flight, so the click that ends it does not also sort the column. */
    let resizing = false;

    /** The row key the comparison shades against, empty when the table compares nothing. */
    let reference = '';

    /** Whether numeric cells show the percentage of the reference rather than the value. */
    let asPercent = false;

    /** Whether every number is divided by the cells the part covers. */
    let perTile = false;

    /** What the rows are grouped under: the build menu group, a category, the mod, or nothing. */
    let groupBy = '';

    /** The group names folded away, so a long table can be read one kind at a time. */
    let collapsed = new Set();

    /**
     * The values the reader typed over cells and has not written to the files yet, by row key and
     * then by column path. Each holds the number the formulas compute with and the text as typed,
     * which is what gets written. The rest of the table keeps reading the files, so a typed value
     * is a question asked of the table rather than a change made to the mod.
     */
    let overrides = {};

    /** The cell being typed into, so a refresh waits until the typing is done. */
    let editing = null;

    /** True when the server said the files changed while a cell was being typed into. */
    let refreshPending = false;

    /** The saved views, by name, as the host last sent them. */
    let views = {};

    /** The saved view being looked at, empty when the table is not on one. */
    let activeView = '';

    /** Whether the working state the host kept has been put back yet. It is restored once. */
    let restored = false;

    /** Hands out the formula column ids, restarted when a saved view brings its own formulas. */
    let nextFormulaId = 0;

    /**
     * The formula examples the panel offers, so a column can be written by picking one apart rather
     * than by guessing the syntax. The paths are the ones the game's own parts carry.
     */
    const EXAMPLES = [
        { what: 'Health for every cell the part takes up', formula: '[MaxHealth] / [@Tiles]' },
        { what: 'Credits paid for every point of health', formula: '[@Cost] / [MaxHealth]' },
        { what: 'Damage per second for every credit', formula: '[@DPS] / [@Cost]' },
        {
            what: 'Damage per shot times fire rate, times the barrels where a part counts them',
            formula: '[StatsByCategory/0/Stats/DamagePerShot] * [StatsByCategory/0/Stats/ROF] * coalesce([Barrels], 1)',
        },
        {
            what: 'Steel and coils added up, for the parts that take only one of them too',
            formula: 'coalesce([Resources/steel], 0) + coalesce([Resources/coil], 0)',
        },
        { what: 'Every resource the part takes, added up', formula: 'sum([Resources/*])' },
        { what: 'Percent of the compared part', formula: '[MaxHealth] / ref([MaxHealth]) * 100' },
        { what: 'Percent of the average of the parts on screen', formula: '[MaxHealth] / colavg([MaxHealth]) * 100' },
        { what: 'Rank by health, 1 for the highest', formula: 'rank([MaxHealth])' },
        { what: '1 for the parts above ten thousand health, 0 for the rest', formula: 'if([MaxHealth] > 10000, 1, 0)' },
        { what: 'The larger of two columns', formula: 'max([Size/0], [Size/1])' },
        { what: 'Rounded to one decimal', formula: 'round([MaxHealth] / [Size/0], 1)' },
    ];

    /**
     * The ship classes that register a part, as one label. A part two classes share, the way the
     * asteroid deposits sit in both the asteroid and the megaroid class, reads as both.
     *
     * @param {object} row the row.
     * @returns {string} the label, empty when no ship class registers the part.
     */
    const shipOf = (row) => (row.ships && row.ships.length ? row.ships.join(' & ') : '');

    /**
     * The build menu groups a part sits in, as one label.
     *
     * @param {object} row the row.
     * @returns {string} the label, empty when the part names no group.
     */
    const editorGroupsOf = (row) => (row.editorGroups && row.editorGroups.length ? row.editorGroups.join(' & ') : '');

    /** The levels a grouping can be built from, each reading one field of a row. */
    const LEVELS = {
        ship: { header: 'Ship class', none: 'No ship class', of: shipOf },
        editorGroup: { header: 'Group', none: 'No group', of: editorGroupsOf },
        category: { header: 'Category', none: 'No category', of: (row) => (row.categories && row.categories[0]) || '' },
        source: { header: 'Mod', none: 'No mod', of: (row) => row.source || '' },
    };

    /**
     * The ways the rows can be grouped. The first is the way the game files parts: the ship class
     * a part belongs to, and inside it the build menu group.
     */
    const GROUPINGS = {
        shipEditorGroup: { label: 'By ship class, then build menu group', levels: [LEVELS.ship, LEVELS.editorGroup] },
        ship: { label: 'By ship class', levels: [LEVELS.ship] },
        editorGroup: { label: 'By build menu group', levels: [LEVELS.editorGroup] },
        category: { label: 'By category', levels: [LEVELS.category] },
        source: { label: 'By mod', levels: [LEVELS.source] },
    };

    /** The part of the tree the reader clicked, narrowing the rows to it. Null for every part. */
    let treeSelection = null;

    /** Whether the tree at the left is folded away. */
    let treeHidden = false;

    const element = (id) => document.getElementById(id);
    const searchEl = element('search');
    const categoryEl = element('category');
    const componentEl = element('component');
    const sourceEl = element('source');
    const groupEl = element('group');
    const treeEl = element('tree');
    const toggleTreeEl = element('toggle-tree');
    const referenceEl = element('reference');
    const referenceListEl = element('reference-options');
    const percentEl = element('percent');
    const legendEl = element('legend');
    const perTileEl = element('per-tile');
    const applyEditsEl = element('apply-edits');
    const discardEditsEl = element('discard-edits');
    const statusEl = element('status');
    const noticeEl = element('notice');
    const stageEl = element('stage');
    const emptyEl = element('empty');
    const columnsPanel = element('columns-panel');
    const columnSearchEl = element('column-search');
    const columnListEl = element('column-list');
    const formulaPanel = element('formula-panel');
    const formulaNameEl = element('formula-name');
    const formulaTextEl = element('formula-text');
    const formulaErrorEl = element('formula-error');
    const formulaExamplesEl = element('formula-examples');
    const formulaColumnsEl = element('formula-columns');
    const loadingEl = element('loading');
    const viewsPanel = element('views-panel');
    const viewNameEl = element('view-name');
    const viewListEl = element('view-list');

    // ---------------------------------------------------------------------------------------------
    // Reading the payload
    // ---------------------------------------------------------------------------------------------

    /**
     * The column record for a path, so a header can show what the path was called.
     *
     * @param {string} path the column path.
     * @returns {object} the column, or a stand-in when the payload no longer carries it.
     */
    function columnOf(path) {
        return table.columns.find((column) => column.path === path) || { path, label: path, group: '', numeric: 0 };
    }

    /**
     * The value typed over a cell, when there is one.
     *
     * @param {object} row the row.
     * @param {string} key the column path.
     * @returns {{value: number|null, text: string}|undefined} the typed value.
     */
    function overrideOf(row, key) {
        const own = overrides[row.key];
        return own ? own[key] : undefined;
    }

    /**
     * The number a row holds for a key, as the file has it or as the reader typed it, before the
     * per-tile division. This is what the server's formulas see.
     *
     * @param {object} row the row.
     * @param {string} key a column path or a formula id.
     * @returns {number|null} the number, or null when the row has none.
     */
    function rawNumberOf(row, key) {
        const formula = formulas.find((entry) => entry.id === key);
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
     * @param {object} row the row.
     * @param {string} key a column path or a formula id.
     * @returns {number|null} the number, or null when the row has none.
     */
    function numberOf(row, key) {
        const value = rawNumberOf(row, key);
        if (value === null || !perTile || key === TILES) return value;
        const tiles = row.cells[TILES] ? row.cells[TILES].value : null;
        return tiles ? value / tiles : null;
    }

    /**
     * The text a row shows for a key.
     *
     * @param {object} row the row.
     * @param {string} key a column path, a formula id or an identity field.
     * @returns {string} the display text.
     */
    function textOf(row, key) {
        if (key === 'id') return row.id;
        if (key === 'source') return row.source;
        const formula = formulas.find((entry) => entry.id === key);
        if (formula) {
            const value = numberOf(row, key);
            return value === null ? '' : formatNumber(value);
        }
        const typed = overrideOf(row, key);
        if (perTile && key !== TILES) {
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
    function formatNumber(value) {
        if (!isFinite(value)) return '';
        if (Number.isInteger(value)) return String(value);
        return String(Number(value.toFixed(4)));
    }

    // ---------------------------------------------------------------------------------------------
    // Filtering, sorting and grouping
    // ---------------------------------------------------------------------------------------------

    /**
     * The rows the filters leave, in the sorted order.
     *
     * @returns {Array} the rows to draw.
     */
    function visibleRows() {
        const needle = (searchEl.value || '').trim().toLowerCase();
        // The category, component and mod axes are applied on the server, which is what lets the
        // column picker offer only the fields the narrowed parts really carry. The text search stays
        // here: it changes per keystroke and narrows nothing the columns depend on.
        const rows = table.rows.filter(
            (row) =>
                (!needle || `${row.id} ${row.name} ${row.file}`.toLowerCase().includes(needle)) && inTreeSelection(row)
        );
        const key = sort.key;
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
            return sort.descending ? -order : order;
        });
        return rows;
    }

    /**
     * The label a row carries at one level of a grouping, with the fallback for a row that has none.
     *
     * @param {object} level the level.
     * @param {object} row the row.
     * @returns {string} the label.
     */
    function levelLabel(level, row) {
        return level.of(row) || t(level.none);
    }

    /**
     * Whether a row is inside the part of the tree the reader clicked.
     *
     * @param {object} row the row.
     * @returns {boolean} true when nothing is selected or the row belongs to the selection.
     */
    function inTreeSelection(row) {
        if (!treeSelection) return true;
        if (levelLabel(LEVELS.ship, row) !== treeSelection.ship) return false;
        return !treeSelection.group || levelLabel(LEVELS.editorGroup, row) === treeSelection.group;
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
    function groupedRows(rows) {
        const grouping = GROUPINGS[groupBy];
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
                if (!last && !collapsed.has(key)) nest(inner, depth + 1, key);
            }
        };
        nest(rows, 0, '');
        return out;
    }

    /** Redraws the tree at the left: every ship class, and under it every build menu group, with counts. */
    function renderTree() {
        treeEl.hidden = treeHidden;
        toggleTreeEl.textContent = treeHidden ? t('Show tree') : t('Hide tree');
        treeEl.textContent = '';
        if (treeHidden) return;
        const ships = new Map();
        for (const row of table.rows) {
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
        item(t('All parts'), table.rows.length, 0, !treeSelection, () => {
            treeSelection = null;
        });
        for (const ship of [...ships.keys()].sort((left, right) => left.localeCompare(right))) {
            const entry = ships.get(ship);
            item(ship, entry.count, 1, !!treeSelection && treeSelection.ship === ship && !treeSelection.group, () => {
                treeSelection = { ship };
            });
            for (const group of [...entry.groups.keys()].sort((left, right) => left.localeCompare(right))) {
                item(
                    group,
                    entry.groups.get(group),
                    2,
                    !!treeSelection && treeSelection.ship === ship && treeSelection.group === group,
                    () => {
                        treeSelection = { ship, group };
                    }
                );
            }
        }
    }

    /**
     * The class that shades a cell against the reference row.
     *
     * @param {number|null} value the row's number.
     * @param {number|null} base the reference row's number in the same column.
     * @returns {string} the class name, empty when nothing can be compared.
     */
    function comparisonClass(value, base) {
        if (value === null || base === null || base === 0) return '';
        const ratio = value / base;
        if (Math.abs(ratio - 1) <= SAME_BAND) return 'same';
        if (ratio > FAR_FACTOR) return 'far-above';
        if (ratio > 1) return 'above';
        if (ratio < 1 / FAR_FACTOR) return 'far-below';
        return 'below';
    }

    // ---------------------------------------------------------------------------------------------
    // Drawing
    // ---------------------------------------------------------------------------------------------

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
    function setBusy(busy, message, quiet) {
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
    function breakable(label) {
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
    function pinStickyColumns(tableEl) {
        const heads = [...tableEl.querySelectorAll('thead th.sticky')];
        let offset = 0;
        const offsets = heads.map((head) => {
            const at = offset;
            offset += head.getBoundingClientRect().width;
            return at;
        });
        for (const row of tableEl.querySelectorAll('tr')) {
            const cells = row.querySelectorAll('.sticky');
            cells.forEach((cell, index) => {
                cell.style.left = `${offsets[index] || 0}px`;
                cell.classList.toggle('last-sticky', index === cells.length - 1);
            });
        }
    }

    /**
     * Whether a column's cells can be typed over: a value read from a file, which a computed column
     * and a formula column are not.
     *
     * @param {string} key the column key.
     * @returns {boolean} true when the cells take typed values.
     */
    function editable(key) {
        return !IDENTITY.includes(key) && !key.startsWith('formula:') && !key.startsWith('@');
    }

    /**
     * Turns a cell into a box the reader types a value into. Enter keeps the value as a typed-over
     * one, Escape leaves the cell as it was, and an empty box takes a typed value back.
     *
     * @param {HTMLElement} cell the cell.
     * @param {object} row the row.
     * @param {string} key the column path.
     */
    function startEditing(cell, row, key) {
        if (editing) return;
        const typed = overrideOf(row, key);
        const source = row.cells[key];
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'cell-input';
        input.value = typed ? typed.text : source ? source.text : '';
        cell.textContent = '';
        cell.appendChild(input);
        editing = { cell, row, key };
        const finish = (commit) => {
            if (!editing) return;
            editing = null;
            if (commit) {
                const text = input.value.trim();
                if (!text || (source && text === source.text)) clearOverride(row, key);
                else {
                    const parsed = parseTyped(text);
                    if (!parsed) {
                        input.classList.add('invalid');
                        input.title = t('Write a number, with the % d or r suffix the value already has.');
                        editing = { cell, row, key };
                        return;
                    }
                    if (!overrides[row.key]) overrides[row.key] = {};
                    overrides[row.key][key] = parsed;
                }
                recomputeFormulas();
            }
            render();
            if (refreshPending) {
                refreshPending = false;
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
     * @param {object} row the row.
     * @param {string} key the column path.
     */
    function clearOverride(row, key) {
        const own = overrides[row.key];
        if (!own) return;
        delete own[key];
        if (Object.keys(own).length === 0) delete overrides[row.key];
    }

    /**
     * How many cells hold a typed value.
     *
     * @returns {number} the count.
     */
    function overrideCount() {
        let count = 0;
        for (const own of Object.values(overrides)) count += Object.keys(own).length;
        return count;
    }

    /**
     * Drops the typed values the files now hold, after the host wrote them and the table was read
     * again. A typed value the file still disagrees with stays typed.
     */
    function reconcileOverrides() {
        for (const row of table.rows) {
            const own = overrides[row.key];
            if (!own) continue;
            for (const [key, typed] of Object.entries(own)) {
                const cell = row.cells[key];
                if (cell && (cell.text === typed.text || cell.value === typed.value)) delete own[key];
            }
            if (Object.keys(own).length === 0) delete overrides[row.key];
        }
    }

    /** Shows or hides the buttons that write and discard the typed values, with their count. */
    function updateEditButtons() {
        const count = overrideCount();
        applyEditsEl.hidden = count === 0;
        discardEditsEl.hidden = count === 0;
        applyEditsEl.textContent =
            count === 1 ? t('Write 1 change to the files') : t('Write {0} changes to the files', count);
        discardEditsEl.textContent = t('Discard typed values');
    }

    /**
     * The header rows of the summary: the average, the least and the most of every numeric column
     * over the rows on screen, which is what a part is balanced against.
     *
     * @param {Array} rows the visible rows.
     * @param {string[]} keys the columns in display order.
     * @returns {HTMLElement} the footer.
     */
    function summaryFooter(rows, keys) {
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
                if (frozen.includes(key)) cell.classList.add('sticky');
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
    function render() {
        if (editing) return;
        const rows = visibleRows();
        const referenceRow = table.rows.find((row) => row.key === reference);
        stageEl.textContent = '';
        emptyEl.hidden = rows.length > 0;
        updateEditButtons();
        if (rows.length === 0) {
            emptyEl.textContent = table.rows.length === 0 ? t('No parts found.') : t('No part matches the filter.');
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
            const formula = formulas.find((entry) => entry.id === key);
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
            if (frozen.includes(key)) cell.classList.add('sticky');
            if (sort.key === key) {
                cell.classList.add('sorted');
                if (sort.descending) cell.classList.add('descending');
            }
            cell.addEventListener('click', () => {
                if (resizing) return;
                sort = sort.key === key ? { key, descending: !sort.descending } : { key, descending: false };
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
            if (collapsed.has(group.key)) continue;
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
    function groupHeader(group, span) {
        const headRow = document.createElement('tr');
        headRow.className = group.depth > 0 ? 'group-row inner' : 'group-row';
        const cell = document.createElement('td');
        cell.colSpan = span;
        cell.style.paddingLeft = `${8 + group.depth * 18}px`;
        const folded = collapsed.has(group.key);
        cell.textContent = `${folded ? '▸' : '▾'} ${group.name}  ·  ${t('{0} parts', group.count)}`;
        cell.title = folded ? t('Show these parts') : t('Hide these parts');
        cell.addEventListener('click', () => {
            if (folded) collapsed.delete(group.key);
            else collapsed.add(group.key);
            render();
        });
        headRow.appendChild(cell);
        return headRow;
    }

    /**
     * One part's row.
     *
     * @param {object} row the row.
     * @param {string[]} keys the columns in display order.
     * @param {object|undefined} referenceRow the row being compared against.
     * @returns {HTMLElement} the row.
     */
    function bodyRowOf(row, keys, referenceRow) {
        const bodyRow = document.createElement('tr');
        if (row.key === reference) bodyRow.classList.add('reference');
        for (const key of keys) {
            const cell = document.createElement('td');
            cell.dataset.key = key;
            if (frozen.includes(key)) cell.classList.add('sticky');
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
            const formula = formulas.find((entry) => entry.id === key);
            const value = numberOf(row, key);
            const written = textOf(row, key);
            if (formula) cell.classList.add('formula');
            if (key.startsWith('@')) cell.classList.add('derived');
            if (value !== null) cell.classList.add('numeric');
            if (!written && value === null) cell.classList.add('missing');

            const base = referenceRow ? numberOf(referenceRow, key) : null;
            if (asPercent && value !== null && base !== null && base !== 0) {
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
     * The columns in display order: the frozen ones first, so they can sit against the left edge,
     * then the rest in the order the reader dragged them into.
     *
     * The stored order is merged against the columns that really exist rather than replacing them.
     * A filter takes columns off the table and puts them back, and a column coming back belongs
     * where the reader left it rather than at the end.
     *
     * @returns {string[]} the keys to draw.
     */
    function orderedKeys() {
        const present = shown.filter((path) => table.columns.some((column) => column.path === path));
        const all = [...IDENTITY, ...present, ...formulas.map((formula) => formula.id)];
        // A column the filter has taken off the table keeps its place in the remembered order rather
        // than being dropped from it, so it comes back where the reader put it rather than at the end.
        const placed = new Set(order);
        for (const key of all) if (!placed.has(key)) order.push(key);
        const known = new Set(all);
        const pinned = frozen.filter((key) => known.has(key));
        return [...pinned, ...order.filter((key) => known.has(key) && !pinned.includes(key))];
    }

    /**
     * Puts a dragged column in front of another one.
     *
     * @param {string} dragged the column being moved.
     * @param {string} before the column it is dropped on.
     */
    function moveColumn(dragged, before) {
        if (dragged === before) return;
        const without = order.filter((key) => key !== dragged);
        const at = without.indexOf(before);
        if (at === -1) return;
        without.splice(at, 0, dragged);
        order = without;
        render();
    }

    /**
     * The grip at a header's right edge that sets the column's width.
     *
     * @param {string} key the column's key.
     * @param {HTMLElement} cell the header cell it belongs to.
     * @returns {HTMLElement} the grip.
     */
    function resizeHandle(key, cell) {
        const grip = document.createElement('span');
        grip.className = 'resizer';
        grip.title = t('Drag to set the width, double-click to let the column size itself');
        grip.addEventListener('pointerdown', (event) => {
            event.preventDefault();
            event.stopPropagation();
            resizing = true;
            // A header is draggable so it can be reordered, which would otherwise take over the grip.
            cell.draggable = false;
            const startX = event.clientX;
            const startWidth = cell.getBoundingClientRect().width;
            grip.setPointerCapture(event.pointerId);
            const onMove = (move) => {
                widths[key] = Math.max(40, Math.round(startWidth + move.clientX - startX));
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
                    resizing = false;
                }, 0);
            };
            grip.addEventListener('pointermove', onMove);
            grip.addEventListener('pointerup', onUp);
        });
        grip.addEventListener('dblclick', (event) => {
            event.stopPropagation();
            delete widths[key];
            render();
        });
        return grip;
    }

    /** Writes the dragged widths onto the cells, without redrawing the table. */
    function applyWidths() {
        for (const cell of stageEl.querySelectorAll('[data-key]')) {
            const width = widths[cell.getAttribute('data-key')];
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
    function makeDraggable(cell, key) {
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
    function pinButton(key) {
        const pin = document.createElement('span');
        const isFrozen = frozen.includes(key);
        pin.className = isFrozen ? 'pin frozen' : 'pin';
        pin.textContent = isFrozen ? '◀' : '▷';
        pin.title = isFrozen ? t('Unfreeze this column') : t('Freeze this column at the left edge');
        pin.addEventListener('click', (event) => {
            // The header itself sorts, so the toggle has to keep its click to itself.
            event.stopPropagation();
            frozen = isFrozen ? frozen.filter((entry) => entry !== key) : frozen.concat(key);
            render();
        });
        return pin;
    }

    /**
     * Writes the line under the toolbar that says what the table is showing.
     *
     * @param {number} count how many rows survived the filters.
     */
    function updateStatus(count) {
        const showing = orderedKeys().length - IDENTITY.length;
        const parts = [
            t('{0} of {1} parts', count, table.total || table.rows.length),
            t('{0} of {1} columns shown', showing, table.columns.length),
        ];
        if (perTile) parts.push(t('Every number is per tile.'));
        parts.push(
            table.mod ? t('The game and {0}', table.mod) : t('The game alone. Open a file of your mod to add it.')
        );
        if (table.truncated) parts.push(t('The project holds more parts than the table reads.'));
        statusEl.textContent = parts.join('  ·  ');
    }

    /**
     * Shows a line the host or the server had to say, such as why a value could not be written.
     *
     * @param {string} text the message, empty to clear it.
     */
    function showNotice(text) {
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
    function open(uri, line, character) {
        vscode.postMessage({
            type: 'openLocation',
            uri,
            range: { start: { line, character }, end: { line, character } },
        });
    }

    // ---------------------------------------------------------------------------------------------
    // The filter bar
    // ---------------------------------------------------------------------------------------------

    /**
     * Fills a dropdown with the values a filter axis offers, keeping the current pick where it still
     * exists.
     *
     * @param {HTMLSelectElement} select the dropdown.
     * @param {readonly string[]} values the values to offer.
     * @param {string} anyLabel the label of the entry that filters nothing.
     */
    function fillFilter(select, values, anyLabel) {
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
    function fillGrouping() {
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
        groupEl.value = groupBy;
    }

    /**
     * Fills the compared-part list with the rows the table currently holds. It is a text box with a
     * suggestion list rather than a dropdown, so a part is found by typing part of its name instead
     * of by scrolling a hundred and sixty entries.
     */
    function fillReference() {
        const previous = table.rows.find((row) => row.key === reference);
        referenceListEl.textContent = '';
        for (const row of table.rows) {
            const option = document.createElement('option');
            option.value = row.id;
            referenceListEl.appendChild(option);
        }
        // A part that the filter has taken off the table cannot be compared against any more.
        reference = previous ? previous.key : '';
        referenceEl.value = previous ? previous.id : '';
    }

    /**
     * Reads the compared part out of the text box, matching the id a reader typed or picked without
     * regard to case. Text that names no part compares nothing rather than guessing.
     */
    function readReference() {
        const typed = (referenceEl.value || '').trim().toLowerCase();
        const row = typed ? table.rows.find((entry) => entry.id.toLowerCase() === typed) : undefined;
        reference = row ? row.key : '';
    }

    // ---------------------------------------------------------------------------------------------
    // The column picker
    // ---------------------------------------------------------------------------------------------

    /** Redraws the column picker's list against its search box. */
    function renderColumnList() {
        const needle = (columnSearchEl.value || '').trim().toLowerCase();
        columnListEl.textContent = '';
        // Matched against the shortened name as well as the path, so a column can be searched for
        // the way its header spells it rather than the way the file nests it.
        const matching = table.columns.filter((column) => {
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
            check.checked = shown.includes(column.path);
            check.addEventListener('change', () => {
                if (check.checked) shown.push(column.path);
                else shown = shown.filter((path) => path !== column.path);
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

    // ---------------------------------------------------------------------------------------------
    // Formula columns
    // ---------------------------------------------------------------------------------------------

    /**
     * The regular expression a wildcard column reference stands for, matching the way the server
     * matches it: `*` within one segment, `**` across segments.
     *
     * @param {string} glob the bracketed path with wildcards.
     * @returns {RegExp} the matcher.
     */
    function globMatcher(glob) {
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
    function pathsIn(formula) {
        const paths = [];
        const names = new Set(formulas.map((entry) => entry.name.toLowerCase()));
        const add = (path) => {
            if (path.includes('*')) {
                const matcher = globMatcher(path);
                table.columns
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
            if (table.columns.some((column) => column.path === bare)) paths.push(bare);
        }
        return paths;
    }

    /**
     * The typed values in the shape the server's formulas read them: the numbers alone.
     *
     * @returns {object} the overrides by row key and column path.
     */
    function overrideNumbers() {
        const numbers = {};
        for (const [rowKey, own] of Object.entries(overrides)) {
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
     * @param {object} formula the formula column.
     */
    function requestFormula(formula) {
        const others = {};
        for (const entry of formulas) if (entry.id !== formula.id) others[entry.name] = entry.formula;
        vscode.postMessage({
            type: 'formula',
            id: formula.id,
            formula: formula.formula,
            reference,
            formulas: others,
            rows: visibleRows().map((row) => row.key),
            overrides: overrideNumbers(),
        });
    }

    /** Sends the pending formula to the server, adding the columns it reads to the table first. */
    function submitFormula() {
        const formula = (formulaTextEl.value || '').trim();
        if (!formula) return;
        const name = (formulaNameEl.value || '').trim() || formula;
        const missing = pathsIn(formula).filter(
            (path) => !shown.includes(path) && table.columns.some((column) => column.path === path)
        );
        const id = `formula:${nextFormulaId++}`;
        const entry = { id, name, formula, values: {} };
        formulas.push(entry);
        if (missing.length > 0) {
            shown = shown.concat(missing);
            picked = true;
            setBusy(true, t('Reading the picked columns…'));
            vscode.postMessage({
                type: 'columns',
                columns: shown,
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
    function recomputeFormulas() {
        for (const formula of formulas) requestFormula(formula);
    }

    // ---------------------------------------------------------------------------------------------
    // Saved views
    // ---------------------------------------------------------------------------------------------

    /**
     * Everything the reader set up, in the shape a saved view is stored as. The compared part is
     * kept by its id rather than by its row key, since a key is rebuilt with the table and an id is
     * what the files themselves write. The typed values ride along so closing the panel loses no
     * question half asked.
     *
     * @returns {object} the view.
     */
    function currentView() {
        return {
            search: searchEl.value || '',
            filter: currentFilter(),
            picked,
            shown: shown.slice(),
            formulas: formulas.map((formula) => ({ name: formula.name, formula: formula.formula })),
            frozen: frozen.slice(),
            order: order.slice(),
            widths: { ...widths },
            sort: { key: sort.key, descending: sort.descending },
            reference: referenceEl.value || '',
            asPercent,
            perTile,
            groupBy,
            collapsed: [...collapsed],
            overrides,
            treeSelection,
            treeHidden,
        };
    }

    /**
     * Puts a saved view back: its filters, columns, formulas, freezing, sort and compared part. The
     * table is then asked for again, since the filter and the columns are the server's half of it.
     *
     * @param {object} view the saved view.
     */
    function applyView(view) {
        searchEl.value = view.search || '';
        categoryEl.value = (view.filter && view.filter.categories && view.filter.categories[0]) || '';
        componentEl.value = (view.filter && view.filter.components && view.filter.components[0]) || '';
        sourceEl.value = (view.filter && view.filter.sources && view.filter.sources[0]) || '';
        picked = !!view.picked;
        shown = (view.shown || []).slice();
        // The ids are handed out in order, so a sort saved on a formula column still names the same
        // column after the view is put back.
        nextFormulaId = 0;
        formulas = (view.formulas || []).map((entry) => ({
            id: `formula:${nextFormulaId++}`,
            name: entry.name,
            formula: entry.formula,
            values: {},
        }));
        frozen = (view.frozen || ['id']).slice();
        order = (view.order || []).slice();
        widths = { ...(view.widths || {}) };
        sort = view.sort && view.sort.key ? { key: view.sort.key, descending: !!view.sort.descending } : sort;
        referenceEl.value = view.reference || '';
        asPercent = !!view.asPercent;
        percentEl.checked = asPercent;
        perTile = !!view.perTile;
        perTileEl.checked = perTile;
        groupBy = GROUPINGS[view.groupBy] ? view.groupBy : '';
        groupEl.value = groupBy;
        collapsed = new Set(view.collapsed || []);
        treeSelection = view.treeSelection && view.treeSelection.ship ? view.treeSelection : null;
        treeHidden = !!view.treeHidden;
        overrides = view.overrides && typeof view.overrides === 'object' ? view.overrides : {};
        requestTable(t('Putting the view back…'));
    }

    /**
     * Keeps the working state on the host, so closing the panel loses nothing. Everything the reader
     * set up is written back after every change, named or not, and put back the next time the table
     * is opened. A saved view is then a way of keeping several of these to switch between rather
     * than the only thing that survives the panel.
     */
    function persistState() {
        if (!restored) return;
        clearTimeout(persistState.timer);
        persistState.timer = setTimeout(
            () => vscode.postMessage({ type: 'saveState', view: currentView(), activeView }),
            250
        );
    }

    /** Redraws the list of saved views. */
    function renderViewList() {
        viewListEl.textContent = '';
        const names = Object.keys(views).sort((left, right) => left.localeCompare(right));
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
            open.className = name === activeView ? 'secondary path active' : 'secondary path';
            open.textContent = name;
            open.addEventListener('click', () => {
                viewsPanel.hidden = true;
                activeView = name;
                applyView(views[name]);
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

    // ---------------------------------------------------------------------------------------------
    // Export
    // ---------------------------------------------------------------------------------------------

    /**
     * The table as it stands, in the comma separated form a spreadsheet reads. The grouping is a
     * column of its own rather than header rows, so the sheet can sort and filter by it.
     *
     * @returns {string} the document text.
     */
    function asCsv() {
        const keys = orderedKeys();
        const grouping = GROUPINGS[groupBy];
        const header = keys.map((key) => {
            if (key === 'id') return t('Part');
            if (key === 'source') return t('From');
            const formula = formulas.find((entry) => entry.id === key);
            return formula ? formula.name : key;
        });
        if (grouping) header.unshift(...grouping.levels.map((level) => t(level.header)));
        const quote = (text) => `"${String(text).replace(/"/g, '""')}"`;
        const lines = [header.map(quote).join(',')];
        for (const row of visibleRows()) {
            const cells = keys.map((key) => {
                const value = IDENTITY.includes(key) ? null : numberOf(row, key);
                // A number goes in unquoted so the spreadsheet reads it as one.
                return value === null ? quote(textOf(row, key)) : String(value);
            });
            if (grouping) cells.unshift(...grouping.levels.map((level) => quote(levelLabel(level, row))));
            lines.push(cells.join(','));
        }
        return lines.join('\n');
    }

    // ---------------------------------------------------------------------------------------------
    // Wiring
    // ---------------------------------------------------------------------------------------------

    searchEl.placeholder = t('Filter parts');
    columnSearchEl.placeholder = t('Search columns');
    formulaNameEl.placeholder = t('Column name');
    formulaTextEl.placeholder = t('[MaxHealth] / [@Tiles]');
    fillGrouping();
    setBusy(true, t('Reading the parts…'));

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

    /**
     * Enables the percentage switch only while a part is being compared against, since a percentage
     * of nothing is nothing, and shows the key to the shading beside it for the same span. The key
     * is there because the colours say only where a value stands against the compared part, and
     * without it a blue column of health reads as a verdict.
     */
    function updatePercentSwitch() {
        percentEl.disabled = !reference;
        if (!reference && percentEl.checked) {
            percentEl.checked = false;
            asPercent = false;
        }
        percentEl.parentElement.title = reference
            ? t('Every number is shown as its percentage of the compared part, so 200% is twice as much.')
            : t('Pick a part to compare against first.');
        legendEl.hidden = !reference;
        legendEl.title = t(
            'Blue is below the compared part, grey within half a percent of it, red above it. The deeper shade is past twice or under half. The colour says where the number stands, not whether that is better.'
        );
    }

    /**
     * The filter as the dropdowns stand, sent to the server so the columns it answers with are the
     * ones the narrowed parts really carry.
     *
     * @returns {object} the filter, with an empty axis for each dropdown left at its any entry.
     */
    function currentFilter() {
        return {
            categories: categoryEl.value ? [categoryEl.value] : [],
            components: componentEl.value ? [componentEl.value] : [],
            sources: sourceEl.value ? [sourceEl.value] : [],
        };
    }

    /**
     * Asks the host to build the table again.
     *
     * @param {string} message what the page says while it waits.
     * @param {boolean} [refresh] whether to read the parts from disk again.
     * @param {boolean} [quiet] whether to leave the table on screen as it is while waiting.
     */
    function requestTable(message, refresh, quiet) {
        setBusy(true, message, quiet);
        // The columns already here are named, so the answer can leave them out while they stand:
        // they are the larger part of a table by far and change only with the parts or the filter.
        vscode.postMessage({
            type: 'columns',
            columns: picked ? shown : undefined,
            filter: currentFilter(),
            refresh: !!refresh,
            columnsVersion: table.columnsVersion || undefined,
            quiet: !!quiet,
        });
    }

    const narrow = () => requestTable(t('Narrowing to the parts you picked…'));

    /** Recomputes the formulas after the rows on screen change, once the typing has paused. */
    function recomputeAfterSearch() {
        clearTimeout(recomputeAfterSearch.timer);
        recomputeAfterSearch.timer = setTimeout(recomputeFormulas, 300);
    }

    searchEl.addEventListener('input', () => {
        render();
        recomputeAfterSearch();
    });
    categoryEl.addEventListener('change', narrow);
    componentEl.addEventListener('change', narrow);
    sourceEl.addEventListener('change', narrow);
    groupEl.addEventListener('change', () => {
        groupBy = GROUPINGS[groupEl.value] ? groupEl.value : '';
        render();
    });
    toggleTreeEl.addEventListener('click', () => {
        treeHidden = !treeHidden;
        renderTree();
        persistState();
    });
    percentEl.addEventListener('change', () => {
        asPercent = percentEl.checked;
        render();
    });
    perTileEl.addEventListener('change', () => {
        perTile = perTileEl.checked;
        render();
    });
    referenceEl.addEventListener('change', () => {
        const before = reference;
        readReference();
        if (reference === before) return;
        updatePercentSwitch();
        recomputeFormulas();
        render();
    });

    applyEditsEl.addEventListener('click', () => {
        const edits = [];
        for (const [rowKey, own] of Object.entries(overrides)) {
            for (const [column, typed] of Object.entries(own)) edits.push({ row: rowKey, column, text: typed.text });
        }
        if (edits.length === 0) return;
        showNotice('');
        vscode.postMessage({ type: 'applyEdits', edits });
    });
    discardEditsEl.addEventListener('click', () => {
        overrides = {};
        showNotice('');
        recomputeFormulas();
        render();
    });

    element('pick-columns').addEventListener('click', () => {
        columnsPanel.hidden = false;
        renderColumnList();
        columnSearchEl.focus();
    });
    columnSearchEl.addEventListener('input', renderColumnList);
    element('columns-apply').addEventListener('click', () => {
        columnsPanel.hidden = true;
        picked = true;
        requestTable(t('Reading the picked columns…'));
    });
    element('columns-close').addEventListener('click', () => {
        columnsPanel.hidden = true;
        shown = shown.filter((path) => table.columns.some((column) => column.path === path));
        render();
    });

    /**
     * Writes a column reference in at the caret. A header is shortened for reading and a formula
     * names the whole path, so the two do not match up by eye and the path is offered rather than
     * left to be typed out.
     *
     * @param {string} path the column path to insert.
     */
    function insertColumn(path) {
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
    function renderFormulaColumns() {
        formulaColumnsEl.textContent = '';
        const paths = orderedKeys().filter((key) => !IDENTITY.includes(key) && !key.startsWith('formula:'));
        const entries = paths.map((path) => {
            const header = headerOf(path);
            return { path, what: header.context ? `${header.context} › ${header.label}` : header.label };
        });
        for (const formula of formulas) entries.push({ path: formula.name, what: t('Formula: {0}', formula.formula) });
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

    element('add-formula').addEventListener('click', () => {
        formulaPanel.hidden = false;
        renderFormulaColumns();
        formulaNameEl.focus();
    });
    element('formula-apply').addEventListener('click', submitFormula);
    element('formula-close').addEventListener('click', () => {
        formulaPanel.hidden = true;
        formulaErrorEl.hidden = true;
    });
    element('clear-formulas').addEventListener('click', () => {
        formulas = [];
        if (sort.key.startsWith('formula:')) sort = { key: 'id', descending: false };
        render();
    });

    element('refresh').addEventListener('click', () => requestTable(t('Reading the parts…'), true));

    element('pick-views').addEventListener('click', () => {
        viewsPanel.hidden = false;
        // Prefilled with the view being looked at, so saving writes the changes back to it rather
        // than asking for the name again.
        viewNameEl.value = activeView;
        renderViewList();
        viewNameEl.focus();
    });
    element('views-close').addEventListener('click', () => {
        viewsPanel.hidden = true;
    });
    element('view-save').addEventListener('click', () => {
        const name = (viewNameEl.value || '').trim();
        if (!name) return;
        activeView = name;
        vscode.postMessage({ type: 'saveView', name, view: currentView() });
        persistState();
    });
    element('copy-csv').addEventListener('click', () => vscode.postMessage({ type: 'copyCsv', text: asCsv() }));

    window.addEventListener('message', (event) => {
        const message = event.data;
        if (!message) return;
        if (message.type === 'views') {
            views = message.views || {};
            // The working state is put back once, on the first answer, so a panel opened again picks
            // up exactly where it was left rather than at the default table.
            if (!restored) {
                restored = true;
                activeView = message.activeView || '';
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
            if (editing) {
                refreshPending = true;
                return;
            }
            requestTable(t('Following your edit…'), false, true);
            return;
        }
        if (message.type === 'table') {
            // An answer without columns is one for the version already here, which stays.
            const kept = table.columns;
            table = message.table;
            if (!table.columns) table.columns = kept;
            setBusy(false);
            shown = message.columns && message.columns.length ? message.columns.slice() : table.suggested.slice();
            fillFilter(categoryEl, table.categories, t('Every category'));
            fillFilter(componentEl, table.componentTypes, t('Every component'));
            fillFilter(sourceEl, table.sources, t('Everywhere'));
            fillReference();
            updatePercentSwitch();
            reconcileOverrides();
            renderTree();
            if (message.pendingFormula) {
                const formula = formulas.find((entry) => entry.id === message.pendingFormula);
                if (formula) requestFormula(formula);
            }
            recomputeFormulas();
            render();
            return;
        }
        if (message.type === 'formulaResult') {
            const formula = formulas.find((entry) => entry.id === message.id);
            if (!formula) return;
            if (message.error) {
                formulas = formulas.filter((entry) => entry.id !== message.id);
                formulaPanel.hidden = false;
                formulaErrorEl.hidden = false;
                formulaErrorEl.textContent = message.error;
            } else {
                formula.values = message.values || {};
            }
            render();
            return;
        }
        if (message.type === 'editsApplied') {
            // A value the host wrote is the file's now, so it stops being a typed one. The table
            // reads itself again on the change notice that follows the write.
            const lines = [];
            for (const result of message.results || []) {
                if (result.status === 'ok') {
                    const row = table.rows.find((entry) => entry.key === result.row);
                    if (row) clearOverride(row, result.column);
                    if (result.note) lines.push(result.note);
                } else if (result.message) lines.push(result.message);
            }
            showNotice(lines.join('  ·  '));
            render();
            return;
        }
        if (message.type === 'notice') {
            showNotice(message.text || '');
        }
    });

    vscode.postMessage({ type: 'ready' });
    vscode.postMessage({ type: 'listViews' });
})();
