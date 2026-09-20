// The part grid editor's pure geometry: the view transform, the snapping, and the small amount of
// game knowledge that is arithmetic rather than drawing. Nothing here touches the DOM or the page
// state, which is what lets the Node unit tests import it straight out of the bundle.
//
// Coordinate convention (verified against the game): cell (0,0) is the top-left of the unrotated
// part, X grows right, Y grows down; AdjacencyFlags Top is the -Y edge; TravelDirection Up is -Y.

import { MAX_CANVAS_AREA, MAX_CANVAS_DIMENSION } from './constants.js';

/** Rotates a vector by a clockwise quarter-turn multiple in y-down screen space. */
export function rotateQuarter(x, y, rotation) {
    switch (((rotation % 360) + 360) % 360) {
        case 90:
            return [-y, x];
        case 180:
            return [-x, -y];
        case 270:
            return [y, -x];
        default:
            return [x, y];
    }
}

/** Maps a grid point (cell units, rotation-0 space) to stage coordinates (cell units, view space). */
export function gridToStage(x, y, view, center) {
    let dx = x - center.x;
    let dy = y - center.y;
    if (view.flipH) dx = -dx;
    if (view.flipV) dy = -dy;
    return rotateQuarter(dx, dy, view.rotation);
}

/** Maps stage coordinates back to the grid point they came from (inverse of gridToStage). */
export function stageToGrid(sx, sy, view, center) {
    const [ux, uy] = rotateQuarter(sx, sy, 360 - view.rotation);
    const dx = view.flipH ? -ux : ux;
    const dy = view.flipV ? -uy : uy;
    return [dx + center.x, dy + center.y];
}

/** Snaps a value to a step (a step of 0 keeps it free). */
export function snapTo(value, step) {
    if (!step) return Math.round(value * 1000) / 1000;
    return Math.round(value / step) * step;
}

/** The edge/corner of AdjacencyFlags a within-cell position points at (fractions 0..1). */
export function adjacencyAt(fx, fy) {
    const column = fx < 1 / 3 ? 0 : fx < 2 / 3 ? 1 : 2;
    const row = fy < 1 / 3 ? 0 : fy < 2 / 3 ? 1 : 2;
    const table = [
        ['TopLeft', 'Top', 'TopRight'],
        ['Left', null, 'Right'],
        ['BottomLeft', 'Bottom', 'BottomRight'],
    ];
    return table[row][column];
}

/** Expands the AdjacencyFlags composites into their edge/corner members for rendering. */
export function expandAdjacency(values) {
    const expanded = new Set();
    for (const value of values) {
        if (value === 'All') {
            for (const name of ['Top', 'Right', 'Bottom', 'Left', 'TopLeft', 'TopRight', 'BottomRight', 'BottomLeft'])
                expanded.add(name);
        } else if (value === 'Sides') {
            for (const name of ['Top', 'Right', 'Bottom', 'Left']) expanded.add(name);
        } else if (value === 'Corners') {
            for (const name of ['TopLeft', 'TopRight', 'BottomRight', 'BottomLeft']) expanded.add(name);
        } else if (value !== 'None') {
            expanded.add(value);
        }
    }
    return expanded;
}

/** Maps an AdjacencyFlags edge name to the orthogonal direction it faces. */
export function edgeToDirection(edge) {
    return { Top: 'Up', Right: 'Right', Bottom: 'Down', Left: 'Left' }[edge] || null;
}

/**
 * The edge of an outside door cell that faces the part's physical rect, where the door itself
 * sits (verified against cannon_med: door cells attach to PhysicalRect, not the full Size).
 * Returns null when the cell is inside the rect or not side-adjacent to it (such an entry
 * never matches a door in game).
 */
export function doorEdgeFor(cell, rect) {
    const inside = (x, y) => x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
    if (inside(cell.x, cell.y)) return null;
    if (inside(cell.x - 1, cell.y)) return 'Left';
    if (inside(cell.x + 1, cell.y)) return 'Right';
    if (inside(cell.x, cell.y - 1)) return 'Top';
    if (inside(cell.x, cell.y + 1)) return 'Bottom';
    return null;
}

/** The unit offset a TravelDirection points at (y-down grid space). */
export function directionOffset(name) {
    switch (name) {
        case 'Up':
            return [0, -1];
        case 'Down':
            return [0, 1];
        case 'Left':
            return [-1, 0];
        case 'Right':
            return [1, 0];
        default:
            return [0, 0];
    }
}

/** Rotates a vector by an arbitrary angle in y-down space (positive = clockwise on screen). */
export function rotateDegrees(x, y, degrees) {
    const radians = (degrees * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    return [x * cos - y * sin, x * sin + y * cos];
}

/** Rotates a vector by the inverse of an angle in y-down space. */
export function rotateBackDegrees(x, y, degrees) {
    const radians = (-degrees * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    return [x * cos - y * sin, x * sin + y * cos];
}

/**
 * The total chain transform feeding a component, walked over the gizmo layer's entries, so a
 * drag can invert it and write the component's own location back in its unchained form.
 */
export function chainParentTransform(layer, entry) {
    if (!entry.chainedTo) return null;
    const byName = new Map(layer.entries.map((candidate) => [candidate.component, candidate]));
    let rotation = 0;
    let current = byName.get(entry.chainedTo);
    const visited = new Set();
    const location = current && current.location ? current.location : { x: 0, y: 0 };
    while (current && !visited.has(current.component)) {
        visited.add(current.component);
        rotation += current.rotationDeg || 0;
        current = current.chainedTo ? byName.get(current.chainedTo) : null;
    }
    return { location, rotation };
}

/** The rotation-field key of a rotation int-list field name. */
export function rotationKeyOf(field) {
    return {
        FlipHRotate: 'flipHRotate',
        FlipVRotate: 'flipVRotate',
        SelectionTypeRotations: 'selectionTypeRotations',
    }[field];
}

/**
 * The edge-distance region contour value at a point: the largest orthogonal gap between the
 * point and the part rect, so the level set `= d` is exactly the rect grown outward by `d` on
 * every side. Used to hit-test and drag the region halo boundary.
 */
export function edgeRegionDistanceAt(rect, point) {
    const dx = Math.max(rect.x - point.x, point.x - (rect.x + rect.width), 0);
    const dy = Math.max(rect.y - point.y, point.y - (rect.y + rect.height), 0);
    return Math.max(dx, dy);
}

/**
 * The device pixel ratio to back the canvas with, lowered until the backing store fits the
 * browser's allocation limits. A large grid at a high zoom then renders slightly soft instead
 * of not at all.
 *
 * @param size the canvas size in CSS pixels.
 * @param dpr the display's own pixel ratio.
 * @returns the ratio to multiply the CSS size by, never above `dpr`.
 */
export function backingRatio(size, dpr) {
    const byDimension = MAX_CANVAS_DIMENSION / Math.max(size.width, size.height);
    const byArea = Math.sqrt(MAX_CANVAS_AREA / (size.width * size.height));
    return Math.min(dpr, byDimension, byArea);
}

/** The four corner handle positions of a rect, in the order the drag code numbers them. */
export function rectHandles(rect) {
    return [
        [rect.x, rect.y],
        [rect.x + rect.width, rect.y],
        [rect.x + rect.width, rect.y + rect.height],
        [rect.x, rect.y + rect.height],
    ];
}

/** Whether two cells (either of which may be absent) name the same one. */
export function sameCell(a, b) {
    return !!a && !!b && a.x === b.x && a.y === b.y;
}
