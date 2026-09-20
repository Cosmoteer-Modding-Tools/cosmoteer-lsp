// The drawing pass: the heading, the series colours, the legend and the notes, the arrow heads, and
// the two layers the arrows and the boxes are drawn into.

import { BOX, SERIES_COLOURS } from './constants.js';
import { emptyEl, legendEl, notesEl, subtitleEl, svg, titleEl } from './dom.js';
import { edgeMidpoint, edgePath, layoutDiagram } from './layout.js';
import { state } from './state.js';
import { applyFilter, el, fit, open, truncate } from './view.js';

/**
 * Picks the colour of every series of flow arrows.
 *
 * Series are numbered in the order their first arrow was written, so the colour of a resource holds
 * still while the reader edits and the drawing redraws under them.
 *
 * @returns {Map<string, string>} the colour of each series name.
 */
function colourSeries() {
    const seriesColour = new Map();
    for (const edge of state.diagram.edges) {
        if (edge.kind !== 'flow' || !edge.series || seriesColour.has(edge.series)) continue;
        seriesColour.set(edge.series, SERIES_COLOURS[seriesColour.size % SERIES_COLOURS.length]);
    }
    return seriesColour;
}

/**
 * Fills the legend with the payload's own entries followed by one swatch per series colour, and the
 * notes list under it.
 *
 * @param seriesColour the colour of each series name.
 */
function renderLegendAndNotes(seriesColour) {
    legendEl.replaceChildren();
    for (const entry of state.diagram.legend || []) {
        const item = document.createElement('span');
        item.className = `legend-item kind-${entry.kind}`;
        item.textContent = entry.label;
        legendEl.appendChild(item);
    }
    for (const [series, colour] of seriesColour) {
        const item = document.createElement('span');
        item.className = 'legend-item series';
        item.style.color = colour;
        item.textContent = series;
        legendEl.appendChild(item);
    }
    notesEl.replaceChildren();
    for (const note of state.diagram.notes || []) {
        const line = document.createElement('li');
        line.textContent = note;
        notesEl.appendChild(line);
    }
    notesEl.hidden = !(state.diagram.notes && state.diagram.notes.length);
}

/**
 * Appends the arrow-head definitions to the drawing.
 *
 * A marker cannot take its colour from the line it ends, so there is one head per kind and one more
 * per series colour.
 *
 * @param seriesColour the colour of each series name.
 * @returns {(colour: string) => string} the head id a series colour points at.
 */
function appendArrowHeads(seriesColour) {
    const defs = el('defs');
    const head = (id, cls, fill) => {
        const marker = el('marker', {
            id,
            viewBox: '0 0 10 10',
            refX: 9,
            refY: 5,
            markerWidth: 7,
            markerHeight: 7,
            orient: 'auto-start-reverse',
        });
        const shape = el('path', { d: 'M 0 0 L 10 5 L 0 10 z', class: cls });
        if (fill) shape.style.fill = fill;
        marker.appendChild(shape);
        defs.appendChild(marker);
    };
    for (const kind of ['include', 'inherit', 'action', 'flow', 'warning']) head(`arrow-${kind}`, `arrow kind-${kind}`);
    const palette = [...new Set(seriesColour.values())];
    palette.forEach((colour, index) => head(`arrow-series-${index}`, 'arrow', colour));
    svg.appendChild(defs);
    return (colour) => `arrow-series-${palette.indexOf(colour)}`;
}

/**
 * Draws one arrow per payload edge, with its words sitting on the line.
 *
 * @param edgeLayer the group the arrows are drawn into.
 * @param seriesColour the colour of each series name.
 * @param seriesHead the head id a series colour points at.
 */
