// What a mousedown on the canvas does, per layer kind. The map at the top is the half of the
// layer-kind registry that belongs to clicking, which `main.js` stitches into the registry proper.
//
// Every handler is given the event, the grid point under the cursor and the cell that point falls
// in, and either sends a mutation, opens a drag, or moves the page's own selection.

import { setStatus } from './dom.js';
import {
    adjacencyAt,
    coverageHandles,
    coverageReach,
    edgeRegionDistanceAt,
    edgeToDirection,
    effectiveCoverage,
    expandAdjacency,
    sameCell,
    snapTo,
} from './geometry.js';
import {
    componentEntryAt,
    pairIndexAt,
    pointIndexAt,
    polygonEdgeAt,
    rectHandleAt,
    rectListHandleAt,
    vertexIndexAt,
} from './hit-geometry.js';
import { sendMutation } from './mutations.js';
import { draw } from './render.js';
import { renderSidebar } from './sidebar.js';
import { edgeRegionBaseRect, gridExtent, state } from './state.js';
import { t } from '../shared/strings.js';

/** The mousedown handler of each layer kind, by kind name. */
export const LAYER_HIT = {
    cellSet: hitCellSet,
    cellToValues: hitCellToValues,
    pointList: hitPointList,
    cellPairList: hitCellPairList,
    point: hitPoint,
    cell: hitCell,
    cellDirection: hitCellDirection,
    cellRay: hitCellDirection,
    polygon: hitPolygon,
    circle: hitCircle,
    edgeRegion: hitEdgeRegion,
    // Criteria are shown, not edited here: an edge range has no single handle to drag.
    criteria: () => {},
    coverage: hitCoverage,
    rectList: hitRectList,
    componentPoints: hitComponentPoints,
    rect: hitRect,
};

/** A single free point: a click places it, a click on it drags it, a right-click removes it. */
function hitPoint(layer, { event, point }) {
    if (event.button === 2) {
        if (layer.point) sendMutation({ op: 'setPoint', layerId: layer.id, point: null });
        return;
    }
    const snapped = { x: snapTo(point.x, state.snapStep), y: snapTo(point.y, state.snapStep) };
    if (layer.point && Math.hypot(layer.point.x - point.x, layer.point.y - point.y) <= 10 / state.view.scale) {
        state.dragging = { type: 'single', layerId: layer.id, point: layer.point };
        return;
    }
    sendMutation({ op: 'setPoint', layerId: layer.id, point: snapped });
}

/** A single cell: a click sets it, a right-click removes the field. */
function hitCell(layer, { event, cell }) {
    if (event.button === 2) {
        if (layer.cell) sendMutation({ op: 'setCell', layerId: layer.id, cell: null });
        return;
    }
    sendMutation({ op: 'setCell', layerId: layer.id, cell });
}

/** Shared by the cellDirection and cellRay kinds, which pick a cell and a facing the same way. */
function hitCellDirection(layer, { event, point, cell }) {
    if (event.button === 2) return;
    // Inside the current cell, an edge click turns the facing. Anywhere else moves the cell.
    if (layer.cell && cell.x === layer.cell.x && cell.y === layer.cell.y) {
        const edge = adjacencyAt(point.x - cell.x, point.y - cell.y);
        const direction = edge ? edgeToDirection(edge) : null;
        if (direction) {
            sendMutation({ op: 'setDirection', layerId: layer.id, direction });
            return;
        }
    }
    sendMutation({ op: 'setCell', layerId: layer.id, cell });
}

/** A polygon: a vertex drags, an edge takes an insertion, elsewhere appends, a right-click removes. */
function hitPolygon(layer, { event, point }) {
    const vertexIndex = vertexIndexAt(layer, point);
    if (event.button === 2) {
        if (vertexIndex >= 0) sendMutation({ op: 'removeVertex', layerId: layer.id, index: vertexIndex });
        return;
    }
    if (vertexIndex >= 0) {
        state.dragging = { type: 'vertex', layerId: layer.id, index: vertexIndex, point };
        return;
    }
    const snapped = { x: snapTo(point.x, state.snapStep), y: snapTo(point.y, state.snapStep) };
    const edgeIndex = polygonEdgeAt(layer, point);
    const index = edgeIndex >= 0 ? edgeIndex + 1 : layer.vertices.length;
    sendMutation({ op: 'insertVertex', layerId: layer.id, index, point: snapped });
}

