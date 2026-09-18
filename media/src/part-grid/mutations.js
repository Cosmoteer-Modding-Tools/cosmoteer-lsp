// The edit pipeline: a mutation is recorded for undo, mirrored onto the local payload so the canvas
// reacts instantly, queued, and sent to the host one at a time. The next render the host sends is
// authoritative and replaces whatever the optimistic apply left behind.

import { HISTORY_LIMIT } from './constants.js';
import { vscode } from './dom.js';
import { numberMemberOf, pointMemberOf } from './layer-kinds.js';
import { draw } from './render.js';
import { renderSidebar } from './sidebar.js';
import { state } from './state.js';
import { inverseOf } from './undo.js';

/**
 * Queues a mutation, applies it optimistically, and sends it when the previous one is done.
 * User actions record their inverse for undo before the optimistic apply changes the state;
 * undo/redo replays skip that so history is not re-recorded.
 *
 * @param mutation the mutation to send.
 * @param options `skipHistory` for a replay that must not be recorded again.
 */
export function sendMutation(mutation, options) {
    if (!options || !options.skipHistory) {
        const inverse = inverseOf(mutation, state.data);
        if (inverse) {
            state.undoStack.push({ forward: mutation, inverse });
            if (state.undoStack.length > HISTORY_LIMIT) state.undoStack.shift();
        } else {
            // A mutation whose prior state cannot be restored breaks the chain, better an
            // empty history than a wrong one.
            state.undoStack.length = 0;
        }
        state.redoStack.length = 0;
    }
    applyLocally(mutation);
    state.queue.push(mutation);
    pump();
    updateHistoryButtons();
    draw();
}

/** Reverts the most recent action by replaying its recorded inverse. */
export function undo() {
    const entry = state.undoStack.pop();
    if (!entry) return;
    state.redoStack.push(entry);
    sendMutation(entry.inverse, { skipHistory: true });
    renderSidebar();
}

/** Re-applies the most recently undone action. */
export function redo() {
    const entry = state.redoStack.pop();
    if (!entry) return;
    state.undoStack.push(entry);
    sendMutation(entry.forward, { skipHistory: true });
    renderSidebar();
}

/** Refreshes the enabled state of the history buttons without rebuilding the sidebar. */
export function updateHistoryButtons() {
    const undoButton = /** @type {HTMLButtonElement} */ (document.getElementById('undo-button'));
    const redoButton = /** @type {HTMLButtonElement} */ (document.getElementById('redo-button'));
    if (undoButton) undoButton.disabled = !state.undoStack.length;
    if (redoButton) redoButton.disabled = !state.redoStack.length;
}

/** Sends the next queued mutation, unless one is already in flight or there is no payload. */
export function pump() {
    if (state.inFlight || !state.queue.length || !state.data) return;
    state.inFlight = true;
    vscode.postMessage({ type: 'edit', mutation: state.queue.shift(), dataVersion: state.data.dataVersion });
}

/**
 * Mirrors a mutation onto the local payload so the UI reacts instantly; the next render is
 * authoritative.
 *
 * @param mutation the mutation to apply.
 */
