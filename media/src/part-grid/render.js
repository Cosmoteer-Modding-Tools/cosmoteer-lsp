// One frame: the canvas is sized for the zoom, the view transform is put on the context, and then
// the sprites, the cell grid, every visible layer and the in-progress gesture draw in grid
// coordinates.

import { canvas, ctx, themeColor } from './dom.js';
import { fillCell } from './draw-primitives.js';
import { backingRatio } from './geometry.js';
import { LAYER_KINDS } from './layer-kinds.js';
import { canvasSize, gridCenter, gridExtent, layerColor, state } from './state.js';

/** Redraws the whole canvas from the current payload, view and selection. */
export function draw() {
    if (!state.data) return;
    const size = canvasSize();
    const dpr = backingRatio(size, window.devicePixelRatio || 1);
    canvas.width = size.width * dpr;
    canvas.height = size.height * dpr;
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // The full view transform: everything below draws in grid coordinates (cell units).
    ctx.setTransform(dpr, 0, 0, dpr, (size.width * dpr) / 2, (size.height * dpr) / 2);
    ctx.scale(state.view.scale, state.view.scale);
    ctx.rotate((state.view.rotation * Math.PI) / 180);
    ctx.scale(state.view.flipH ? -1 : 1, state.view.flipV ? -1 : 1);
    const center = gridCenter();
    ctx.translate(-center.x, -center.y);

    drawSprites();
    drawGrid();
    for (const layer of state.data.layers) {
        if (!state.visibleLayers.has(layer.id)) continue;
        drawLayer(layer, layer.id === state.activeLayerId);
    }
    drawGestures();
}

/** Draws the part's own sprites under the grid, each at the offset the payload gives it. */
function drawSprites() {
    for (const sprite of state.data.sprites) {
        if (!state.visibleSprites.has(sprite.id)) continue;
        const image = state.images.get(sprite.id);
        if (!image) continue;
        const size = sprite.size || [state.data.size.width, state.data.size.height];
        ctx.drawImage(image, sprite.offset[0], sprite.offset[1], size[0], size[1]);
    }
}

/** Draws the cell grid: a faint margin ring, the part's own cells, and the part outline. */
function drawGrid() {
    const { size } = state.data;
    const extent = gridExtent();
    const line = 1 / state.view.scale;
    // The margin ring: faint lines so out-of-part cells (door ring, virtual cells) are addressable.
    ctx.strokeStyle = themeColor('--vscode-editorLineNumber-foreground', '#666');
    ctx.globalAlpha = 0.25;
    ctx.lineWidth = line;
    for (let x = extent.minX; x <= extent.minX + extent.width; x++) {
        ctx.beginPath();
        ctx.moveTo(x, extent.minY);
        ctx.lineTo(x, extent.minY + extent.height);
        ctx.stroke();
    }
    for (let y = extent.minY; y <= extent.minY + extent.height; y++) {
        ctx.beginPath();
        ctx.moveTo(extent.minX, y);
        ctx.lineTo(extent.minX + extent.width, y);
        ctx.stroke();
    }
    // The part rect: strong outline plus solid cell lines.
    ctx.globalAlpha = 0.7;
    for (let x = 0; x <= size.width; x++) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, size.height);
        ctx.stroke();
    }
    for (let y = 0; y <= size.height; y++) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(size.width, y);
        ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = themeColor('--vscode-focusBorder', '#007fd4');
    ctx.lineWidth = line * 2;
    ctx.strokeRect(0, 0, size.width, size.height);
}

/**
 * Renders one layer through the `draw` member of its kind. A kind that declares none (or a
 * payload carrying a kind this page does not know) simply draws nothing.
 *
 * @param layer the layer to render.
 * @param active whether the layer is the one being edited, which renders it stronger.
 */
function drawLayer(layer, active) {
    const kind = LAYER_KINDS[layer.kind];
    if (kind && kind.draw) kind.draw(layer, layerColor(layer), active, layer.inherited);
}

/** In-progress gesture feedback: the pending external cell of a pair, the selected walls cell. */
function drawGestures() {
    if (state.pendingExternal) {
        fillCell(state.pendingExternal.x, state.pendingExternal.y, '#ffffff', 0.3, false);
    }
    if (state.selectedCell) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2.5 / state.view.scale;
        ctx.setLineDash([0.15, 0.1]);
        ctx.strokeRect(state.selectedCell.x + 0.02, state.selectedCell.y + 0.02, 0.96, 0.96);
        ctx.setLineDash([]);
    }
}
