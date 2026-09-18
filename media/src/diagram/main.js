// The diagram webview: draws the node-and-arrow payload the server builds for the resource flow of
// a part and its triggered-effects timeline. It knows nothing about Cosmoteer. Every judgement about
// what is certain and what is a lower bound is made on the server and arrives in the payload, so
// this page only has to draw what it is given and never has to guess.
//
// IDE-agnostic: VS Code provides acquireVsCodeApi natively, the JetBrains plugin shims it and
// replays host messages as MessageEvents after the page posts {type:'ready'}.
//
// This entry wires the page up under a host. Loaded under Node instead, it starts nothing and only
// re-exports the pure layout for the unit tests.

import { t } from '../shared/strings.js';
import { MAX_ZOOM, MIN_ZOOM } from './constants.js';
import { emptyEl, filterEl, initDom, svg, vscode } from './dom.js';
import { assignLayers, edgeMidpoint, edgePath, layoutDiagram, orderLayers } from './layout.js';
import { render } from './render.js';
import { state } from './state.js';
import { applyFilter, applyView, fit } from './view.js';

/** Wires the page's pointer, keyboard and host listeners up and asks the host for a payload. */
function startPage() {
    initDom();

    svg.addEventListener(
        'wheel',
        (event) => {
            event.preventDefault();
            const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
            const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, state.view.zoom * factor));
            const rect = svg.getBoundingClientRect();
            const px = event.clientX - rect.left;
            const py = event.clientY - rect.top;
            state.view.x = px - ((px - state.view.x) * next) / state.view.zoom;
            state.view.y = py - ((py - state.view.y) * next) / state.view.zoom;
            state.view.zoom = next;
            state.untouched = false;
            applyView();
        },
        { passive: false }
    );

    svg.addEventListener('pointerdown', (event) => {
        if (/** @type {Element} */ (event.target).closest('g.node')) return;
        state.dragging = { x: event.clientX - state.view.x, y: event.clientY - state.view.y };
        svg.setPointerCapture(event.pointerId);
        svg.classList.add('panning');
    });
    svg.addEventListener('pointermove', (event) => {
        if (!state.dragging) return;
        state.view.x = event.clientX - state.dragging.x;
        state.view.y = event.clientY - state.dragging.y;
        state.untouched = false;
        applyView();
    });
    const endDrag = () => {
        state.dragging = null;
        svg.classList.remove('panning');
    };
    svg.addEventListener('pointerup', endDrag);
    svg.addEventListener('pointercancel', endDrag);

    if (typeof ResizeObserver !== 'undefined') {
        new ResizeObserver(() => {
            if (state.untouched) fit();
        }).observe(svg);
    }

    document.getElementById('fit').addEventListener('click', fit);
    document.getElementById('fit').title = t('Fit the whole diagram into the panel');
    filterEl.placeholder = t('Filter boxes');
    filterEl.addEventListener('input', applyFilter);
    emptyEl.textContent = t('Nothing to draw here.');

    window.addEventListener('message', (event) => {
        const message = event.data;
        if (!message || message.type !== 'diagram') return;
        state.diagram = message.diagram || { nodes: [], edges: [], legend: [], notes: [] };
        render();
    });

    vscode.postMessage({ type: 'ready' });
}

// A webview hands the page its host bridge, and a Node unit test that loads the bundle for the pure
// layout below does not. Nothing this file imports touches the document until startPage runs, so the
// page can be read without being started.
if (typeof acquireVsCodeApi !== 'undefined') startPage();

export { assignLayers, orderLayers, layoutDiagram, edgePath, edgeMidpoint };
