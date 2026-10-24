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

/**
 * Where a criteria entry wants the matched part's edges once the declaring part is flipped. The
 * game mirrors the matched rect across the part's width before comparing (`GetRulesRelativeRect`),
 * so a left edge becomes `width - right` and a right edge becomes `width - left`.
 *
 * @param entry the criteria entry as the payload sends it.
 * @param width the declaring part's width in cells.
 * @returns the entry's edge ranges as the flipped part reads them.
 */
export function mirrorCriteria(entry, width) {
    const flip = (range) => range && { min: width - range.max, max: width - range.min };
    return { ...entry, left: flip(entry.right), right: flip(entry.left) };
}

/** Whether a criteria entry accepts the same placements whether or not the declaring part is flipped. */
export function criteriaFlipSymmetric(entry, width) {
    const mirrored = mirrorCriteria(entry, width);
    const same = (a, b) => (!a && !b) || (!!a && !!b && a.min === b.min && a.max === b.max);
    return same(entry.left, mirrored.left) && same(entry.right, mirrored.right);
}

/**
 * Wraps an angle into [-180, 180) degrees.
 *
 * @param degrees the angle.
 * @returns the same direction, wrapped.
 */
function wrapDegrees(degrees) {
    return ((((degrees + 180) % 360) + 360) % 360) - 180;
}

/**
 * Narrows a wanted coverage arc to the physical arc the way the game does: the overlap of the two,
 * the physical arc where they do not overlap, and a zero-width arc clamped into the physical one.
 *
 * @param physical the physical arc, `{ near, width }` in degrees.
 * @param wanted the authored arc.
 * @returns the effective arc.
 */
function intersectArc(physical, wanted) {
    if (wanted.width >= 360) return physical;
    if (physical.width >= 360) return wanted;
    const end = physical.near + physical.width;
    let best = null;
    for (const shift of [-360, 0, 360]) {
        const near = wanted.near + shift;
        if (wanted.width === 0) {
            const clamped = Math.min(end, Math.max(physical.near, near));
            if (!best || Math.abs(clamped - near) < best.distance) {
                best = { near: clamped, width: 0, distance: Math.abs(clamped - near) };
            }
            continue;
        }
        const start = Math.max(physical.near, near);
        const stop = Math.min(end, near + wanted.width);
        if (stop >= start && (!best || stop - start > best.width)) best = { near: start, width: stop - start };
    }
    return best ? { near: best.near, width: best.width } : physical;
}

/**
 * A weapon's coverage as the game resolves it, in the mount frame (degrees, 0 along the mount
 * direction, positive clockwise). The physical arc is centered on the mount direction, a fixed
 * weapon's is a line along it. The effective arc is the authored arc narrowed to the physical one,
 * and the effective range the smaller of the two ranges.
 *
 * @param layer the coverage layer.
 * @returns the physical arc, the effective `near` and `width`, the `range` (Infinity when neither
 *          range is known) and the `rest` direction.
 */
export function effectiveCoverage(layer) {
    const { coverage } = layer;
    const physicalWidth = layer.weaponKind === 'fixed' ? 0 : layer.physicalArcDeg;
    const physical =
        physicalWidth === null || physicalWidth >= 360
            ? { near: -180, width: 360 }
            : { near: -physicalWidth / 2, width: physicalWidth };
    let arc = physical;
    if (coverage.arcNearDeg !== null && coverage.arcWidthDeg !== null) {
        arc = intersectArc(physical, { near: coverage.arcNearDeg, width: coverage.arcWidthDeg });
    } else if (layer.forceWidthZero) {
        arc = { near: 0, width: 0 };
    }
    const range = Math.min(layer.physicalRange ?? Infinity, coverage.range ?? Infinity);
    const rest = coverage.restPosition ?? 0.5;
    return { physical, near: arc.near, width: arc.width, range, rest: arc.near + arc.width * rest };
}

/**
 * How far the drawn stage reaches from a weapon: the distance to its nearest edge, where handles
 * stay on screen, and to its farthest corner, past which nothing needs drawing.
 *
 * @param center the weapon's location.
 * @param extent the drawn area.
 * @returns `{ near, far }` in cells.
 */
