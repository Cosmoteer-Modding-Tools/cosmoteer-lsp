// The marks every layer is drawn out of: a tinted cell, a handle point, a pair arrow and an upright
// label. They all draw in grid coordinates, because the view transform is already on the context by
// the time any of them runs.

import { ctx, themeColor } from './dom.js';
import { state } from './state.js';

/**
 * Switches the dash pattern for a value that is not written locally.
 *
 * @param ghost whether the value is inherited or otherwise not the part's own.
 * @returns the alpha modifier to multiply the mark's opacity by.
 */
export function setGhost(ghost) {
    ctx.setLineDash(ghost ? [0.12, 0.08] : []);
    return ghost ? 0.5 : 1;
}

/** Fills one cell with a color, outlined so it reads against a sprite. */
export function fillCell(x, y, color, alpha, ghost) {
    const modifier = setGhost(ghost);
    ctx.globalAlpha = alpha * modifier;
    ctx.fillStyle = color;
    ctx.fillRect(x + 0.05, y + 0.05, 0.9, 0.9);
    ctx.globalAlpha = 0.9 * modifier;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2 / state.view.scale;
    ctx.strokeRect(x + 0.05, y + 0.05, 0.9, 0.9);
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
}

/** Draws a draggable point marker, larger on the layer being edited. */
export function drawPoint(x, y, color, active, ghost) {
    const modifier = setGhost(ghost);
    const radius = (active ? 7 : 5) / state.view.scale;
    ctx.globalAlpha = 0.95 * modifier;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = themeColor('--vscode-editor-background', '#1e1e1e');
    ctx.lineWidth = 1.5 / state.view.scale;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
}

/** Draws the arrow of one virtual-cell pair, from the external cell to the internal one. */
export function drawPairArrow(external, internal, color, active, ghost) {
    const modifier = setGhost(ghost);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.9 * modifier;
    ctx.lineWidth = (active ? 3 : 2) / state.view.scale;
    const x1 = external.x + 0.5;
    const y1 = external.y + 0.5;
    const x2 = internal.x + 0.5;
    const y2 = internal.y + 0.5;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x1, y1, 4 / state.view.scale, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x2, y2, 4 / state.view.scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
}

/** Draws a small text label in grid space, unmirrored whatever the view transform is. */
export function drawLabel(label, x, y) {
    ctx.save();
    ctx.translate(x, y);
    // Undo the view flip/rotation locally so text stays upright and readable.
    ctx.scale(state.view.flipH ? -1 : 1, state.view.flipV ? -1 : 1);
    ctx.rotate((-state.view.rotation * Math.PI) / 180);
    ctx.font = `${12 / state.view.scale}px sans-serif`;
    ctx.fillStyle = themeColor('--vscode-foreground', '#ddd');
    ctx.globalAlpha = 0.9;
    ctx.fillText(label, 0.1, 0.3);
    ctx.globalAlpha = 1;
    ctx.restore();
}
