// The pure layout of a diagram: which layer each box sits in, which row it takes inside that layer,
// where the boxes land, and the curve of each arrow between them. Nothing here touches the document,
// so the page re-exports them from its entry for the Node unit tests.

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
export function assignLayers(nodes, edges) {
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
    // A resource that the crew both deliver and carry away, or a trigger that fires its own
    // source, closes a cycle. Left in the layering, every pass would push the whole ring one
    // layer further right until the bound stopped it, and the drawing would be a row of boxes
    // scaled down to nothing. The edges that close a ring in a depth-first walk are left out of
    // the layering instead; they still draw, bowing back under the row.
    const back = new Set();
    const seen = new Set();
    const onPath = new Set();
    const walk = (id) => {
        seen.add(id);
        onPath.add(id);
        for (const next of outgoing.get(id)) {
            if (onPath.has(next)) back.add(`${id}\u0000${next}`);
            else if (!seen.has(next)) walk(next);
        }
        onPath.delete(id);
    };
    for (const id of ids) if (!seen.has(id)) walk(id);

    const layer = new Map();
    for (const id of ids) layer.set(id, 0);
    // Longest path from the roots. Without the ring edges the graph has none, so the passes end
    // on their own; the bound is there for the day that stops being true.
    const passes = Math.min(ids.size, 64);
    for (let pass = 0; pass < passes; pass++) {
        let moved = false;
        for (const id of ids) {
            for (const next of outgoing.get(id)) {
                if (back.has(`${id}\u0000${next}`)) continue;
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
export function orderLayers(nodes, edges, layer) {
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
 * @returns {{boxes: Map<string, Box>, width: number, height: number}} the laid-out boxes and
 *          the size of the drawing.
 */
export function layoutDiagram(nodes, edges, metrics) {
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
 * @typedef {object} Box a laid-out node: the payload node it draws and where it sits.
 * @property {any} node the node as the server built it.
 * @property {number} x the left edge.
 * @property {number} y the top edge.
 * @property {number} width how wide the box is drawn.
 * @property {number} height how tall the box is drawn.
 */

/**
 * The four points of one arrow's cubic curve, from the right edge of its source to the left
 * edge of its target.
 *
 * @param {Box} from the source box.
 * @param {Box} to the target box.
 * @returns {Array<{x: number, y: number}>} start, two control points, end.
 */
export function edgeCurve(from, to) {
    const x1 = from.x + from.width;
    const y1 = from.y + from.height / 2;
    const x2 = to.x;
    const y2 = to.y + to.height / 2;
    // An arrow pointing backwards is a cycle, and a straight curve through the boxes between the
    // two would be unreadable, so it bows out under the row instead.
    if (x2 <= x1) {
        const dip = Math.max(from.height, Math.abs(y2 - y1)) * 0.9 + 24;
        return [
            { x: x1, y: y1 },
            { x: x1 + 40, y: y1 + dip },
            { x: x2 - 40, y: y2 + dip },
            { x: x2, y: y2 },
        ];
    }
    const bend = Math.max(30, (x2 - x1) / 2);
    return [
        { x: x1, y: y1 },
        { x: x1 + bend, y: y1 },
        { x: x2 - bend, y: y2 },
        { x: x2, y: y2 },
    ];
}

/**
 * The path data of one arrow.
 *
 * @param {Box} from the source box.
 * @param {Box} to the target box.
 * @returns {string} the SVG path data.
 */
export function edgePath(from, to) {
    const [p0, p1, p2, p3] = edgeCurve(from, to);
    return `M ${p0.x} ${p0.y} C ${p1.x} ${p1.y}, ${p2.x} ${p2.y}, ${p3.x} ${p3.y}`;
}

/**
 * Where the words of an arrow go: the point halfway along its curve, which on a forward arrow
 * is the middle of the gap between the two layers and on a bowed-back one the bottom of the bow,
 * both clear of the boxes.
 *
 * @param {Box} from the source box.
 * @param {Box} to the target box.
 * @returns {{x: number, y: number}} the point on the curve at its halfway parameter.
 */
export function edgeMidpoint(from, to) {
    const [p0, p1, p2, p3] = edgeCurve(from, to);
    return {
        x: (p0.x + 3 * p1.x + 3 * p2.x + p3.x) / 8,
        y: (p0.y + 3 * p1.y + 3 * p2.y + p3.y) / 8,
    };
}