export function applyLocally(mutation) {
    const layer = state.data.layers.find((candidate) => candidate.id === mutation.layerId);
    const localOrigin = { uri: '', range: null, inherited: false };
    if (mutation.op === 'addCell' && layer) {
        layer.cells = layer.cells.concat([{ cell: mutation.cell, origin: localOrigin }]);
    } else if (mutation.op === 'removeCell' && layer) {
        layer.cells = layer.cells.filter(({ cell }) => cell.x !== mutation.cell.x || cell.y !== mutation.cell.y);
    } else if (mutation.op === 'setEntryValues' && layer) {
        layer.entries = layer.entries.filter(({ cell }) => cell.x !== mutation.cell.x || cell.y !== mutation.cell.y);
        if (mutation.values.length) {
            layer.entries = layer.entries.concat([
                { cell: mutation.cell, values: mutation.values, origin: localOrigin },
            ]);
        }
    } else if (mutation.op === 'addPoint' && layer) {
        layer.points = layer.points.concat([{ point: mutation.point, origin: localOrigin }]);
    } else if (mutation.op === 'movePoint' && layer && layer.points[mutation.index]) {
        layer.points[mutation.index] = { point: mutation.point, origin: localOrigin };
    } else if (mutation.op === 'removePoint' && layer) {
        layer.points = layer.points.filter((_, index) => index !== mutation.index);
    } else if (mutation.op === 'setPair' && layer) {
        const pair = { external: mutation.external, internal: mutation.internal, origin: localOrigin };
        if (mutation.index === null) layer.pairs = layer.pairs.concat([pair]);
        else if (layer.pairs[mutation.index]) layer.pairs[mutation.index] = pair;
    } else if (mutation.op === 'removePair' && layer) {
        layer.pairs = layer.pairs.filter((_, index) => index !== mutation.index);
    } else if (mutation.op === 'setRect' && layer) {
        layer.rect = mutation.rect;
    } else if (mutation.op === 'setSize') {
        state.data.size = Object.assign({}, state.data.size, mutation.size);
    } else if (mutation.op === 'setBool') {
        const key = mutation.field === 'IsRotateable' ? 'isRotateable' : 'isFlippable';
        state.data.rotation[key] = { value: mutation.value, origin: state.data.rotation[key].origin };
    } else if (mutation.op === 'setPoint' && layer) {
        pointMemberOf(layer).write(layer, mutation.point);
    } else if (mutation.op === 'setCell' && layer) {
        layer.cell = mutation.cell;
    } else if (mutation.op === 'setDirection' && layer) {
        layer.direction = mutation.direction;
    } else if (mutation.op === 'setNumber' && layer) {
        numberMemberOf(layer).write(layer, mutation.value);
    } else if (mutation.op === 'moveVertex' && layer && layer.vertices[mutation.index]) {
        layer.vertices[mutation.index] = { point: mutation.point, origin: localOrigin };
    } else if (mutation.op === 'insertVertex' && layer) {
        layer.vertices = layer.vertices
            .slice(0, mutation.index)
            .concat([{ point: mutation.point, origin: localOrigin }], layer.vertices.slice(mutation.index));
    } else if (mutation.op === 'removeVertex' && layer) {
        layer.vertices = layer.vertices.filter((_, index) => index !== mutation.index);
    } else if (mutation.op === 'setRectEntry' && layer) {
        applyRectEntry(layer, mutation, localOrigin);
    } else if (mutation.op === 'removeRectEntry' && layer) {
        layer.entries = layer.entries.filter((_, index) => index !== mutation.index);
    } else if (mutation.op === 'moveComponentLocation') {
        const gizmo = state.data.layers.find((candidate) => candidate.kind === 'componentPoints');
        const entry = gizmo && gizmo.entries.find((candidate) => candidate.component === mutation.component);
        // Unchained markers follow the drop directly. Chained ones wait for the render.
        if (entry && !entry.chainedTo) entry.location = mutation.point;
    } else if (mutation.op === 'setComponentRotation') {
        const gizmo = state.data.layers.find((candidate) => candidate.kind === 'componentPoints');
        const entry = gizmo && gizmo.entries.find((candidate) => candidate.component === mutation.component);
        if (entry) entry.rotationDeg = mutation.degrees;
    } else if (mutation.op === 'setFlags') {
        state.data.contiguity = Object.assign({}, state.data.contiguity, { values: mutation.values });
    }
}

/**
 * Appends or replaces one entry of a rect list. A replacement with no tag keeps the tag the entry
 * already had, since the drag that moved it never named one.
 *
 * @param layer the rect-list layer.
 * @param mutation the `setRectEntry` mutation.
 * @param localOrigin the provenance stamp a locally written value carries.
 */
function applyRectEntry(layer, mutation, localOrigin) {
    const entry = { tag: mutation.tag, rect: mutation.rect, origin: localOrigin };
    if (mutation.index === null) layer.entries = layer.entries.concat([entry]);
    else if (layer.entries[mutation.index]) {
        layer.entries[mutation.index] = {
            tag: mutation.tag || layer.entries[mutation.index].tag,
            rect: mutation.rect,
            origin: localOrigin,
        };
    }
}
