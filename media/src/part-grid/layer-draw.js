// How each layer kind draws itself. The map at the top is the half of the layer-kind registry that
// belongs to rendering, which `main.js` stitches into the registry proper.

import { ctx, themeColor } from './dom.js';
import { drawLabel, drawPairArrow, drawPoint, fillCell, setGhost } from './draw-primitives.js';
import { directionOffset, doorEdgeFor, expandAdjacency, rectHandles } from './geometry.js';
import { edgeRegionBaseRect, gridExtent, physicalRectOf, state } from './state.js';
import { t } from '../shared/strings.js';

/** The renderer of each layer kind, by kind name. */
export const LAYER_DRAW = {
    cellSet: drawCellSetLayer,
    cellToValues: drawCellToValues,
    pointList: drawPointListLayer,
    cellPairList: drawCellPairListLayer,
    point: drawPointLayer,
    cell: drawCellLayer,
    cellDirection: drawCellDirection,
    cellRay: drawCellRay,
    polygon: drawPolygon,
    circle: drawCircle,
    edgeRegion: drawEdgeRegion,
    rectList: drawRectList,
    componentPoints: drawComponentPoints,
    rect: drawRect,
};

/** Door-ring cells draw as door strips, every other cell set as filled cells. */
function drawCellSetLayer(layer, color, active, ghost) {
    if (layer.domain === 'outside') {
        drawDoorCells(layer, color, active);
        return;
    }
    const base = layer.baseCell || { x: 0, y: 0 };
    for (const { cell, origin } of layer.cells) {
        fillCell(base.x + cell.x, base.y + cell.y, color, active ? 0.45 : 0.25, ghost || origin.inherited);
    }
}

/**
 * Door locations draw as what they are: a door strip on the wall shared with the part's
 * physical rect, plus a faint tint on the outside cell for the click target. An entry that is
 * not side-adjacent to the physical rect never matches a door in game, so it renders as a
 * dashed cell to flag the dead entry.
 */
function drawDoorCells(layer, color, active) {
    const rect = physicalRectOf();
    for (const { cell, origin } of layer.cells) {
        const ghost = layer.inherited || origin.inherited;
        const edge = doorEdgeFor(cell, rect);
        if (!edge) {
            fillCell(cell.x, cell.y, color, active ? 0.35 : 0.2, true);
            continue;
        }
        const modifier = setGhost(ghost);
        ctx.fillStyle = color;
        ctx.globalAlpha = (active ? 0.16 : 0.09) * modifier;
        ctx.fillRect(cell.x + 0.05, cell.y + 0.05, 0.9, 0.9);
        const strips = {
            Top: [cell.x + 0.18, cell.y - 0.14, 0.64, 0.28],
            Bottom: [cell.x + 0.18, cell.y + 1 - 0.14, 0.64, 0.28],
            Left: [cell.x - 0.14, cell.y + 0.18, 0.28, 0.64],
            Right: [cell.x + 1 - 0.14, cell.y + 0.18, 0.28, 0.64],
        };
        const [sx, sy, sw, sh] = strips[edge];
        ctx.globalAlpha = 0.9 * modifier;
        ctx.fillRect(sx, sy, sw, sh);
        ctx.strokeStyle = themeColor('--vscode-editor-background', '#1e1e1e');
        ctx.lineWidth = 1.5 / state.view.scale;
        ctx.strokeRect(sx, sy, sw, sh);
        ctx.globalAlpha = 1;
        ctx.setLineDash([]);
    }
}

/** Cell entries draw as wall strokes or as travel arrows, whichever value model the layer uses. */
function drawCellToValues(layer, color, active) {
    if (layer.valueModel === 'flags') drawWallEntries(layer, color, active);
    else drawDirectionEntries(layer, color, active);
}