export function coverageReach(center, extent) {
    const left = center.x - extent.minX;
    const right = extent.minX + extent.width - center.x;
    const top = center.y - extent.minY;
    const bottom = extent.minY + extent.height - center.y;
    return {
        near: Math.max(0.5, Math.min(left, right, top, bottom)),
        far: Math.hypot(Math.max(left, right), Math.max(top, bottom)),
    };
}

/**
 * The drag handles of a turret's coverage: both arc edges, and the rest direction further in. They
 * sit inside the visible stage, since a range is often many times the part's size. A fixed weapon
 * has none, its range is dragged on the rim.
 *
 * @param layer the coverage layer.
 * @param resolved the layer's {@link effectiveCoverage}.
 * @param reach the layer's {@link coverageReach}.
 * @returns the handles, each `{ handle, x, y }` in grid units.
 */
export function coverageHandles(layer, resolved, reach) {
    if (layer.weaponKind === 'fixed' || !layer.center) return [];
    const radius = Math.min(resolved.range, reach.near * 0.8);
    const at = (handle, degrees, distance) => {
        const radians = ((layer.mountDeg + degrees) * Math.PI) / 180;
        return {
            handle,
            x: layer.center.x + Math.cos(radians) * distance,
            y: layer.center.y + Math.sin(radians) * distance,
        };
    };
    return [
        at('near', resolved.near, radius),
        at('far', resolved.near + resolved.width, radius),
        at('rest', resolved.rest, radius * 0.6),
    ];
}

/**
 * The `setCoverage` mutation a coverage handle dragged to a point stands for. Angles snap to a
 * degree, ranges to a cell, or to a tenth of either when fine.
 *
 * @param layer the coverage layer, as it was before the drag.
 * @param handle `near`, `far`, `rest` or `range`.
 * @param point the grid point under the cursor.
 * @param fine whether to snap to tenths.
 * @returns the mutation.
 */
export function coverageDragMutation(layer, handle, point, fine) {
    const step = fine ? 0.1 : 1;
    const round = (value) => Math.round(value * 1000) / 1000;
    const dx = point.x - layer.center.x;
    const dy = point.y - layer.center.y;
    const mutation = (field, value) => ({ op: 'setCoverage', component: layer.component, field, value });
    if (handle === 'range') return mutation('Range', round(Math.max(step, snapTo(Math.hypot(dx, dy), step))));
    const resolved = effectiveCoverage(layer);
    const angle = snapTo((Math.atan2(dy, dx) * 180) / Math.PI - layer.mountDeg, step);
    const far = resolved.near + resolved.width;
    const arc = (near, width) =>
        mutation('Arc', { nearDeg: round(wrapDegrees(near)), widthDeg: round(Math.min(360, Math.max(0, width))) });
    if (handle === 'near') {
        const near = resolved.near + wrapDegrees(angle - resolved.near);
        return arc(near, far - near);
    }
    if (handle === 'far') return arc(resolved.near, far + wrapDegrees(angle - far) - resolved.near);
    const offset = (((angle - resolved.near) % 360) + 360) % 360;
    if (!resolved.width) return mutation('RestPosition', 0.5);
    const beyond = offset > resolved.width && offset - resolved.width < 360 - offset;
    const rest = offset > resolved.width ? (beyond ? 1 : 0) : offset / resolved.width;
    return mutation('RestPosition', round(rest));
}

/**
 * A coverage with one `setCoverage` mutation applied, for the optimistic apply and the drag preview.
 *
 * @param coverage the layer's coverage as it stands.
 * @param mutation the `setCoverage` mutation.
 * @returns the new coverage, the given one left untouched.
 */
export function coverageAfter(coverage, mutation) {
    const next = Object.assign({}, coverage);
    if (mutation.field === 'Range') next.range = mutation.value;
    else if (mutation.field === 'RestPosition') next.restPosition = mutation.value;
    else {
        next.arcNearDeg = mutation.value ? mutation.value.nearDeg : null;
        next.arcWidthDeg = mutation.value ? mutation.value.widthDeg : null;
    }
    return next;
}
