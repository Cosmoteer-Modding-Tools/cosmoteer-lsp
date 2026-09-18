// The page's handles on its own document, plus the host bridge it posts through. They are filled in
// by initDom, which only the webview half of the page calls, so importing this module reaches for
// neither the document nor the host.

/** @type {HTMLElement} */
export let svg;
/** @type {HTMLElement} */
export let titleEl;
/** @type {HTMLElement} */
export let subtitleEl;
/** @type {HTMLElement} */
export let legendEl;
/** @type {HTMLElement} */
export let notesEl;
/** @type {HTMLInputElement} */
export let filterEl;
/** @type {HTMLElement} */
export let emptyEl;
/** @type {CosmoteerWebviewApi} */
export let vscode;

/** Acquires the host bridge and looks up the elements the page draws into. */
export function initDom() {
    vscode = acquireVsCodeApi();
    svg = document.getElementById('canvas');
    titleEl = document.getElementById('title');
    subtitleEl = document.getElementById('subtitle');
    legendEl = document.getElementById('legend');
    notesEl = document.getElementById('notes');
    filterEl = /** @type {HTMLInputElement} */ (document.getElementById('filter'));
    emptyEl = document.getElementById('empty');
}
