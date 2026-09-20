// The conversation with the host: the sprite images that come with a render, the messages the host
// sends, and the two keyboard shortcuts the page answers itself.

import { setStatus, sidebar, vscode } from './dom.js';
import { countOf } from './layer-kinds.js';
import { applyLocally, pump, redo, undo, updateHistoryButtons } from './mutations.js';
import { draw } from './render.js';
import { renderSidebar } from './sidebar.js';
import { fitScale, state } from './state.js';
import { t } from '../shared/strings.js';

/** Registers the host message listener and the undo, redo and escape keys. */
export function initHost() {
    window.addEventListener('message', onHostMessage);
    window.addEventListener('keydown', onKeyDown);
}

/**
 * Loads the sprite images a render carries, keyed by sprite id.
 *
 * @param spriteData the inlined image URIs, absent when the host sent none.
 * @returns a promise that settles when every load has finished or failed.
 */
function loadSprites(spriteData) {
    state.images.clear();
    const loads = [];
    for (const sprite of state.data.sprites) {
        const uri = spriteData ? spriteData[sprite.id] : null;
        if (!uri) continue;
        loads.push(
            new Promise((resolve) => {
                const image = new Image();
                image.onload = () => {
                    state.images.set(sprite.id, image);
                    resolve(undefined);
                };
                image.onerror = () => resolve(undefined);
                image.src = uri;
            })
        );
    }
    return Promise.all(loads);
}

/** Dispatches one host message. */
function onHostMessage(event) {
    const message = event.data;
    if (!message) return;
    if (message.type === 'render') {
        onRender(message);
    } else if (message.type === 'empty') {
        state.data = null;
        sidebar.textContent = '';
        setStatus(t('No part found at this position.'));
    } else if (message.type === 'editDone') {
        if (typeof message.dataVersion === 'number' && state.data) state.data.dataVersion = message.dataVersion;
        state.inFlight = false;
        pump();
    } else if (message.type === 'note') {
        // A write that followed a reference says where it landed, since the number it changed is
        // read somewhere other than the handle that was dragged.
        setStatus(message.note);
    } else if (message.type === 'editRejected') {
        state.inFlight = false;
        state.queue.length = 0;
        // The document moved on under the recorded history, its inverses no longer apply.
        state.undoStack.length = 0;
        state.redoStack.length = 0;
        updateHistoryButtons();
        setStatus(t('Edit rejected ({0}). Resyncing…', message.reason));
        vscode.postMessage({ type: 'refresh' });
    }
}

/**
 * Takes a fresh payload: the first one decides what starts visible and at which zoom, and every one
 * of them is authoritative over the optimistic echo of the edits still in flight.
 *
 * @param message the render message.
 */
function onRender(message) {
    const firstRender = !state.data;
    state.data = message.data;
    if (firstRender) openFirstPayload();
    // A render is authoritative and carries a fresh dataVersion, so queued clicks (absolute
    // coordinates by design) resume against it instead of being judged stale. Re-apply their
    // optimistic echo on top of the authoritative payload so the UI keeps reflecting them.
    state.inFlight = false;
    for (const pending of state.queue) applyLocally(pending);
    // The render runs in a promise continuation, so a throw in a renderer would otherwise
    // be an unhandled rejection: the page would keep the picture it already had, the
    // sidebar would still read correctly, and nothing would say the panel had gone stale.
    // Catching it here turns a silent staleness into a message the author can act on.
    void loadSprites(message.spriteData)
        .then(() => {
            renderSidebar();
            draw();
        })
        .catch((error) => {
            setStatus(t('This part could not be drawn. Reopen the editor to try again.'));
            console.error(error);
        })
        // Draining the queue is not part of drawing. A throw in a renderer would otherwise
        // strand the clicks made while the last edit was in flight: the canvas echoes them
        // optimistically and the host would never be told about them.
        .finally(() => {
            pump();
        });
}

/** What the first payload settles: the visible sprites and layers, the edited layer, and the zoom. */
function openFirstPayload() {
    for (const sprite of state.data.sprites) {
        if (sprite.defaultVisible) state.visibleSprites.add(sprite.id);
    }
    for (const layer of state.data.layers) {
        if (countOf(layer)) state.visibleLayers.add(layer.id);
    }
    const first = state.data.layers.find((layer) => layer.id === 'AllowedDoorLocations');
    state.activeLayerId = first ? first.id : state.data.layers[0] && state.data.layers[0].id;
    if (state.activeLayerId) state.visibleLayers.add(state.activeLayerId);
    state.view.scale = fitScale();
}

/** The keys the page answers itself: undo, redo, and escape to drop every pending selection. */
function onKeyDown(event) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        redo();
        return;
    }
    if (event.key === 'Escape') {
        state.pendingExternal = null;
        state.selectedCell = null;
        state.selectedComponent = null;
        setStatus('');
        renderSidebar();
        draw();
    }
}