/** A circle: the ring drags the radius, the center drags or is placed, a right-click clears it. */
function hitCircle(layer, { event, point }) {
    if (event.button === 2) {
        if (layer.center && layer.centerEditable) sendMutation({ op: 'setPoint', layerId: layer.id, point: null });
        return;
    }
    const center = layer.center || { x: state.data.size.width / 2, y: state.data.size.height / 2 };
    const onRadius =
        typeof layer.radius === 'number' &&
        Math.abs(Math.hypot(point.x - center.x, point.y - center.y) - layer.radius) <= 12 / state.view.scale;
    if (onRadius) {
        state.dragging = { type: 'circleRadius', layerId: layer.id, center };
        return;
    }
    if (!layer.centerEditable) {
        setStatus(t('The center follows the component. Move it in the Component locations layer.'));
        return;
    }
    if (layer.center && Math.hypot(center.x - point.x, center.y - point.y) <= 10 / state.view.scale) {
        state.dragging = { type: 'circleCenter', layerId: layer.id, point: center };
        return;
    }
    sendMutation({
        op: 'setPoint',
        layerId: layer.id,
        point: { x: snapTo(point.x, state.snapStep), y: snapTo(point.y, state.snapStep) },
    });
}

/** An edge-distance region: the halo boundary drags the distance, a right-click clears it. */
function hitEdgeRegion(layer, { event, point }) {
    if (event.button === 2) {
        if (layer.distance !== null) {
            sendMutation({ op: 'setNumber', layerId: layer.id, field: layer.distanceField, value: null });
        }
        return;
    }
    const rect = edgeRegionBaseRect();
    const onEdge =
        layer.distance !== null &&
        Math.abs(edgeRegionDistanceAt(rect, point) - layer.distance) <= 12 / state.view.scale;
    // Dragging the boundary resizes the halo. When no distance is set yet, any click seeds the
    // drag so a first value can be authored.
    if (onEdge || layer.distance === null) {
        state.dragging = {
            type: 'edgeRegion',
            layerId: layer.id,
            field: layer.distanceField,
            rect,
            distance: layer.distance,
        };
    }
}

/**
 * A weapon's coverage: an arc edge, the rest handle or the range rim opens the drag that rewrites
 * that member. The rim takes a press only where it is drawn on the stage.
 */
function hitCoverage(layer, { event, point }) {
    if (event.button === 2 || !layer.center) return;
    const resolved = effectiveCoverage(layer);
    const handles = coverageHandles(layer, resolved, coverageReach(layer.center, gridExtent()));
    const hit = handles.find(({ x, y }) => Math.hypot(x - point.x, y - point.y) <= 10 / state.view.scale);
    const tolerance = 12 / state.view.scale;
    const dx = point.x - layer.center.x;
    const dy = point.y - layer.center.y;
    const angle = (Math.atan2(dy, dx) * 180) / Math.PI - layer.mountDeg;
    const offset = (((angle - resolved.near) % 360) + 360) % 360;
    const outside = offset <= resolved.width ? 0 : Math.min(offset - resolved.width, 360 - offset);
    const onRim =
        Number.isFinite(resolved.range) &&
        Math.abs(Math.hypot(dx, dy) - resolved.range) <= tolerance &&
        (outside * Math.PI * resolved.range) / 180 <= tolerance;
    const handle = hit ? hit.handle : onRim ? 'range' : null;
    if (handle) state.dragging = { type: 'coverage', layerId: layer.id, handle };
}

/** A rect list: a corner handle drags that rect, a right-click on one removes the entry. */
function hitRectList(layer, { event, point }) {
    const hit = rectListHandleAt(layer, point);
    if (event.button === 2) {
        if (hit) sendMutation({ op: 'removeRectEntry', layerId: layer.id, index: hit.index });
        return;
    }
    if (hit) {
        state.rectDrag = {
            layerId: layer.id,
            handle: hit.handle,
            rect: Object.assign({}, layer.entries[hit.index].rect),
            entryIndex: hit.index,
        };
    }
}

