// The canvas gestures: the press that starts an edit or a drag, the move that carries it, and the
// release that turns it into a mutation. A press without movement is a selection rather than an
// edit, which is what keeps clicking a marker from writing a no-op into the file and the history.

import { canvas, setStatus } from './dom.js';
import { chainParentTransform, edgeRegionDistanceAt, rotateBackDegrees, snapTo } from './geometry.js';
import { dragRectHandle } from './hit-geometry.js';
import { LAYER_KINDS } from './layer-kinds.js';
import { sendMutation } from './mutations.js';
import { draw } from './render.js';
import { activeLayer, eventToGrid, setHover, state } from './state.js';
import { t } from '../shared/strings.js';

/** Registers the canvas and window gesture listeners, once, when the page starts. */
export function initGestures() {
    canvas.addEventListener('contextmenu', (event) => event.preventDefault());
    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
}

/** Hands the press to the active layer's kind, unless that layer is hidden. */
function onMouseDown(event) {
    if (!state.data) return;
    const layer = activeLayer();
    if (!layer) return;
    // Editing a layer that is switched off would move geometry nobody can see.
    if (!state.visibleLayers.has(layer.id)) {
        setStatus(t('{0} is hidden. Tick its checkbox to edit it.', layer.label));
        return;
    }
    const kind = LAYER_KINDS[layer.kind];
    if (!kind || !kind.hitTest) return;
    const point = eventToGrid(event);
    kind.hitTest(layer, { event, point, cell: { x: Math.floor(point.x), y: Math.floor(point.y) } });
}

/** Carries an open drag, or writes the hovered cell into the status line. */
function onMouseMove(event) {
    if (!state.data) return;
    const point = eventToGrid(event);
    setHover(point);
    if (state.dragging) {
        if (carryDrag(state.dragging, point)) draw();
    } else if (state.rectDrag) {
        dragRectHandle(state.rectDrag, point);
        draw();
    }
}

/**
 * Moves whatever the open drag holds onto the point under the cursor, on the local payload, so the
 * canvas follows the cursor before the mutation is sent.
 *
 * @param drag the open drag.
 * @param point the grid point under the cursor.
 * @returns whether the canvas has to be redrawn, which a drag on a layer that is gone does not.
 */
function carryDrag(drag, point) {
    const snapped = { x: snapTo(point.x, state.snapStep), y: snapTo(point.y, state.snapStep) };
    const layer = state.data.layers.find((candidate) => candidate.id === drag.layerId);
    drag.point = snapped;
    drag.moved = true;
    if (!layer) return false;
    if (drag.type === 'listPoint' && layer.points[drag.index]) {
        layer.points[drag.index] = { point: snapped, origin: { inherited: false } };
    } else if (drag.type === 'single') {
        layer.point = snapped;
    } else if (drag.type === 'vertex' && layer.vertices[drag.index]) {
        layer.vertices[drag.index] = { point: snapped, origin: { inherited: false } };
    } else if (drag.type === 'circleCenter') {
        layer.center = snapped;
    } else if (drag.type === 'circleRadius') {
        drag.radius = Math.max(0.25, snapTo(Math.hypot(point.x - drag.center.x, point.y - drag.center.y), 0.25));
        layer.radius = drag.radius;
    } else if (drag.type === 'edgeRegion') {
        // The distance is an integer count of cells, so the halo snaps to whole rings.
        drag.distance = Math.max(0, Math.round(edgeRegionDistanceAt(drag.rect, point)));
    } else if (drag.type === 'component') {
        const entry = layer.entries.find((candidate) => candidate.component === drag.entry.component);
        if (entry) entry.location = snapped;
    }
    return true;
}

/** Ends whichever drag is open, turning it into the mutation it stands for. */
function onMouseUp() {
    if (state.dragging) {
        const drag = state.dragging;
        state.dragging = null;
        // A press without movement is a selection, not an edit. Skipping it keeps clicking a
        // marker (or cycling a stack) from writing no-op edits into the file and the history.
        if (!drag.moved) {
            draw();
            return;
        }
        commitDrag(drag);
    }
    if (state.rectDrag) {
        const drag = state.rectDrag;
        state.rectDrag = null;
        if (drag.entryIndex !== undefined) {
            sendMutation({
                op: 'setRectEntry',
                layerId: drag.layerId,
                index: drag.entryIndex,
                tag: null,
                rect: drag.rect,
            });
        } else {
            sendMutation({ op: 'setRect', layerId: drag.layerId, rect: drag.rect });
        }
    }
}

/**
 * Sends the mutation a finished point drag stands for.
 *
 * @param drag the drag that was released, which did move.
 */
function commitDrag(drag) {
    if (drag.type === 'listPoint') {
        sendMutation({ op: 'movePoint', layerId: drag.layerId, index: drag.index, point: drag.point });
    } else if (drag.type === 'single' || drag.type === 'circleCenter') {
        sendMutation({ op: 'setPoint', layerId: drag.layerId, point: drag.point });
    } else if (drag.type === 'vertex') {
        sendMutation({ op: 'moveVertex', layerId: drag.layerId, index: drag.index, point: drag.point });
    } else if (drag.type === 'circleRadius' && drag.radius) {
        const layer = state.data && state.data.layers.find((candidate) => candidate.id === drag.layerId);
        sendMutation({
            op: 'setNumber',
            layerId: drag.layerId,
            field: layer ? layer.radiusField : 'BuffRadius',
            value: drag.radius,
        });
    } else if (drag.type === 'edgeRegion') {
        sendMutation({ op: 'setNumber', layerId: drag.layerId, field: drag.field, value: drag.distance });
    } else if (drag.type === 'component') {
        sendMutation({ op: 'moveComponentLocation', component: drag.entry.component, point: componentDropPoint(drag) });
    }
}

/**
 * Where a dropped component marker is written. Chained components author their location relative to
 * the chain parent, so the dropped grid point is transformed back through the parent's total
 * rotation.
 *
 * @param drag the component drag that was released.
 * @returns the point to write.
 */
function componentDropPoint(drag) {
    const layer = state.data && state.data.layers.find((candidate) => candidate.id === drag.layerId);
    const entry = layer && layer.entries.find((candidate) => candidate.component === drag.entry.component);
    if (!entry || !entry.chainedTo) return drag.point;
    const parent = chainParentTransform(layer, entry);
    if (!parent) return drag.point;
    const [ux, uy] = rotateBackDegrees(
        drag.point.x - parent.location.x,
        drag.point.y - parent.location.y,
        parent.rotation
    );
    return { x: snapTo(ux, state.snapStep), y: snapTo(uy, state.snapStep) };
}
