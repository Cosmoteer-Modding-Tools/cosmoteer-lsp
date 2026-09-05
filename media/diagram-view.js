// @ts-nocheck
// The diagram webview: draws the node-and-arrow payload the server builds for the resource flow of
// a part and its triggered-effects timeline. It knows nothing about Cosmoteer. Every judgement about
// what is certain and what is a lower bound is made on the server and arrives in the payload, so
// this page only has to draw what it is given and never has to guess.
//
// IDE-agnostic: VS Code provides acquireVsCodeApi natively, the JetBrains plugin shims it and
// replays host messages as MessageEvents after the page posts {type:'ready'}.
(function () {
    'use strict';

    // ---------------------------------------------------------------------------------------------
    // Pure layout, exported for Node unit tests (nothing below this block touches the DOM when
    // imported).
    // ---------------------------------------------------------------------------------------------

    /**
     * Assigns every node a layer, so an arrow points from a lower layer to a higher one wherever the
     * graph allows it.
     *
     * The graphs this draws are not always acyclic: a component chain can lead back to itself, and
     * that is a thing the reader most wants to see rather than a reason to refuse the drawing. An
     * edge that would push a node into a layer at or before one it already sits in is left out of the
     * ranking and still drawn, which is what turns a cycle into a visible arrow pointing backwards.
     *
     * @param {Array} nodes the payload's nodes.
     * @param {Array} edges the payload's edges.
     * @returns {Map<string, number>} the layer of each node id.
     */
    function assignLayers(nodes, edges) {
        const ids = new Set(nodes.map((node) => node.id));
        const incoming = new Map();
        const outgoing = new Map();
        for (const id of ids) {
            incoming.set(id, []);
            outgoing.set(id, []);
        }
        for (const edge of edges) {
            if (!ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to) continue;
            outgoing.get(edge.from).push(edge.to);
            incoming.get(edge.to).push(edge.from);
        }
        const layer = new Map();
        for (const id of ids) layer.set(id, 0);
        // Longest path from the roots, with a bound on the passes so a cycle cannot spin here.
        const passes = Math.min(ids.size, 64);
        for (let pass = 0; pass < passes; pass++) {
            let moved = false;
            for (const id of ids) {
                for (const next of outgoing.get(id)) {
                    if (layer.get(next) < layer.get(id) + 1) {
                        layer.set(next, layer.get(id) + 1);
                        moved = true;
                    }
                }
            }
            if (!moved) break;
        }
        return layer;
    }

    /**
     * Orders the nodes inside each layer so arrows cross as little as the sweep can manage.
     *
     * A handful of barycenter sweeps is what this needs. The graphs are small, the reader is looking
     * for which boxes are connected rather than for a provably minimal drawing, and an ordering that
     * shifts between two runs of the same command would read as the graph having changed.
     *
     * @param {Array} nodes the payload's nodes.
     * @param {Array} edges the payload's edges.
     * @param {Map<string, number>} layer the layer of each node id.
     * @returns {Map<string, number>} the row of each node id inside its layer.
     */
    function orderLayers(nodes, edges, layer) {
        const byLayer = new Map();
        for (const node of nodes) {
            const rows = byLayer.get(layer.get(node.id)) ?? [];
            rows.push(node.id);
            byLayer.set(layer.get(node.id), rows);
        }
        const row = new Map();
        for (const rows of byLayer.values()) rows.forEach((id, index) => row.set(id, index));

        const predecessors = new Map();
        for (const node of nodes) predecessors.set(node.id, []);
        for (const edge of edges) {
            if (!predecessors.has(edge.to) || !row.has(edge.from)) continue;
            if (layer.get(edge.from) >= layer.get(edge.to)) continue;
            predecessors.get(edge.to).push(edge.from);
        }

        const layers = [...byLayer.keys()].sort((a, b) => a - b);
        for (let sweep = 0; sweep < 4; sweep++) {
            for (const index of layers) {
                const rows = byLayer.get(index);
                const barycenter = new Map();
                rows.forEach((id, position) => {
                    const parents = predecessors.get(id);
                    if (!parents.length) {
                        barycenter.set(id, position);
                        return;
                    }
                    let sum = 0;
                    for (const parent of parents) sum += row.get(parent) ?? 0;
                    barycenter.set(id, sum / parents.length);
                });
                rows.sort((a, b) => barycenter.get(a) - barycenter.get(b) || a.localeCompare(b));
                rows.forEach((id, position) => row.set(id, position));
            }
        }
        return row;
    }

    /**
     * The box positions of a whole diagram.
     *
     * @param {Array} nodes the payload's nodes.
     * @param {Array} edges the payload's edges.
     * @param {{width: number, height: number, gapX: number, gapY: number}} metrics the box size and
     *        the space between boxes.
     * @returns {{boxes: Map<string, object>, width: number, height: number}} the laid-out boxes and
     *          the size of the drawing.
     */
    function layoutDiagram(nodes, edges, metrics) {
        const layer = assignLayers(nodes, edges);
        const row = orderLayers(nodes, edges, layer);
        const boxes = new Map();
        let width = 0;
        let height = 0;
        for (const node of nodes) {
            const x = layer.get(node.id) * (metrics.width + metrics.gapX);
            const y = row.get(node.id) * (metrics.height + metrics.gapY);
            boxes.set(node.id, { node, x, y, width: metrics.width, height: metrics.height });
            width = Math.max(width, x + metrics.width);
            height = Math.max(height, y + metrics.height);
        }
        return { boxes, width, height };
    }

    /**
     * The curve of one arrow, from the right edge of its source to the left edge of its target.
     *
     * @param {object} from the source box.
     * @param {object} to the target box.
     * @returns {string} the SVG path data.
     */
    function edgePath(from, to) {
        const x1 = from.x + from.width;
        const y1 = from.y + from.height / 2;
        const x2 = to.x;
        const y2 = to.y + to.height / 2;
        // An arrow pointing backwards is a cycle, and a straight curve through the boxes between the
        // two would be unreadable, so it bows out under the row instead.
        if (x2 <= x1) {
            const dip = Math.max(from.height, Math.abs(y2 - y1)) * 0.9 + 24;
            return `M ${x1} ${y1} C ${x1 + 40} ${y1 + dip}, ${x2 - 40} ${y2 + dip}, ${x2} ${y2}`;
        }
        const bend = Math.max(30, (x2 - x1) / 2);
        return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
    }

    if (typeof module !== 'undefined' && typeof acquireVsCodeApi === 'undefined') {
        module.exports = { assignLayers, orderLayers, layoutDiagram, edgePath };
        return;
    }

    // ---------------------------------------------------------------------------------------------
    // Webview runtime.
    // ---------------------------------------------------------------------------------------------

    const vscode = acquireVsCodeApi();

    // The host inlines the localized text into the page ahead of this script. A page whose host
    // inlines none finds no bundle and falls back to the key, which is the English source.
    const STRINGS = (typeof window !== 'undefined' && window.cosmoteerStrings) || {};

    /**
     * Looks a user-visible string up by its English source and fills in its numbered placeholders.
     *
     * @param message the English source, which is also the bundle key.
     * @param args the values for the `{0}`-style placeholders, in order.
     * @returns the localized text with its placeholders filled in.
     */
    function t(message, ...args) {
        const template = STRINGS[message] || message;
        if (!args.length) return template;
        return template.replace(/\{(\d+)\}/g, (match, index) => (args[index] === undefined ? match : String(args[index])));
    }

    const BOX = { width: 190, height: 46, gapX: 70, gapY: 16 };
    const MIN_ZOOM = 0.2;
    const MAX_ZOOM = 3;

    const svg = document.getElementById('canvas');
    const titleEl = document.getElementById('title');
    const subtitleEl = document.getElementById('subtitle');
    const legendEl = document.getElementById('legend');
    const notesEl = document.getElementById('notes');
    const filterEl = document.getElementById('filter');
    const emptyEl = document.getElementById('empty');

    const view = { x: 0, y: 0, zoom: 1 };
    // Whether the view is still the one `fit` chose. A resize re-fits until the reader moves it
    // themselves, after which their own pan and zoom stand.
    let untouched = true;
    let diagram = { nodes: [], edges: [], legend: [], notes: [] };
    let laid = { boxes: new Map(), width: 0, height: 0 };

    const NS = 'http://www.w3.org/2000/svg';

    /**
     * Creates an SVG element with attributes set.
     *
     * @param name the element name.
     * @param attributes the attributes to set.
     * @returns the element.
     */
    function el(name, attributes) {
        const node = document.createElementNS(NS, name);
        for (const [key, value] of Object.entries(attributes || {})) {
            if (value !== undefined && value !== null) node.setAttribute(key, String(value));
        }
        return node;
    }

    /** Applies the current pan and zoom to the drawing group. */
    function applyView() {
        const group = document.getElementById('scene');
        if (group) group.setAttribute('transform', `translate(${view.x} ${view.y}) scale(${view.zoom})`);
    }

    /** Fits the whole drawing into the panel. */
    function fit() {
        untouched = true;
        const width = svg.clientWidth || 800;
        const height = svg.clientHeight || 600;
        const scale = Math.min((width - 40) / Math.max(laid.width, 1), (height - 40) / Math.max(laid.height, 1), 1.5);
        view.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, scale));
        view.x = (width - laid.width * view.zoom) / 2;
        view.y = 20;
        applyView();
    }

    /** Draws the whole payload. */
    function render() {
        titleEl.textContent = diagram.title || '';
        subtitleEl.textContent = diagram.subtitle || '';
        subtitleEl.hidden = !diagram.subtitle;
        legendEl.replaceChildren();
        for (const entry of diagram.legend || []) {
            const item = document.createElement('span');
            item.className = `legend-item kind-${entry.kind}`;
            item.textContent = entry.label;
            legendEl.appendChild(item);
        }
        notesEl.replaceChildren();
        for (const note of diagram.notes || []) {
            const line = document.createElement('li');
            line.textContent = note;
            notesEl.appendChild(line);
        }
        notesEl.hidden = !(diagram.notes && diagram.notes.length);

        emptyEl.hidden = diagram.nodes.length > 0;
        svg.replaceChildren();
        if (!diagram.nodes.length) return;

        laid = layoutDiagram(diagram.nodes, diagram.edges, BOX);

        const defs = el('defs');
        for (const kind of ['include', 'inherit', 'action', 'flow', 'warning']) {
            const marker = el('marker', {
                id: `arrow-${kind}`,
                viewBox: '0 0 10 10',
                refX: 9,
                refY: 5,
                markerWidth: 7,
                markerHeight: 7,
                orient: 'auto-start-reverse',
            });
            marker.appendChild(el('path', { d: 'M 0 0 L 10 5 L 0 10 z', class: `arrow kind-${kind}` }));
            defs.appendChild(marker);
        }
        svg.appendChild(defs);

        const scene = el('g', { id: 'scene' });
        const edgeLayer = el('g', { class: 'edges' });
        const nodeLayer = el('g', { class: 'nodes' });
        scene.appendChild(edgeLayer);
        scene.appendChild(nodeLayer);
        svg.appendChild(scene);

        for (const edge of diagram.edges) {
            const from = laid.boxes.get(edge.from);
            const to = laid.boxes.get(edge.to);
            if (!from || !to) continue;
            const path = el('path', {
                d: edgePath(from, to),
                class: `edge kind-${edge.kind}`,
                'marker-end': `url(#arrow-${edge.kind})`,
            });
            if (edge.label) path.appendChild(el('title')).textContent = edge.label;
            edgeLayer.appendChild(path);
        }

        for (const box of laid.boxes.values()) {
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

        // The panel has no size on the first frame of a fresh webview, so a fit computed now would
        // scale against a stand-in width and leave the drawing cut off at the edge.
        untouched = true;
        requestAnimationFrame(fit);
        applyFilter();
    }

    /**
     * Cuts a text element down until it fits a width, ending it with an ellipsis.
     *
     * @param text the text element, already in the document so it can be measured.
     * @param width the width it has to fit into.
     */
    function truncate(text, width) {
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
    function open(place) {
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
    function applyFilter() {
        const needle = (filterEl.value || '').trim().toLowerCase();
        const matched = new Set();
        for (const box of laid.boxes.values()) {
            const haystack = `${box.node.label} ${box.node.detail || ''}`.toLowerCase();
            if (!needle || haystack.includes(needle)) matched.add(box.node.id);
        }
        for (const group of svg.querySelectorAll('g.node')) {
            group.classList.toggle('dimmed', !matched.has(group.getAttribute('data-id')));
        }
        const paths = svg.querySelectorAll('path.edge');
        diagram.edges.forEach((edge, index) => {
            const path = paths[index];
            if (!path) return;
            path.classList.toggle('dimmed', !(matched.has(edge.from) || matched.has(edge.to)));
        });
    }

    svg.addEventListener('wheel', (event) => {
        event.preventDefault();
        const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
        const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, view.zoom * factor));
        const rect = svg.getBoundingClientRect();
        const px = event.clientX - rect.left;
        const py = event.clientY - rect.top;
        view.x = px - ((px - view.x) * next) / view.zoom;
        view.y = py - ((py - view.y) * next) / view.zoom;
        view.zoom = next;
        untouched = false;
        applyView();
    }, { passive: false });

    let dragging = null;
    svg.addEventListener('pointerdown', (event) => {
        if (event.target.closest('g.node')) return;
        dragging = { x: event.clientX - view.x, y: event.clientY - view.y };
        svg.setPointerCapture(event.pointerId);
        svg.classList.add('panning');
    });
    svg.addEventListener('pointermove', (event) => {
        if (!dragging) return;
        view.x = event.clientX - dragging.x;
        view.y = event.clientY - dragging.y;
        untouched = false;
        applyView();
    });
    const endDrag = () => {
        dragging = null;
        svg.classList.remove('panning');
    };
    svg.addEventListener('pointerup', endDrag);
    svg.addEventListener('pointercancel', endDrag);

    if (typeof ResizeObserver !== 'undefined') {
        new ResizeObserver(() => {
            if (untouched) fit();
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
        diagram = message.diagram || { nodes: [], edges: [], legend: [], notes: [] };
        render();
    });

    vscode.postMessage({ type: 'ready' });
})();