/** The component gizmo: a click selects (cycling a stack) and opens the drag, elsewhere deselects. */
function hitComponentPoints(layer, { event, point }) {
    const entry = componentEntryAt(layer, point);
    if (event.button === 2) return;
    if (!entry) {
        state.selectedComponent = null;
        renderSidebar();
        draw();
        return;
    }
    state.selectedComponent = entry.component;
    renderSidebar();
    state.dragging = { type: 'component', layerId: layer.id, entry, point: entry.location };
    draw();
}

/** A point list: a point drags, a click appends, a right-click removes, unless the length is fixed. */
function hitPointList(layer, { event, point }) {
    const index = pointIndexAt(layer, point);
    if (event.button === 2) {
        if (index >= 0 && !layer.fixedCount) sendMutation({ op: 'removePoint', layerId: layer.id, index });
        return;
    }
    if (index >= 0) {
        state.dragging = { type: 'listPoint', layerId: layer.id, index, point: layer.points[index].point };
        return;
    }
    if (layer.fixedCount) return;
    const snapped = { x: snapTo(point.x, state.snapStep), y: snapTo(point.y, state.snapStep) };
    sendMutation({ op: 'addPoint', layerId: layer.id, point: snapped });
}

/** A single rect: only its corner handles take a press, which opens the resize drag. */
function hitRect(layer, { point }) {
    if (!layer.rect) return;
    const handle = rectHandleAt(layer.rect, point);
    if (handle >= 0) {
        state.rectDrag = {
            layerId: layer.id,
            handle,
            rect: Object.assign({}, layer.rect),
            fractional: !!layer.fractional,
        };
    }
}

/** A cell set: a click toggles the cell, in the layer's own base-cell coordinates. */
function hitCellSet(layer, { event, cell }) {
    if (event.button === 2) return;
    const base = layer.baseCell || { x: 0, y: 0 };
    const local = { x: cell.x - base.x, y: cell.y - base.y };
    const existing = layer.cells.some(({ cell: c }) => c.x === local.x && c.y === local.y);
    sendMutation({ op: existing ? 'removeCell' : 'addCell', layerId: layer.id, cell: local });
}

/** Cell entries: an edge click toggles that flag, the cell middle selects it, a right-click clears. */
function hitCellToValues(layer, { event, point, cell }) {
    if (event.button === 2) {
        sendMutation({ op: 'setEntryValues', layerId: layer.id, cell, values: [] });
        if (sameCell(state.selectedCell, cell)) state.selectedCell = null;
        renderSidebar();
        return;
    }
    if (layer.valueModel === 'flags') {
        // A click near an edge/corner toggles that flag directly. The cell middle selects the
        // cell so the sidebar toggles show its full value set.
        const flag = adjacencyAt(point.x - cell.x, point.y - cell.y);
        state.selectedCell = cell;
        if (flag) toggleEntryValue(layer, cell, flag);
        else renderSidebar();
    } else {
        state.selectedCell = cell;
        renderSidebar();
    }
    draw();
}

/** A pair list: the first click takes the external cell, the second writes the pair. */
function hitCellPairList(layer, { event, point, cell }) {
    if (event.button === 2) {
        const index = pairIndexAt(layer, point);
        if (index >= 0) sendMutation({ op: 'removePair', layerId: layer.id, index });
        state.pendingExternal = null;
        draw();
        return;
    }
    if (!state.pendingExternal) {
        state.pendingExternal = cell;
        setStatus(t('Virtual cell: now click the internal cell (right-click cancels)'));
    } else {
        sendMutation({
            op: 'setPair',
            layerId: layer.id,
            index: null,
            external: state.pendingExternal,
            internal: cell,
        });
        state.pendingExternal = null;
        setStatus('');
    }
    draw();
}

/**
 * Turns one value of a cell entry on or off, writing the whole value set back.
 *
 * @param layer the cellToValues layer.
 * @param cell the cell the entry belongs to.
 * @param value the enum member to toggle.
 */
export function toggleEntryValue(layer, cell, value) {
    const entry = layer.entries.find(({ cell: c }) => c.x === cell.x && c.y === cell.y);
    const current = entry ? entry.values.slice() : [];
    const expanded = Array.from(expandAdjacency(current));
    const set = new Set(layer.valueModel === 'flags' ? expanded : current);
    if (set.has(value)) set.delete(value);
    else set.add(value);
    sendMutation({ op: 'setEntryValues', layerId: layer.id, cell, values: Array.from(set) });
    renderSidebar();
}