function drawEdges(edgeLayer, seriesColour, seriesHead) {
    for (const edge of state.diagram.edges) {
        const from = state.laid.boxes.get(edge.from);
        const to = state.laid.boxes.get(edge.to);
        // A missing end still gets an item, so the filter's edge-by-index match holds.
        const item = el('g', { class: `edge-item kind-${edge.kind}` });
        edgeLayer.appendChild(item);
        if (!from || !to) continue;
        const colour = edge.kind === 'flow' ? seriesColour.get(edge.series) : undefined;
        const path = el('path', {
            d: edgePath(from, to),
            class: `edge kind-${edge.kind}`,
            'marker-end': `url(#${colour ? seriesHead(colour) : `arrow-${edge.kind}`})`,
        });
        if (colour) path.style.stroke = colour;
        item.appendChild(path);
        if (!edge.label) continue;
        // The words sit on the line itself: the amount, the resource and how often for a flow,
        // the firing member for a chain. Hidden in a tooltip they left every arrow looking the
        // same, and the reader hovering each one to tell a heat line from a battery line.
        const mid = edgeMidpoint(from, to);
        const words = el('text', { x: mid.x, y: mid.y, class: 'edge-label' });
        words.textContent = edge.label;
        item.appendChild(words);
        truncate(words, BOX.gapX - 10);
        const tooltip = el('title');
        tooltip.textContent = edge.label;
        item.appendChild(tooltip);
    }
}

/**
 * Draws one box per laid-out node, with its label, its detail line and its tooltip, clickable when
 * the node stands for a place in a file.
 *
 * @param nodeLayer the group the boxes are drawn into.
 */
function drawNodes(nodeLayer) {
    for (const box of state.laid.boxes.values()) {
        const group = el('g', {
            class: `node kind-${box.node.kind}`,
            transform: `translate(${box.x} ${box.y})`,
            'data-id': box.node.id,
            tabindex: box.node.place ? 0 : undefined,
            role: box.node.place ? 'button' : undefined,
        });
        group.appendChild(el('rect', { width: box.width, height: box.height, rx: 6, class: 'box' }));
        const label = el('text', { x: 10, y: 20, class: 'label' });
        label.textContent = box.node.label;
        group.appendChild(label);
        if (box.node.detail) {
            const detail = el('text', { x: 10, y: 36, class: 'detail' });
            detail.textContent = box.node.detail;
            group.appendChild(detail);
        }
        // Measured rather than counted: the box is a fixed width and a name long enough to leave
        // it would otherwise be drawn straight through its neighbour.
        nodeLayer.appendChild(group);
        for (const text of [label, box.node.detail ? group.querySelector('.detail') : null]) {
            if (text) truncate(text, box.width - 20);
        }
        const tooltip = el('title');
        tooltip.textContent = box.node.detail ? `${box.node.label}\n${box.node.detail}` : box.node.label;
        group.appendChild(tooltip);
        if (box.node.place) {
            group.classList.add('clickable');
            group.addEventListener('click', () => open(box.node.place));
            group.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') open(box.node.place);
            });
        }
    }
}

/** Draws the whole payload. */
export function render() {
    titleEl.textContent = state.diagram.title || '';
    subtitleEl.textContent = state.diagram.subtitle || '';
    subtitleEl.hidden = !state.diagram.subtitle;
    const seriesColour = colourSeries();
    renderLegendAndNotes(seriesColour);

    emptyEl.hidden = state.diagram.nodes.length > 0;
    svg.replaceChildren();
    if (!state.diagram.nodes.length) return;

    state.laid = layoutDiagram(state.diagram.nodes, state.diagram.edges, BOX);

    const seriesHead = appendArrowHeads(seriesColour);

    const scene = el('g', { id: 'scene' });
    const edgeLayer = el('g', { class: 'edges' });
    const nodeLayer = el('g', { class: 'nodes' });
    scene.appendChild(edgeLayer);
    scene.appendChild(nodeLayer);
    svg.appendChild(scene);

    drawEdges(edgeLayer, seriesColour, seriesHead);
    drawNodes(nodeLayer);

    // The panel has no size on the first frame of a fresh webview, so a fit computed now would
    // scale against a stand-in width and leave the drawing cut off at the edge.
    state.untouched = true;
    requestAnimationFrame(fit);
    applyFilter();
}
