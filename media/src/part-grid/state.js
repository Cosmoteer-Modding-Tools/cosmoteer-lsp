// The page state and the view arithmetic read off it: the payload, what is visible, what is
// selected, the pending gestures, the edit queue and the command history, plus the handful of
// helpers that turn the state into extents, a zoom and a grid point.

import { DEFAULT_SCALE, KIND_COLORS, LAYER_COLORS, MIN_SCALE } from './constants.js';
import { canvas, setStatus } from './dom.js';
import { stageToGrid } from './geometry.js';
import { t } from '../shared/strings.js';

export const state = {
    data: null,
    images: new Map(),
    view: { rotation: 0, flipH: false, flipV: false, scale: DEFAULT_SCALE },
    activeLayerId: null,
    visibleLayers: new Set(),
    visibleSprites: new Set(),
    /** The selected cell of a cellToValues layer, whose values show as sidebar toggles. */
    selectedCell: null,
    /** The selected entry of the component gizmo layer, whose rotation shows in the sidebar. */
    selectedComponent: null,
    /** The pending external cell of a two-click pair gesture. */
    pendingExternal: null,
    /** Point-drag state: { layerId, index, point }. */
    dragging: null,
    /** Rect-drag state: { layerId, handle, rect }. */
    rectDrag: null,
    snapStep: 0.25,
    queue: [],
    inFlight: false,
    /** The command history: entries of { forward, inverse } mutations, undone LIFO. */
    undoStack: [],
    redoStack: [],
};

/** The layer being edited, or null when the page holds no payload. */
export function activeLayer() {
    return state.data ? state.data.layers.find((layer) => layer.id === state.activeLayerId) : null;
}

/** The drawn area in cell units, the addressable margin ring included. */
export function gridExtent() {
    const { size, margin } = state.data;
    return {
        minX: -margin,
        minY: -margin,
        width: size.width + 2 * margin,
        height: size.height + 2 * margin,
    };
}

/** The point the view rotates and flips around, which is the middle of the part. */
export function gridCenter() {
    return { x: state.data.size.width / 2, y: state.data.size.height / 2 };
}

/** The canvas pixel size for the current view (stage extents swap on quarter rotations). */
export function canvasSize() {
    const extent = gridExtent();
    const swapped = state.view.rotation === 90 || state.view.rotation === 270;
    return {
        width: (swapped ? extent.height : extent.width) * state.view.scale,
        height: (swapped ? extent.width : extent.height) * state.view.scale,
    };
}

/**
 * The zoom that puts the whole stage inside the panel. A part several times the default 96px
 * cell would otherwise open scrolled into its own top-left corner, which is not where anyone
 * wants to start. Never zooms past the default, a one-cell part stays readable rather than
 * filling the panel.
 *
 * @returns the scale, within the zoom range the buttons use.
 */
export function fitScale() {
    const stage = document.getElementById('stage');
    const extent = gridExtent();
    const swapped = state.view.rotation === 90 || state.view.rotation === 270;
    const width = swapped ? extent.height : extent.width;
    const height = swapped ? extent.width : extent.height;
    const available = {
        width: (stage ? stage.clientWidth : 0) - 24,
        height: (stage ? stage.clientHeight : 0) - 64,
    };
    if (available.width <= 0 || available.height <= 0) return DEFAULT_SCALE;
    const scale = Math.min(available.width / width, available.height / height);
    return Math.max(MIN_SCALE, Math.min(DEFAULT_SCALE, scale));
}

/** Converts a mouse event to grid coordinates through the inverse view transform. */
export function eventToGrid(event) {
    const bounds = canvas.getBoundingClientRect();
    const sx = (event.clientX - bounds.left - bounds.width / 2) / state.view.scale;
    const sy = (event.clientY - bounds.top - bounds.height / 2) / state.view.scale;
    const [x, y] = stageToGrid(sx, sy, state.view, gridCenter());
    return { x, y };
}

/** The legend color of a layer: the one its field is named with, else the one its kind carries. */
export function layerColor(layer) {
    return LAYER_COLORS[layer.fieldName] || KIND_COLORS[layer.kind] || '#4fc1ff';
}

/** The part's effective physical rect, which doors attach to (the full size when unset). */
export function physicalRectOf() {
    const layer = state.data.layers.find(
        (candidate) => candidate.kind === 'rect' && candidate.fieldName === 'PhysicalRect'
    );
    return (layer && layer.rect) || { x: 0, y: 0, width: state.data.size.width, height: state.data.size.height };
}

/**
 * The part rect the edge-distance region grows from, matching the game's physical rect (the
 * area the region measures its edge distance against).
 */
export function edgeRegionBaseRect() {
    return physicalRectOf();
}

/** Writes the hovered cell into the status line, unless a gesture is holding it. */
export function setHover(point) {
    if (state.pendingExternal || state.dragging || state.rectDrag) return;
    const cell = `${Math.floor(point.x)}, ${Math.floor(point.y)}`;
    const exact = `${point.x.toFixed(2)}, ${point.y.toFixed(2)}`;
    setStatus(t('cell [{0}]  ·  [{1}]', cell, exact));
}
