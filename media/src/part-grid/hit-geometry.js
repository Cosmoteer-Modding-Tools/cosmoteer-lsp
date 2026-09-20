// What sits under a grid point: the nearest vertex, the segment an insertion belongs on, the rect
// handle being grabbed, and the gizmo entry a click selects. The hit radii are in canvas pixels
// divided by the zoom, so a handle stays as easy to grab at any scale.

import { rectHandles, snapTo } from './geometry.js';
import { state } from './state.js';

/** The index of the vertex nearest the point within a hit radius, or -1. */
export function vertexIndexAt(layer, point) {
    const radius = 10 / state.view.scale;
    for (let index = 0; index < layer.vertices.length; index++) {
        const { point: p } = layer.vertices[index];
        if (Math.hypot(p.x - point.x, p.y - point.y) <= radius) return index;
    }
    return -1;
}

/** The segment index whose edge passes near the point (for vertex insertion), or -1. */
export function polygonEdgeAt(layer, point) {
    const radius = 8 / state.view.scale;
    const count = layer.vertices.length;
    for (let index = 0; index < count; index++) {
        const a = layer.vertices[index].point;
        const b = layer.vertices[(index + 1) % count].point;
        const abx = b.x - a.x;
        const aby = b.y - a.y;
        const lengthSq = abx * abx + aby * aby;
        if (!lengthSq) continue;
        const t = Math.max(0, Math.min(1, ((point.x - a.x) * abx + (point.y - a.y) * aby) / lengthSq));
        const dx = point.x - (a.x + t * abx);
        const dy = point.y - (a.y + t * aby);
        if (Math.hypot(dx, dy) <= radius) return index;
    }
    return -1;
}

/** The corner handle of a rect the point grabs, by its index in `rectHandles`, or -1. */
export function rectHandleAt(rect, point) {
    const radius = 12 / state.view.scale;
    const handles = rectHandles(rect);
    for (let index = 0; index < handles.length; index++) {
        if (Math.hypot(handles[index][0] - point.x, handles[index][1] - point.y) <= radius) return index;
    }
    return -1;
}

/** The rect-list entry whose handle sits at the point: { index, handle }, or null. */
export function rectListHandleAt(layer, point) {
    for (let index = 0; index < layer.entries.length; index++) {
        const handle = rectHandleAt(layer.entries[index].rect, point);
        if (handle >= 0) return { index, handle };
    }
    return null;
}

/**
 * The gizmo entry a click at the point selects. Co-located components stack on one marker, so
 * a repeated click cycles through the stack instead of always hitting the first one.
 */
export function componentEntryAt(layer, point) {
    const radius = 12 / state.view.scale;
    const hits = layer.entries.filter(
        (entry) => entry.location && Math.hypot(entry.location.x - point.x, entry.location.y - point.y) <= radius
    );
    if (!hits.length) return null;
    const current = hits.findIndex((entry) => entry.component === state.selectedComponent);
    return hits[(current + 1) % hits.length];
}

/** The index of the list point nearest the grid point within a hit radius, or -1. */
export function pointIndexAt(layer, point) {
    const radius = 10 / state.view.scale;
    for (let index = 0; index < layer.points.length; index++) {
        const { point: p } = layer.points[index];
        if (Math.hypot(p.x - point.x, p.y - point.y) <= radius) return index;
    }
    return -1;
}

/** The index of the pair either of whose cells the grid point falls in, or -1. */
export function pairIndexAt(layer, point) {
    for (let index = 0; index < layer.pairs.length; index++) {
        const { external, internal } = layer.pairs[index];
        for (const c of [external, internal]) {
            if (Math.floor(point.x) === c.x && Math.floor(point.y) === c.y) return index;
        }
    }
    return -1;
}

/** Drags one corner handle, keeping the rect normalized with a minimum extent. */
export function dragRectHandle(drag, point) {
    const gx = drag.fractional ? snapTo(point.x, 0.25) : Math.round(point.x);
    const gy = drag.fractional ? snapTo(point.y, 0.25) : Math.round(point.y);
    const minimum = drag.fractional ? 0.25 : 1;
    const rect = drag.rect;
    const right = rect.x + rect.width;
    const bottom = rect.y + rect.height;
    if (drag.handle === 0) {
        rect.width = Math.max(minimum, right - gx);
        rect.height = Math.max(minimum, bottom - gy);
        rect.x = right - rect.width;
        rect.y = bottom - rect.height;
    } else if (drag.handle === 1) {
        rect.width = Math.max(minimum, gx - rect.x);
        rect.height = Math.max(minimum, bottom - gy);
        rect.y = bottom - rect.height;
    } else if (drag.handle === 2) {
        rect.width = Math.max(minimum, gx - rect.x);
        rect.height = Math.max(minimum, gy - rect.y);
    } else {
        rect.width = Math.max(minimum, right - gx);
        rect.x = right - rect.width;
        rect.height = Math.max(minimum, gy - rect.y);
    }
}
