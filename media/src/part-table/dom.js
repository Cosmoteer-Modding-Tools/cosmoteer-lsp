// The elements the page draws into, and the bridge it talks to the host over. Nothing is looked up
// until initDom runs, so importing this module touches no document and the page's pure helpers can
// still be read under Node.

/** The host bridge, which VS Code provides natively and the JetBrains plugin shims. */
export let vscode;

/** The filter bar: the text search, the three narrowing dropdowns and the grouping picker. */
export let searchEl, categoryEl, componentEl, sourceEl, groupEl;

/** The tree at the left, and the button that folds it away. */
export let treeEl, toggleTreeEl;

/** The comparison row: the compared part, its suggestions, the two switches and the colour key. */
export let referenceEl, referenceListEl, percentEl, legendEl, perTileEl;

/** The buttons that write the typed values to the files and that drop them. */
export let applyEditsEl, discardEditsEl;

/** The table itself, with the status line, the notice and the spinner around it. */
export let statusEl, noticeEl, stageEl, emptyEl, loadingEl;

/** The column picker. */
export let columnsPanel, columnSearchEl, columnListEl;

/** The formula panel. */
export let formulaPanel, formulaNameEl, formulaTextEl, formulaErrorEl, formulaExamplesEl, formulaColumnsEl;

/** The saved views panel. */
export let viewsPanel, viewNameEl, viewListEl;

/**
 * The element an id names.
 *
 * @param {string} id the element's id.
 * @returns {HTMLElement} the element.
 */
export function byId(id) {
    return document.getElementById(id);
}

/**
 * Looks up the elements the page draws into and takes the bridge to the host. Called once, when the
 * page starts, so every module can read the handles by their plain names from then on.
 */
export function initDom() {
    vscode = acquireVsCodeApi();
    searchEl = byId('search');
    categoryEl = byId('category');
    componentEl = byId('component');
    sourceEl = byId('source');
    groupEl = byId('group');
    treeEl = byId('tree');
    toggleTreeEl = byId('toggle-tree');
    referenceEl = byId('reference');
    referenceListEl = byId('reference-options');
    percentEl = byId('percent');
    legendEl = byId('legend');
    perTileEl = byId('per-tile');
    applyEditsEl = byId('apply-edits');
    discardEditsEl = byId('discard-edits');
    statusEl = byId('status');
    noticeEl = byId('notice');
    stageEl = byId('stage');
    emptyEl = byId('empty');
    columnsPanel = byId('columns-panel');
    columnSearchEl = byId('column-search');
    columnListEl = byId('column-list');
    formulaPanel = byId('formula-panel');
    formulaNameEl = byId('formula-name');
    formulaTextEl = byId('formula-text');
    formulaErrorEl = byId('formula-error');
    formulaExamplesEl = byId('formula-examples');
    formulaColumnsEl = byId('formula-columns');
    loadingEl = byId('loading');
    viewsPanel = byId('views-panel');
    viewNameEl = byId('view-name');
    viewListEl = byId('view-list');
}