/** Wall flags render as thick strokes on the named cell edges and squares on the corners. */
function drawWallEntries(layer, color, active) {
    const width = (active ? 6 : 4) / state.view.scale;
    for (const { cell, values, origin } of layer.entries) {
        const modifier = setGhost(layer.inherited || origin.inherited);
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.9 * modifier;
        ctx.lineWidth = width;
        const edges = {
            Top: [
                [cell.x, cell.y],
                [cell.x + 1, cell.y],
            ],
            Right: [
                [cell.x + 1, cell.y],
                [cell.x + 1, cell.y + 1],
            ],
            Bottom: [
                [cell.x, cell.y + 1],
                [cell.x + 1, cell.y + 1],
            ],
            Left: [
                [cell.x, cell.y],
                [cell.x, cell.y + 1],
            ],
        };
        const corners = {
            TopLeft: [cell.x, cell.y],
            TopRight: [cell.x + 1, cell.y],
            BottomRight: [cell.x + 1, cell.y + 1],
            BottomLeft: [cell.x, cell.y + 1],
        };
        for (const name of expandAdjacency(values)) {
            if (edges[name]) {
                const [[x1, y1], [x2, y2]] = edges[name];
                ctx.beginPath();
                ctx.moveTo(x1, y1);
                ctx.lineTo(x2, y2);
                ctx.stroke();
            } else if (corners[name]) {
                const [x, y] = corners[name];
                ctx.fillRect(x - 0.08, y - 0.08, 0.16, 0.16);
            }
        }
        ctx.globalAlpha = 1;
        ctx.setLineDash([]);
    }
}

/** Travel directions render as arrows from the cell center toward the blocked neighbour. */
function drawDirectionEntries(layer, color, active) {
    for (const { cell, values, origin } of layer.entries) {
        const modifier = setGhost(layer.inherited || origin.inherited);
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.9 * modifier;
        ctx.lineWidth = (active ? 3 : 2) / state.view.scale;
        for (const value of values) {
            const [dx, dy] = directionOffset(value);
            if (!dx && !dy) continue;
            const cx = cell.x + 0.5;
            const cy = cell.y + 0.5;
            const tipX = cx + dx * 0.4;
            const tipY = cy + dy * 0.4;
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.lineTo(tipX, tipY);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(tipX + dx * 0.08, tipY + dy * 0.08);
            ctx.lineTo(tipX - dy * 0.08, tipY - dx * 0.08);
            ctx.lineTo(tipX + dy * 0.08, tipY + dx * 0.08);
            ctx.closePath();
            ctx.fill();
        }
        ctx.globalAlpha = 1;
        ctx.setLineDash([]);
    }
}

/** A list of free points draws one marker per point. */
function drawPointListLayer(layer, color, active, ghost) {
    for (const { point, origin } of layer.points) {
        drawPoint(point.x, point.y, color, active, ghost || origin.inherited);
    }
}

/** A list of external/internal cell pairs draws one arrow per pair. */
function drawCellPairListLayer(layer, color, active, ghost) {
    for (const { external, internal, origin } of layer.pairs) {
        drawPairArrow(external, internal, color, active, ghost || origin.inherited);
    }
}

/** A single free point draws one marker. */
function drawPointLayer(layer, color, active, ghost) {
    if (layer.point) drawPoint(layer.point.x, layer.point.y, color, active, ghost);
}

/** A single cell draws as a filled cell. */
function drawCellLayer(layer, color, active, ghost) {
    if (layer.cell) fillCell(layer.cell.x, layer.cell.y, color, active ? 0.45 : 0.25, ghost);
}

/** A cell with a facing draws as a filled cell plus a stub arrow toward the facing. */
function drawCellDirection(layer, color, active, ghost) {
    if (!layer.cell) return;
    fillCell(layer.cell.x, layer.cell.y, color, active ? 0.4 : 0.25, ghost);
    if (!layer.direction) return;
    const [dx, dy] = directionOffset(layer.direction);
    const modifier = setGhost(ghost);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.95 * modifier;
    ctx.lineWidth = (active ? 4 : 3) / state.view.scale;
    const cx = layer.cell.x + 0.5;
    const cy = layer.cell.y + 0.5;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + dx * 0.55, cy + dy * 0.55);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx + dx * 0.55, cy + dy * 0.55, 0.08, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
}

/** A ray draws as a dashed line from its cell out to its reach, capped by the drawn extent. */
function drawCellRay(layer, color, active, ghost) {
    if (!layer.cell) return;
    fillCell(layer.cell.x, layer.cell.y, color, active ? 0.4 : 0.25, ghost);
    if (!layer.direction) return;
    const [dx, dy] = directionOffset(layer.direction);
    const extent = gridExtent();
    const visible = Math.max(extent.width, extent.height);
    const length = Math.min(layer.maxTiles || visible, visible);
    const modifier = setGhost(ghost);
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.6 * modifier;
    ctx.lineWidth = (active ? 4 : 3) / state.view.scale;
    ctx.setLineDash([0.3, 0.2]);
    const cx = layer.cell.x + 0.5;
    const cy = layer.cell.y + 0.5;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + dx * length, cy + dy * length);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
}

