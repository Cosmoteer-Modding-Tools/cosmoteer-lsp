// The page's handles on its host and on its own markup, plus the two element helpers the sidebar is
// built out of.
//
// The handles are filled in by `initDom`, which the entry calls in the browser. Nothing is looked up
// while this module is evaluated, because the bundle is also loaded under Node by the unit tests
// that read the page's pure helpers, and a lookup at module scope would fail there.

/** The host bridge the page posts its messages through. */
export let vscode;

/** The canvas the grid is drawn on, and its 2D context. */
export let canvas;
export let ctx;

/** The status line under the canvas. */
export let statusEl;

/** The sidebar the layer list and the panels are built into. */
export let sidebar;

/** Acquires the host bridge and looks up the page's elements, once, before anything draws. */
export function initDom() {
    vscode = acquireVsCodeApi();
    canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('grid'));
    ctx = canvas.getContext('2d');
    statusEl = document.getElementById('status');
    sidebar = document.getElementById('sidebar');
}

/**
 * Creates an element with a class and text set.
 *
 * @param tag the element name.
 * @param className the class attribute, absent for none.
 * @param text the text content, absent to leave the element empty.
 * @returns the element.
 */
export function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

/**
 * Creates a sidebar button.
 *
 * @param label the button's text.
 * @param title the tooltip, absent for none.
 * @param onClick what the click does.
 * @returns the button.
 */
export function button(label, title, onClick) {
    const node = element('button', 'ctrl', label);
    if (title) node.title = title;
    node.addEventListener('click', onClick);
    return node;
}

/**
 * Writes the status line under the canvas.
 *
 * @param text the line, empty to clear it.
 */
export function setStatus(text) {
    statusEl.textContent = text;
}

/**
 * Reads a theme color out of the page's own CSS variables.
 *
 * @param name the custom property name.
 * @param fallback the color to use where the host sets none.
 * @returns the color.
 */
export function themeColor(name, fallback) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
}
