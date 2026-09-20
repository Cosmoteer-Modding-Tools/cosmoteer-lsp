// What the reader does to a drawing that is already there: the pan and zoom transform, fitting the
// whole drawing into the panel, cutting an over-long label down, opening the place a box stands for,
// and dimming what the filter text leaves out. Plus the small SVG element factory the page builds
// every drawn node with.

import { MAX_ZOOM, MIN_ZOOM, NS } from './constants.js';
import { filterEl, svg, vscode } from './dom.js';
import { state } from './state.js';

/**
 * Creates an SVG element with attributes set.
 *
 * @param name the element name.
 * @param attributes the attributes to set.
 * @returns the element.
 */
export function el(name, attributes) {
    const node = document.createElementNS(NS, name);
    for (const [key, value] of Object.entries(attributes || {})) {
        if (value !== undefined && value !== null) node.setAttribute(key, String(value));
    }
    return node;
}

/** Applies the current pan and zoom to the drawing group. */
export function applyView() {
    const group = document.getElementById('scene');
    if (group) group.setAttribute('transform', `translate(${state.view.x} ${state.view.y}) scale(${state.view.zoom})`);
}

/** Fits the whole drawing into the panel. */
export function fit() {
    state.untouched = true;
    const width = svg.clientWidth || 800;
    const height = svg.clientHeight || 600;
    const scale = Math.min(
        (width - 40) / Math.max(state.laid.width, 1),
        (height - 40) / Math.max(state.laid.height, 1),
        1.5
    );
    state.view.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, scale));
    state.view.x = (width - state.laid.width * state.view.zoom) / 2;
    state.view.y = 20;
    applyView();
}

/**
 * Cuts a text element down until it fits a width, ending it with an ellipsis.
 *
 * @param text the text element, already in the document so it can be measured.
 * @param width the width it has to fit into.
 */
export function truncate(text, width) {
    const full = text.textContent;
    if (text.getComputedTextLength() <= width) return;
    let cut = full.length;
    while (cut > 1 && text.getComputedTextLength() > width) {
        cut--;
        text.textContent = `${full.slice(0, cut)}…`;
    }
    // The whole text stays readable: the box's own tooltip carries the label and the detail in
    // full, and it is added after this runs.
}

/**
 * Asks the host to open a place a box stands for.
 *
 * @param place the file and line.
 */
export function open(place) {
    vscode.postMessage({
        type: 'openLocation',
        uri: place.uri,
        range: {
            start: { line: Math.max(0, place.line - 1), character: 0 },
            end: { line: Math.max(0, place.line - 1), character: 0 },
        },
    });
}

/** Dims every box the filter text does not match, and every arrow between two dimmed boxes. */
export function applyFilter() {
    const needle = (filterEl.value || '').trim().toLowerCase();
    const matched = new Set();
    for (const box of state.laid.boxes.values()) {
        const haystack = `${box.node.label} ${box.node.detail || ''}`.toLowerCase();
        if (!needle || haystack.includes(needle)) matched.add(box.node.id);
    }
    for (const group of svg.querySelectorAll('g.node')) {
        group.classList.toggle('dimmed', !matched.has(group.getAttribute('data-id')));
    }
    const items = svg.querySelectorAll('g.edge-item');
    state.diagram.edges.forEach((edge, index) => {
        const item = items[index];
        if (!item) return;
        item.classList.toggle('dimmed', !(matched.has(edge.from) || matched.has(edge.to)));
    });
}