/** A polygon draws as a filled outline with a grab handle on every vertex of the edited layer. */
function drawPolygon(layer, color, active, ghost) {
    if (!layer.vertices.length) return;
    const modifier = setGhost(ghost);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = (active ? 3 : 2) / state.view.scale;
    ctx.globalAlpha = 0.15 * modifier;
    ctx.beginPath();
    for (const [index, { point }] of layer.vertices.entries()) {
        if (index === 0) ctx.moveTo(point.x, point.y);
        else ctx.lineTo(point.x, point.y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 0.9 * modifier;
    ctx.stroke();
    if (active) {
        for (const { point, isRef } of layer.vertices) {
            ctx.beginPath();
            ctx.arc(point.x, point.y, 5 / state.view.scale, 0, Math.PI * 2);
            // A reference-valued vertex renders hollow: it drags like the rest, but the number
            // it writes lands in the declaration it names rather than here.
            if (isRef) ctx.stroke();
            else ctx.fill();
        }
    }
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
}

/** A circle draws as a filled ring around its center, with a radius handle on the edited layer. */
function drawCircle(layer, color, active, ghost) {
    const center = layer.center || { x: state.data.size.width / 2, y: state.data.size.height / 2 };
    const modifier = setGhost(ghost || !layer.center);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = (active ? 3 : 2) / state.view.scale;
    // A zero radius is a circle with no reach, which the author wrote on purpose, so the
    // ring is drawn and grabbable at every written value rather than at every truthy one.
    if (typeof layer.radius === 'number') {
        ctx.globalAlpha = 0.12 * modifier;
        ctx.beginPath();
        ctx.arc(center.x, center.y, layer.radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 0.8 * modifier;
        ctx.stroke();
    }
    drawPoint(center.x, center.y, color, active, ghost || !layer.center);
    if (active && typeof layer.radius === 'number') {
        ctx.globalAlpha = 0.95;
        ctx.fillRect(center.x + layer.radius - 0.08, center.y - 0.08, 0.16, 0.16);
    }
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
}

/** An edge-distance region draws as the ring between the part rect and the halo it grows to. */
function drawEdgeRegion(layer, color, active, ghost) {
    const dragging = state.dragging && state.dragging.type === 'edgeRegion' && state.dragging.layerId === layer.id;
    const distance = dragging ? state.dragging.distance : layer.distance;
    const modifier = setGhost(ghost || layer.distance === null);
    const rect = edgeRegionBaseRect();
    const d = distance || 0;
    const outer = { x: rect.x - d, y: rect.y - d, width: rect.width + 2 * d, height: rect.height + 2 * d };
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = (active ? 3 : 2) / state.view.scale;
    if (d > 0) {
        // Fill only the ring between the part rect and the outer halo, so the part stays legible.
        ctx.globalAlpha = 0.12 * modifier;
        ctx.beginPath();
        ctx.rect(outer.x, outer.y, outer.width, outer.height);
        ctx.rect(rect.x, rect.y, rect.width, rect.height);
        ctx.fill('evenodd');
    }
    ctx.globalAlpha = 0.8 * modifier;
    ctx.strokeRect(outer.x, outer.y, outer.width, outer.height);
    if (active) {
        // A grab handle at the right edge midpoint, mirroring the circle's radius handle.
        ctx.globalAlpha = 0.95;
        ctx.fillRect(outer.x + outer.width - 0.08, outer.y + outer.height / 2 - 0.08, 0.16, 0.16);
    }
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
}

/** A rect list draws every entry with its handles and its tag, plus the dashed scalar fallbacks. */
function drawRectList(layer, color, active, ghost) {
    const modifier = setGhost(ghost);
    ctx.lineWidth = (active ? 3 : 2) / state.view.scale;
    for (const [index, entry] of layer.entries.entries()) {
        const dragging = state.rectDrag && state.rectDrag.layerId === layer.id && state.rectDrag.entryIndex === index;
        const rect = dragging ? state.rectDrag.rect : entry.rect;
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.85 * modifier;
        ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
        if (active) {
            ctx.fillStyle = color;
            for (const [hx, hy] of rectHandles(rect)) ctx.fillRect(hx - 0.08, hy - 0.08, 0.16, 0.16);
            drawLabel(`${entry.tag || ''} ${index}`, rect.x, rect.y);
        }
    }
    ctx.setLineDash([0.15, 0.1]);
    ctx.globalAlpha = 0.5 * modifier;
    for (const { rect } of layer.fallbackRects) {
        ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
    }
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
}

/** Groups gizmo entries that sit on (nearly) the same spot, so stacks render readably. */
function componentStacks(layer) {
    const stacks = new Map();
    for (const entry of layer.entries) {
        if (!entry.location) continue;
        const key = `${Math.round(entry.location.x * 20)}:${Math.round(entry.location.y * 20)}`;
        if (!stacks.has(key)) stacks.set(key, []);
        stacks.get(key).push(entry);
    }
    return Array.from(stacks.values());
}

/** The component gizmo draws one marker per stack, with a rotation stub and a stacked label. */
function drawComponentPoints(layer, color, active) {
    const lineStep = 15 / state.view.scale;
    for (const stack of componentStacks(layer)) {
        const anchor = stack[0].location;
        const selectedEntry = stack.find((entry) => entry.component === state.selectedComponent);
        const allBound = stack.every((entry) => entry.locationIsRef || entry.chainedTo);
        drawPoint(anchor.x, anchor.y, selectedEntry ? '#ffffff' : allBound ? '#9a9a9a' : color, active, false);
        for (const entry of stack) {
            if (entry.rotationDeg === null && entry.component !== state.selectedComponent) continue;
            const radians = (((entry.rotationDeg || 0) - 90) * Math.PI) / 180;
            ctx.strokeStyle = entry.component === state.selectedComponent ? '#ffffff' : color;
            ctx.lineWidth = 2 / state.view.scale;
            ctx.beginPath();
            ctx.moveTo(anchor.x, anchor.y);
            ctx.lineTo(anchor.x + Math.cos(radians) * 0.35, anchor.y + Math.sin(radians) * 0.35);
            ctx.stroke();
        }
        if (!active) continue;
        // Stacked labels, one line per component, so co-located names never overlap. A large
        // stack collapses to a count, the sidebar list has the full names.
        if (stack.length > 3 && !selectedEntry) {
            drawLabel(t('{0} components (click to cycle)', stack.length), anchor.x, anchor.y + 0.12);
            continue;
        }
        const shown = stack.length > 3 ? [selectedEntry] : stack;
        for (const [index, entry] of shown.entries()) {
            const marker = entry.component === state.selectedComponent ? '▸ ' : '';
            drawLabel(`${marker}${entry.label}`, anchor.x, anchor.y + 0.12 + index * lineStep);
        }
    }
}

/** A single rect draws as an outline, washed with its own color while it is the edited layer. */
function drawRect(layer, color, active, ghost) {
    if (!layer.rect) return;
    const modifier = setGhost(ghost);
    const rect = state.rectDrag && state.rectDrag.layerId === layer.id ? state.rectDrag.rect : layer.rect;
    // A rect covering most of the part is a thin outline lost among the sprites, so the active
    // one is washed with its own color. The wash is the whole reason it reads at any zoom.
    if (active) {
        ctx.globalAlpha = 0.12 * modifier;
        ctx.fillStyle = color;
        ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
    }
    // A computed rect draws dashed: its value lives in a reference, and dragging it writes the
    // number where that reference points rather than over the reference itself.
    if (layer.isRef) ctx.setLineDash([0.4, 0.2]);
    ctx.globalAlpha = 0.9 * modifier;
    ctx.strokeStyle = color;
    ctx.lineWidth = (active ? 3 : 2) / state.view.scale;
    ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
    if (active) {
        ctx.setLineDash([]);
        ctx.fillStyle = color;
        for (const [hx, hy] of rectHandles(rect)) {
            ctx.fillRect(hx - 0.08, hy - 0.08, 0.16, 0.16);
        }
    }
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
}
