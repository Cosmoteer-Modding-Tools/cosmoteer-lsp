// @ts-nocheck
// The part grid editor webview: renders a part's sprites split into the in-game cell grid and lets
// the user author per-cell fields (door locations, blocked travel cells, walls, crew destinations,
// virtual cells, rects) by clicking instead of typing coordinates. IDE-agnostic: VS Code provides
// acquireVsCodeApi natively, the JetBrains plugin shims it and replays host messages as
// MessageEvents after the page posts {type:'ready'}.
//
// Coordinate convention (verified against the game): cell (0,0) is the top-left of the unrotated
// part, X grows right, Y grows down; AdjacencyFlags Top is the -Y edge; TravelDirection Up is -Y.
(function () {
    'use strict';

    // ---------------------------------------------------------------------------------------------
    // Pure geometry, exported for Node unit tests (no DOM below this block is touched when imported).
    // ---------------------------------------------------------------------------------------------

    /** Rotates a vector by a clockwise quarter-turn multiple in y-down screen space. */
    function rotateQuarter(x, y, rotation) {
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
    function gridToStage(x, y, view, center) {
        let dx = x - center.x;
        let dy = y - center.y;
        if (view.flipH) dx = -dx;
        if (view.flipV) dy = -dy;
        return rotateQuarter(dx, dy, view.rotation);
    }

    /** Maps stage coordinates back to the grid point they came from (inverse of gridToStage). */
    function stageToGrid(sx, sy, view, center) {
        const [ux, uy] = rotateQuarter(sx, sy, 360 - view.rotation);
        const dx = view.flipH ? -ux : ux;
        const dy = view.flipV ? -uy : uy;
        return [dx + center.x, dy + center.y];
    }

    /** Snaps a value to a step (a step of 0 keeps it free). */
    function snapTo(value, step) {
        if (!step) return Math.round(value * 1000) / 1000;
        return Math.round(value / step) * step;
    }

    /** The edge/corner of AdjacencyFlags a within-cell position points at (fractions 0..1). */
    function adjacencyAt(fx, fy) {
        const column = fx < 1 / 3 ? 0 : fx < 2 / 3 ? 1 : 2;
        const row = fy < 1 / 3 ? 0 : fy < 2 / 3 ? 1 : 2;
        const table = [
            ['TopLeft', 'Top', 'TopRight'],
            ['Left', null, 'Right'],
            ['BottomLeft', 'Bottom', 'BottomRight'],
        ];
        return table[row][column];
    }

    /**
     * The edge of an outside door cell that faces the part's physical rect, where the door itself
     * sits (verified against cannon_med: door cells attach to PhysicalRect, not the full Size).
     * Returns null when the cell is inside the rect or not side-adjacent to it (such an entry
     * never matches a door in game).
     */
    function doorEdgeFor(cell, rect) {
        const inside = (x, y) => x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
        if (inside(cell.x, cell.y)) return null;
        if (inside(cell.x - 1, cell.y)) return 'Left';
        if (inside(cell.x + 1, cell.y)) return 'Right';
        if (inside(cell.x, cell.y - 1)) return 'Top';
        if (inside(cell.x, cell.y + 1)) return 'Bottom';
        return null;
    }

    /** The unit offset a TravelDirection points at (y-down grid space). */
    function directionOffset(name) {
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
    function rotateDegrees(x, y, degrees) {
        const radians = (degrees * Math.PI) / 180;
        const cos = Math.cos(radians);
        const sin = Math.sin(radians);
        return [x * cos - y * sin, x * sin + y * cos];
    }

    /** The total chain transform feeding a component, walked over the gizmo layer's entries. */
    function chainParentTransform(layer, entry) {
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
    function rotationKeyOf(field) {
        return { FlipHRotate: 'flipHRotate', FlipVRotate: 'flipVRotate', SelectionTypeRotations: 'selectionTypeRotations' }[field];
    }

    /**
     * The mutation that exactly reverts `mutation`, computed against the payload state BEFORE the
     * mutation is applied. This is the command-pattern half of undo: the inverse replays through
     * the normal edit pipeline, so stale protection and inherited-field materialization still
     * apply. Returns null for a mutation whose prior state cannot be restored (history is cleared
     * then, rather than kept wrong).
     */
    function inverseOf(mutation, data) {
        const layer = data.layers.find((candidate) => candidate.id === mutation.layerId);
        const clonePoint = (point) => (point ? { x: point.x, y: point.y } : null);
        const cloneRect = (rect) => (rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null);
        switch (mutation.op) {
            case 'addCell':
                return { op: 'removeCell', layerId: mutation.layerId, cell: mutation.cell };
            case 'removeCell':
                return { op: 'addCell', layerId: mutation.layerId, cell: mutation.cell };
            case 'setEntryValues': {
                const entry =
                    layer && layer.entries.find(({ cell }) => cell.x === mutation.cell.x && cell.y === mutation.cell.y);
                return {
                    op: 'setEntryValues',
                    layerId: mutation.layerId,
                    cell: mutation.cell,
                    values: entry ? entry.values.slice() : [],
                };
            }
            case 'addPoint':
                return { op: 'removePoint', layerId: mutation.layerId, index: layer ? layer.points.length : 0 };
            case 'movePoint': {
                const old = layer && layer.points[mutation.index];
                return old ? { op: 'movePoint', layerId: mutation.layerId, index: mutation.index, point: clonePoint(old.point) } : null;
            }
            case 'removePoint': {
                const old = layer && layer.points[mutation.index];
                // The undo appends the point again, its list position may differ from the original.
                return old ? { op: 'addPoint', layerId: mutation.layerId, point: clonePoint(old.point) } : null;
            }
            case 'setPair': {
                if (mutation.index === null) {
                    return { op: 'removePair', layerId: mutation.layerId, index: layer ? layer.pairs.length : 0 };
                }
                const old = layer && layer.pairs[mutation.index];
                return old
                    ? {
                          op: 'setPair',
                          layerId: mutation.layerId,
                          index: mutation.index,
                          external: clonePoint(old.external),
                          internal: clonePoint(old.internal),
                      }
                    : null;
            }
            case 'removePair': {
                const old = layer && layer.pairs[mutation.index];
                return old
                    ? {
                          op: 'setPair',
                          layerId: mutation.layerId,
                          index: null,
                          external: clonePoint(old.external),
                          internal: clonePoint(old.internal),
                      }
                    : null;
            }
            case 'setRect':
                return layer ? { op: 'setRect', layerId: mutation.layerId, rect: cloneRect(layer.rect) } : null;
            case 'setSize':
                return { op: 'setSize', size: { width: data.size.width, height: data.size.height } };
            case 'setBool': {
                const key = mutation.field === 'IsRotateable' ? 'isRotateable' : 'isFlippable';
                return { op: 'setBool', field: mutation.field, value: data.rotation[key].value };
            }
            case 'setIntList': {
                const old = data.rotation[rotationKeyOf(mutation.field)];
                return { op: 'setIntList', field: mutation.field, values: old ? old.values.slice() : null };
            }
            case 'setPoint': {
                if (!layer) return null;
                const old = layer.kind === 'circle' ? layer.center : layer.point;
                return { op: 'setPoint', layerId: mutation.layerId, point: clonePoint(old) };
            }
            case 'setCell':
                return layer ? { op: 'setCell', layerId: mutation.layerId, cell: clonePoint(layer.cell) } : null;
            case 'setDirection':
                if (!layer) return null;
                // A previously unset facing undoes by removing the Direction member outright.
                return layer.direction
                    ? { op: 'setDirection', layerId: mutation.layerId, direction: layer.direction }
                    : { op: 'setNumber', layerId: mutation.layerId, field: 'Direction', value: null };
            case 'setNumber': {
                if (!layer) return null;
                const old = layer.kind === 'circle' ? layer.radius : layer.kind === 'cellRay' ? layer.maxTiles : null;
                return { op: 'setNumber', layerId: mutation.layerId, field: mutation.field, value: old };
            }
            case 'moveVertex': {
                const old = layer && layer.vertices[mutation.index];
                return old
                    ? { op: 'moveVertex', layerId: mutation.layerId, index: mutation.index, point: clonePoint(old.point) }
                    : null;
            }
            case 'insertVertex':
                return { op: 'removeVertex', layerId: mutation.layerId, index: mutation.index };
            case 'removeVertex': {
                const old = layer && layer.vertices[mutation.index];
                return old
                    ? { op: 'insertVertex', layerId: mutation.layerId, index: mutation.index, point: clonePoint(old.point) }
                    : null;
            }
            case 'setRectEntry': {
                if (mutation.index === null) {
                    return { op: 'removeRectEntry', layerId: mutation.layerId, index: layer ? layer.entries.length : 0 };
                }
                const old = layer && layer.entries[mutation.index];
                return old
                    ? {
                          op: 'setRectEntry',
                          layerId: mutation.layerId,
                          index: mutation.index,
                          tag: old.tag,
                          rect: cloneRect(old.rect),
                      }
                    : null;
            }
            case 'removeRectEntry': {
                const old = layer && layer.entries[mutation.index];
                return old
                    ? { op: 'setRectEntry', layerId: mutation.layerId, index: null, tag: old.tag, rect: cloneRect(old.rect) }
                    : null;
            }
            case 'moveComponentLocation': {
                const gizmo = data.layers.find((candidate) => candidate.kind === 'componentPoints');
                const entry = gizmo && gizmo.entries.find((candidate) => candidate.component === mutation.component);
                if (!entry || !entry.location) return null;
                const parent = entry.chainedTo ? chainParentTransform(gizmo, entry) : null;
                if (!parent) return { op: 'moveComponentLocation', component: mutation.component, point: clonePoint(entry.location) };
                const [ox, oy] = rotateDegrees(
                    entry.location.x - parent.location.x,
                    entry.location.y - parent.location.y,
                    -parent.rotation
                );
                return { op: 'moveComponentLocation', component: mutation.component, point: { x: ox, y: oy } };
            }
            case 'setComponentRotation': {
                const gizmo = data.layers.find((candidate) => candidate.kind === 'componentPoints');
                const entry = gizmo && gizmo.entries.find((candidate) => candidate.component === mutation.component);
                return entry
                    ? { op: 'setComponentRotation', component: mutation.component, degrees: entry.rotationDeg }
                    : null;
            }
            case 'setFlags':
                return {
                    op: 'setFlags',
                    field: mutation.field,
                    values: data.contiguity && data.contiguity.values ? data.contiguity.values.slice() : null,
                };
            default:
                return null;
        }
    }

    if (typeof module !== 'undefined' && typeof acquireVsCodeApi === 'undefined') {
        module.exports = {
            rotateQuarter,
            gridToStage,
            stageToGrid,
            snapTo,
            adjacencyAt,
            directionOffset,
            rotateDegrees,
            chainParentTransform,
            inverseOf,
            doorEdgeFor,
        };
        return;
    }

    // ---------------------------------------------------------------------------------------------
    // Webview runtime.
    // ---------------------------------------------------------------------------------------------

    const vscode = acquireVsCodeApi();
    const canvas = document.getElementById('grid');
    const ctx = canvas.getContext('2d');
    const statusEl = document.getElementById('status');
    const sidebar = document.getElementById('sidebar');

    const state = {
        data: null,
        images: new Map(),
        view: { rotation: 0, flipH: false, flipV: false, scale: 96 },
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

    /** The most history entries kept, oldest dropped beyond it. */
    const HISTORY_LIMIT = 100;

    // ------------------------------------------------------------------ mutation queue

    /**
     * Queues a mutation, applies it optimistically, and sends it when the previous one is done.
     * User actions record their inverse for undo before the optimistic apply changes the state;
     * undo/redo replays skip that so history is not re-recorded.
     */
    function sendMutation(mutation, options) {
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
    function undo() {
        const entry = state.undoStack.pop();
        if (!entry) return;
        state.redoStack.push(entry);
        sendMutation(entry.inverse, { skipHistory: true });
        renderSidebar();
    }

    /** Re-applies the most recently undone action. */
    function redo() {
        const entry = state.redoStack.pop();
        if (!entry) return;
        state.undoStack.push(entry);
        sendMutation(entry.forward, { skipHistory: true });
        renderSidebar();
    }

    /** Refreshes the enabled state of the history buttons without rebuilding the sidebar. */
    function updateHistoryButtons() {
        const undoButton = document.getElementById('undo-button');
        const redoButton = document.getElementById('redo-button');
        if (undoButton) undoButton.disabled = !state.undoStack.length;
        if (redoButton) redoButton.disabled = !state.redoStack.length;
    }

    function pump() {
        if (state.inFlight || !state.queue.length || !state.data) return;
        state.inFlight = true;
        vscode.postMessage({ type: 'edit', mutation: state.queue.shift(), dataVersion: state.data.dataVersion });
    }

    /** Mirrors a mutation onto the local payload so the UI reacts instantly; the next render is authoritative. */
    function applyLocally(mutation) {
        const layer = state.data.layers.find((candidate) => candidate.id === mutation.layerId);
        const localOrigin = { uri: '', range: null, inherited: false };
        if (mutation.op === 'addCell' && layer) {
            layer.cells = layer.cells.concat([{ cell: mutation.cell, origin: localOrigin }]);
        } else if (mutation.op === 'removeCell' && layer) {
            layer.cells = layer.cells.filter(({ cell }) => cell.x !== mutation.cell.x || cell.y !== mutation.cell.y);
        } else if (mutation.op === 'setEntryValues' && layer) {
            layer.entries = layer.entries.filter(
                ({ cell }) => cell.x !== mutation.cell.x || cell.y !== mutation.cell.y
            );
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
            if (layer.kind === 'circle') layer.center = mutation.point;
            else layer.point = mutation.point;
        } else if (mutation.op === 'setCell' && layer) {
            layer.cell = mutation.cell;
        } else if (mutation.op === 'setDirection' && layer) {
            layer.direction = mutation.direction;
        } else if (mutation.op === 'setNumber' && layer) {
            if (layer.kind === 'circle') layer.radius = mutation.value;
            else if (layer.kind === 'cellRay') layer.maxTiles = mutation.value;
        } else if (mutation.op === 'moveVertex' && layer && layer.vertices[mutation.index]) {
            layer.vertices[mutation.index] = { point: mutation.point, origin: localOrigin };
        } else if (mutation.op === 'insertVertex' && layer) {
            layer.vertices = layer.vertices
                .slice(0, mutation.index)
                .concat([{ point: mutation.point, origin: localOrigin }], layer.vertices.slice(mutation.index));
        } else if (mutation.op === 'removeVertex' && layer) {
            layer.vertices = layer.vertices.filter((_, index) => index !== mutation.index);
        } else if (mutation.op === 'setRectEntry' && layer) {
            const entry = { tag: mutation.tag, rect: mutation.rect, origin: localOrigin };
            if (mutation.index === null) layer.entries = layer.entries.concat([entry]);
            else if (layer.entries[mutation.index]) {
                layer.entries[mutation.index] = {
                    tag: mutation.tag || layer.entries[mutation.index].tag,
                    rect: mutation.rect,
                    origin: localOrigin,
                };
            }
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

    // ------------------------------------------------------------------ view helpers

    function gridExtent() {
        const { size, margin } = state.data;
        return {
            minX: -margin,
            minY: -margin,
            width: size.width + 2 * margin,
            height: size.height + 2 * margin,
        };
    }

    function gridCenter() {
        return { x: state.data.size.width / 2, y: state.data.size.height / 2 };
    }

    /** The canvas pixel size for the current view (stage extents swap on quarter rotations). */
    function canvasSize() {
        const extent = gridExtent();
        const swapped = state.view.rotation === 90 || state.view.rotation === 270;
        return {
            width: (swapped ? extent.height : extent.width) * state.view.scale,
            height: (swapped ? extent.width : extent.height) * state.view.scale,
        };
    }

    /** Converts a mouse event to grid coordinates through the inverse view transform. */
    function eventToGrid(event) {
        const bounds = canvas.getBoundingClientRect();
        const sx = (event.clientX - bounds.left - bounds.width / 2) / state.view.scale;
        const sy = (event.clientY - bounds.top - bounds.height / 2) / state.view.scale;
        const [x, y] = stageToGrid(sx, sy, state.view, gridCenter());
        return { x, y };
    }

    // ------------------------------------------------------------------ colors

    function themeColor(name, fallback) {
        const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
        return value || fallback;
    }

    const LAYER_COLORS = {
        AllowedDoorLocations: '#4fc1ff',
        BlockedTravelCells: '#f14c4c',
        BlockedTravelCellDirections: '#ff8800',
        ExternalWallsByCell: '#73c991',
        InternalWallsByCell: '#c586c0',
        BlueprintExternalWallsByCell: '#2aa198',
        BlueprintInternalWallsByCell: '#b58900',
        VirtualInternalCells: '#dcdcaa',
        PhysicalRect: '#569cd6',
        SaveRect: '#9cdcfe',
        ProhibitRects: '#e06c75',
        GridRect: '#61afef',
        DisableCells: '#be5046',
        BuffArea: '#98c379',
        BuffCenter: '#98c379',
        Vertices: '#e5c07b',
        CustomCollider: '#e5c07b',
        Line: '#56b6c2',
        PartLocation: '#d19a66',
        AdjacentCell: '#d19a66',
        NewPartLocation: '#d19a66',
        PartNetworkOverlayMidpoint: '#61afef',
        ComponentLocations: '#ff79c6',
    };

    const KIND_COLORS = {
        pointList: '#ffd700',
        point: '#7ec699',
        cell: '#d19a66',
        cellDirection: '#61afef',
        cellRay: '#56b6c2',
        polygon: '#e5c07b',
        circle: '#98c379',
        rectList: '#e06c75',
        componentPoints: '#ff79c6',
    };

    function layerColor(layer) {
        return LAYER_COLORS[layer.fieldName] || KIND_COLORS[layer.kind] || '#4fc1ff';
    }

    // ------------------------------------------------------------------ rendering

    function draw() {
        if (!state.data) return;
        const dpr = window.devicePixelRatio || 1;
        const size = canvasSize();
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

    function drawSprites() {
        for (const sprite of state.data.sprites) {
            if (!state.visibleSprites.has(sprite.id)) continue;
            const image = state.images.get(sprite.id);
            if (!image) continue;
            const size = sprite.size || [state.data.size.width, state.data.size.height];
            ctx.drawImage(image, sprite.offset[0], sprite.offset[1], size[0], size[1]);
        }
    }

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

    function drawLayer(layer, active) {
        const color = layerColor(layer);
        const ghost = layer.inherited;
        if (layer.kind === 'cellSet') {
            if (layer.domain === 'outside') {
                drawDoorCells(layer, color, active);
            } else {
                const base = layer.baseCell || { x: 0, y: 0 };
                for (const { cell, origin } of layer.cells) {
                    fillCell(base.x + cell.x, base.y + cell.y, color, active ? 0.45 : 0.25, ghost || origin.inherited);
                }
            }
        } else if (layer.kind === 'point') {
            if (layer.point) drawPoint(layer.point.x, layer.point.y, color, active, ghost);
        } else if (layer.kind === 'cell') {
            if (layer.cell) fillCell(layer.cell.x, layer.cell.y, color, active ? 0.45 : 0.25, ghost);
        } else if (layer.kind === 'cellDirection') {
            drawCellDirection(layer, color, active, ghost);
        } else if (layer.kind === 'cellRay') {
            drawCellRay(layer, color, active, ghost);
        } else if (layer.kind === 'polygon') {
            drawPolygon(layer, color, active, ghost);
        } else if (layer.kind === 'circle') {
            drawCircle(layer, color, active, ghost);
        } else if (layer.kind === 'rectList') {
            drawRectList(layer, color, active, ghost);
        } else if (layer.kind === 'componentPoints') {
            drawComponentPoints(layer, color, active);
        } else if (layer.kind === 'cellToValues') {
            if (layer.valueModel === 'flags') drawWallEntries(layer, color, active);
            else drawDirectionEntries(layer, color, active);
        } else if (layer.kind === 'pointList') {
            for (const { point, origin } of layer.points) {
                drawPoint(point.x, point.y, color, active, ghost || origin.inherited);
            }
        } else if (layer.kind === 'cellPairList') {
            for (const { external, internal, origin } of layer.pairs) {
                drawPairArrow(external, internal, color, active, ghost || origin.inherited);
            }
        } else if (layer.kind === 'rect' && layer.rect) {
            drawRect(layer, color, active, ghost);
        }
    }

    function setGhost(ghost) {
        ctx.setLineDash(ghost ? [0.12, 0.08] : []);
        return ghost ? 0.5 : 1;
    }

    function fillCell(x, y, color, alpha, ghost) {
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

    /** Expands the AdjacencyFlags composites into their edge/corner members for rendering. */
    function expandAdjacency(values) {
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

    function drawPoint(x, y, color, active, ghost) {
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

    function drawPairArrow(external, internal, color, active, ghost) {
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

    function drawRect(layer, color, active, ghost) {
        const modifier = setGhost(ghost);
        const rect = state.rectDrag && state.rectDrag.layerId === layer.id ? state.rectDrag.rect : layer.rect;
        ctx.globalAlpha = 0.9 * modifier;
        ctx.strokeStyle = color;
        ctx.lineWidth = (active ? 3 : 2) / state.view.scale;
        ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
        if (active) {
            ctx.fillStyle = color;
            for (const [hx, hy] of rectHandles(rect)) {
                ctx.fillRect(hx - 0.08, hy - 0.08, 0.16, 0.16);
            }
        }
        ctx.globalAlpha = 1;
        ctx.setLineDash([]);
    }

    function rectHandles(rect) {
        return [
            [rect.x, rect.y],
            [rect.x + rect.width, rect.y],
            [rect.x + rect.width, rect.y + rect.height],
            [rect.x, rect.y + rect.height],
        ];
    }

    /** Maps an AdjacencyFlags edge name to the orthogonal direction it faces. */
    function edgeToDirection(edge) {
        return { Top: 'Up', Right: 'Right', Bottom: 'Down', Left: 'Left' }[edge] || null;
    }

    /** The part's effective physical rect, which doors attach to (the full size when unset). */
    function physicalRectOf() {
        const layer = state.data.layers.find(
            (candidate) => candidate.kind === 'rect' && candidate.fieldName === 'PhysicalRect'
        );
        return (layer && layer.rect) || { x: 0, y: 0, width: state.data.size.width, height: state.data.size.height };
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
                // Reference-valued vertices render hollow: visible, but not draggable.
                if (isRef) ctx.stroke();
                else ctx.fill();
            }
        }
        ctx.globalAlpha = 1;
        ctx.setLineDash([]);
    }

    function drawCircle(layer, color, active, ghost) {
        const center = layer.center || { x: state.data.size.width / 2, y: state.data.size.height / 2 };
        const modifier = setGhost(ghost || !layer.center);
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = (active ? 3 : 2) / state.view.scale;
        if (layer.radius) {
            ctx.globalAlpha = 0.12 * modifier;
            ctx.beginPath();
            ctx.arc(center.x, center.y, layer.radius, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 0.8 * modifier;
            ctx.stroke();
        }
        drawPoint(center.x, center.y, color, active, ghost || !layer.center);
        if (active && layer.radius) {
            ctx.globalAlpha = 0.95;
            ctx.fillRect(center.x + layer.radius - 0.08, center.y - 0.08, 0.16, 0.16);
        }
        ctx.globalAlpha = 1;
        ctx.setLineDash([]);
    }

    function drawRectList(layer, color, active, ghost) {
        const modifier = setGhost(ghost);
        ctx.lineWidth = (active ? 3 : 2) / state.view.scale;
        for (const [index, entry] of layer.entries.entries()) {
            const dragging =
                state.rectDrag && state.rectDrag.layerId === layer.id && state.rectDrag.entryIndex === index;
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
                drawLabel(`${stack.length} components (click to cycle)`, anchor.x, anchor.y + 0.12);
                continue;
            }
            const shown = stack.length > 3 ? [selectedEntry] : stack;
            for (const [index, entry] of shown.entries()) {
                const marker = entry.component === state.selectedComponent ? '▸ ' : '';
                drawLabel(`${marker}${entry.label}`, anchor.x, anchor.y + 0.12 + index * lineStep);
            }
        }
    }

    /** Draws a small text label in grid space, unmirrored whatever the view transform is. */
    function drawLabel(label, x, y) {
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

    // ------------------------------------------------------------------ interactions

    function activeLayer() {
        return state.data ? state.data.layers.find((layer) => layer.id === state.activeLayerId) : null;
    }

    canvas.addEventListener('contextmenu', (event) => event.preventDefault());

    /** The index of the vertex nearest the point within a hit radius, or -1. */
    function vertexIndexAt(layer, point) {
        const radius = 10 / state.view.scale;
        for (let index = 0; index < layer.vertices.length; index++) {
            const { point: p } = layer.vertices[index];
            if (Math.hypot(p.x - point.x, p.y - point.y) <= radius) return index;
        }
        return -1;
    }

    /** The segment index whose edge passes near the point (for vertex insertion), or -1. */
    function polygonEdgeAt(layer, point) {
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

    /** The rect-list entry whose handle sits at the point: { index, handle }, or null. */
    function rectListHandleAt(layer, point) {
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
    function componentEntryAt(layer, point) {
        const radius = 12 / state.view.scale;
        const hits = layer.entries.filter(
            (entry) => entry.location && Math.hypot(entry.location.x - point.x, entry.location.y - point.y) <= radius
        );
        if (!hits.length) return null;
        const current = hits.findIndex((entry) => entry.component === state.selectedComponent);
        return hits[(current + 1) % hits.length];
    }

    /** The total chain rotation feeding a component, so a drag can invert the chain transform. */
    function chainParentTransform(layer, entry) {
        if (!entry.chainedTo) return null;
        const byName = new Map(layer.entries.map((candidate) => [candidate.component, candidate]));
        let rotation = 0;
        let current = byName.get(entry.chainedTo);
        const visited = new Set();
        let location = current && current.location ? current.location : { x: 0, y: 0 };
        while (current && !visited.has(current.component)) {
            visited.add(current.component);
            rotation += current.rotationDeg || 0;
            current = current.chainedTo ? byName.get(current.chainedTo) : null;
        }
        return { location, rotation };
    }

    canvas.addEventListener('mousedown', (event) => {
        if (!state.data) return;
        const layer = activeLayer();
        if (!layer) return;
        const point = eventToGrid(event);
        const cell = { x: Math.floor(point.x), y: Math.floor(point.y) };
        if (layer.kind === 'point') {
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
        } else if (layer.kind === 'cell') {
            if (event.button === 2) {
                if (layer.cell) sendMutation({ op: 'setCell', layerId: layer.id, cell: null });
                return;
            }
            sendMutation({ op: 'setCell', layerId: layer.id, cell });
        } else if (layer.kind === 'cellDirection' || layer.kind === 'cellRay') {
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
        } else if (layer.kind === 'polygon') {
            const vertexIndex = vertexIndexAt(layer, point);
            if (event.button === 2) {
                if (vertexIndex >= 0) sendMutation({ op: 'removeVertex', layerId: layer.id, index: vertexIndex });
                return;
            }
            if (vertexIndex >= 0) {
                if (layer.vertices[vertexIndex].isRef) {
                    setStatus('This vertex is a reference or expression, edit it in the text.');
                    return;
                }
                state.dragging = { type: 'vertex', layerId: layer.id, index: vertexIndex, point };
                return;
            }
            const snapped = { x: snapTo(point.x, state.snapStep), y: snapTo(point.y, state.snapStep) };
            const edgeIndex = polygonEdgeAt(layer, point);
            const index = edgeIndex >= 0 ? edgeIndex + 1 : layer.vertices.length;
            sendMutation({ op: 'insertVertex', layerId: layer.id, index, point: snapped });
        } else if (layer.kind === 'circle') {
            if (event.button === 2) {
                if (layer.center && layer.centerEditable) sendMutation({ op: 'setPoint', layerId: layer.id, point: null });
                return;
            }
            const center = layer.center || { x: state.data.size.width / 2, y: state.data.size.height / 2 };
            const onRadius =
                layer.radius && Math.abs(Math.hypot(point.x - center.x, point.y - center.y) - layer.radius) <= 12 / state.view.scale;
            if (onRadius) {
                state.dragging = { type: 'circleRadius', layerId: layer.id, center };
                return;
            }
            if (!layer.centerEditable) {
                setStatus('The center follows the component. Move it in the Component locations layer.');
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
        } else if (layer.kind === 'rectList') {
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
        } else if (layer.kind === 'componentPoints') {
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
            if (!entry.locationIsRef) {
                state.dragging = { type: 'component', layerId: layer.id, entry, point: entry.location };
            }
            draw();
        } else if (layer.kind === 'pointList') {
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
        } else if (layer.kind === 'rect') {
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
        } else if (layer.kind === 'cellSet') {
            if (event.button === 2) return;
            const base = layer.baseCell || { x: 0, y: 0 };
            const local = { x: cell.x - base.x, y: cell.y - base.y };
            const existing = layer.cells.some(({ cell: c }) => c.x === local.x && c.y === local.y);
            sendMutation({ op: existing ? 'removeCell' : 'addCell', layerId: layer.id, cell: local });
        } else if (layer.kind === 'cellToValues') {
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
        } else if (layer.kind === 'cellPairList') {
            if (event.button === 2) {
                const index = pairIndexAt(layer, point);
                if (index >= 0) sendMutation({ op: 'removePair', layerId: layer.id, index });
                state.pendingExternal = null;
                draw();
                return;
            }
            if (!state.pendingExternal) {
                state.pendingExternal = cell;
                setStatus('Virtual cell: now click the internal cell (right-click cancels)');
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
    });

    canvas.addEventListener('mousemove', (event) => {
        if (!state.data) return;
        const point = eventToGrid(event);
        setHover(point);
        if (state.dragging) {
            const drag = state.dragging;
            const snapped = { x: snapTo(point.x, state.snapStep), y: snapTo(point.y, state.snapStep) };
            const layer = state.data.layers.find((candidate) => candidate.id === drag.layerId);
            drag.point = snapped;
            drag.moved = true;
            if (!layer) return;
            if (drag.type === 'listPoint' && layer.points[drag.index]) {
                layer.points[drag.index] = { point: snapped, origin: { inherited: false } };
            } else if (drag.type === 'single') {
                layer.point = snapped;
            } else if (drag.type === 'vertex' && layer.vertices[drag.index]) {
                layer.vertices[drag.index] = { point: snapped, origin: { inherited: false } };
            } else if (drag.type === 'circleCenter') {
                layer.center = snapped;
            } else if (drag.type === 'circleRadius') {
                drag.radius = Math.max(0.25, snapTo(Math.hypot(point.x - drag.center.x, point.y - drag.center.y), 0.25));
                layer.radius = drag.radius;
            } else if (drag.type === 'component') {
                const entry = layer.entries.find((candidate) => candidate.component === drag.entry.component);
                if (entry) entry.location = snapped;
            }
            draw();
        } else if (state.rectDrag) {
            dragRectHandle(state.rectDrag, point);
            draw();
        }
    });

    window.addEventListener('mouseup', () => {
        if (state.dragging) {
            const drag = state.dragging;
            state.dragging = null;
            // A press without movement is a selection, not an edit. Skipping it keeps clicking a
            // marker (or cycling a stack) from writing no-op edits into the file and the history.
            if (!drag.moved) {
                draw();
                return;
            }
            if (drag.type === 'listPoint') {
                sendMutation({ op: 'movePoint', layerId: drag.layerId, index: drag.index, point: drag.point });
            } else if (drag.type === 'single' || drag.type === 'circleCenter') {
                sendMutation({ op: 'setPoint', layerId: drag.layerId, point: drag.point });
            } else if (drag.type === 'vertex') {
                sendMutation({ op: 'moveVertex', layerId: drag.layerId, index: drag.index, point: drag.point });
            } else if (drag.type === 'circleRadius' && drag.radius) {
                const layer = state.data && state.data.layers.find((candidate) => candidate.id === drag.layerId);
                sendMutation({
                    op: 'setNumber',
                    layerId: drag.layerId,
                    field: layer ? layer.radiusField : 'BuffRadius',
                    value: drag.radius,
                });
            } else if (drag.type === 'component') {
                // Chained components author their location relative to the chain parent, so the
                // dropped grid point is transformed back through the parent's total rotation.
                const layer = state.data && state.data.layers.find((candidate) => candidate.id === drag.layerId);
                const entry = layer && layer.entries.find((candidate) => candidate.component === drag.entry.component);
                let target = drag.point;
                if (entry && entry.chainedTo) {
                    const parent = chainParentTransform(layer, entry);
                    if (parent) {
                        const [ux, uy] = rotateBackDegrees(
                            drag.point.x - parent.location.x,
                            drag.point.y - parent.location.y,
                            parent.rotation
                        );
                        target = { x: snapTo(ux, state.snapStep), y: snapTo(uy, state.snapStep) };
                    }
                }
                sendMutation({ op: 'moveComponentLocation', component: drag.entry.component, point: target });
            }
        }
        if (state.rectDrag) {
            const drag = state.rectDrag;
            state.rectDrag = null;
            if (drag.entryIndex !== undefined) {
                sendMutation({ op: 'setRectEntry', layerId: drag.layerId, index: drag.entryIndex, tag: null, rect: drag.rect });
            } else {
                sendMutation({ op: 'setRect', layerId: drag.layerId, rect: drag.rect });
            }
        }
    });

    /** Rotates a vector by the inverse of an angle in y-down space. */
    function rotateBackDegrees(x, y, degrees) {
        const radians = (-degrees * Math.PI) / 180;
        const cos = Math.cos(radians);
        const sin = Math.sin(radians);
        return [x * cos - y * sin, x * sin + y * cos];
    }

    function sameCell(a, b) {
        return !!a && !!b && a.x === b.x && a.y === b.y;
    }

    function pointIndexAt(layer, point) {
        const radius = 10 / state.view.scale;
        for (let index = 0; index < layer.points.length; index++) {
            const { point: p } = layer.points[index];
            if (Math.hypot(p.x - point.x, p.y - point.y) <= radius) return index;
        }
        return -1;
    }

    function pairIndexAt(layer, point) {
        for (let index = 0; index < layer.pairs.length; index++) {
            const { external, internal } = layer.pairs[index];
            for (const c of [external, internal]) {
                if (Math.floor(point.x) === c.x && Math.floor(point.y) === c.y) return index;
            }
        }
        return -1;
    }

    function rectHandleAt(rect, point) {
        const radius = 12 / state.view.scale;
        const handles = rectHandles(rect);
        for (let index = 0; index < handles.length; index++) {
            if (Math.hypot(handles[index][0] - point.x, handles[index][1] - point.y) <= radius) return index;
        }
        return -1;
    }

    /** Drags one corner handle, keeping the rect normalized with a minimum extent. */
    function dragRectHandle(drag, point) {
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

    function toggleEntryValue(layer, cell, value) {
        const entry = layer.entries.find(({ cell: c }) => c.x === cell.x && c.y === cell.y);
        const current = entry ? entry.values.slice() : [];
        const expanded = Array.from(expandAdjacency(current));
        const set = new Set(layer.valueModel === 'flags' ? expanded : current);
        if (set.has(value)) set.delete(value);
        else set.add(value);
        sendMutation({ op: 'setEntryValues', layerId: layer.id, cell, values: Array.from(set) });
        renderSidebar();
    }

    function setStatus(text) {
        statusEl.textContent = text;
    }

    function setHover(point) {
        if (state.pendingExternal || state.dragging || state.rectDrag) return;
        const cell = `${Math.floor(point.x)}, ${Math.floor(point.y)}`;
        const exact = `${point.x.toFixed(2)}, ${point.y.toFixed(2)}`;
        setStatus(`cell [${cell}]  ·  [${exact}]`);
    }

    // ------------------------------------------------------------------ sidebar

    function element(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function button(label, title, onClick) {
        const node = element('button', 'ctrl', label);
        if (title) node.title = title;
        node.addEventListener('click', onClick);
        return node;
    }

    function renderSidebar() {
        sidebar.textContent = '';
        if (!state.data) return;
        sidebar.appendChild(viewControls());
        sidebar.appendChild(sizeControls());
        sidebar.appendChild(spriteList());
        sidebar.appendChild(layerList());
        const layer = activeLayer();
        if (layer) sidebar.appendChild(layerPanel(layer));
        sidebar.appendChild(rotationPanel());
        sidebar.appendChild(contiguityPanel());
    }

    /** The `AllowedContiguity` flags panel (which neighbor sides count as structurally connected). */
    function contiguityPanel() {
        const section = element('div', 'section');
        section.appendChild(element('h3', null, 'AllowedContiguity'));
        const contiguity = state.data.contiguity || { values: null, enumNames: [] };
        const current = new Set(expandAdjacency(contiguity.values || ['Sides']));
        section.appendChild(
            element('div', 'hint', contiguity.values ? 'Toggling writes the field.' : 'Unset, the game defaults to Sides.')
        );
        const grid = element('div', 'toggles');
        const names = (contiguity.enumNames || []).filter((name) => !['None', 'All', 'Sides', 'Corners'].includes(name));
        for (const name of names) {
            const toggle = button(name, null, () => {
                const next = new Set(current);
                if (next.has(name)) next.delete(name);
                else next.add(name);
                sendMutation({ op: 'setFlags', field: 'AllowedContiguity', values: Array.from(next) });
            });
            if (current.has(name)) toggle.classList.add('on');
            grid.appendChild(toggle);
        }
        section.appendChild(grid);
        const row = element('div', 'row');
        for (const name of ['Sides', 'Corners', 'All']) {
            row.appendChild(
                button(name, `Set ${name}`, () => sendMutation({ op: 'setFlags', field: 'AllowedContiguity', values: [name] }))
            );
        }
        row.appendChild(
            button('Unset', 'Remove the local field', () =>
                sendMutation({ op: 'setFlags', field: 'AllowedContiguity', values: null })
            )
        );
        section.appendChild(row);
        return section;
    }

    function viewControls() {
        const section = element('div', 'section');
        section.appendChild(element('h3', null, 'View'));
        const history = element('div', 'row');
        const undoButton = button('↶ Undo', 'Undo the last grid edit (Ctrl+Z)', undo);
        undoButton.id = 'undo-button';
        undoButton.disabled = !state.undoStack.length;
        const redoButton = button('↷ Redo', 'Redo the last undone grid edit (Ctrl+Y)', redo);
        redoButton.id = 'redo-button';
        redoButton.disabled = !state.redoStack.length;
        history.appendChild(undoButton);
        history.appendChild(redoButton);
        section.appendChild(history);
        const row = element('div', 'row');
        row.appendChild(
            button('⟲', 'Rotate view counter-clockwise', () => {
                state.view.rotation = (state.view.rotation + 270) % 360;
                updateViewLabel();
                draw();
            })
        );
        row.appendChild(
            button('⟳', 'Rotate view clockwise', () => {
                state.view.rotation = (state.view.rotation + 90) % 360;
                updateViewLabel();
                draw();
            })
        );
        row.appendChild(
            button('↔', 'Flip view horizontally', () => {
                state.view.flipH = !state.view.flipH;
                updateViewLabel();
                draw();
            })
        );
        row.appendChild(
            button('↕', 'Flip view vertically', () => {
                state.view.flipV = !state.view.flipV;
                updateViewLabel();
                draw();
            })
        );
        row.appendChild(
            button('−', 'Zoom out', () => {
                state.view.scale = Math.max(24, state.view.scale / 1.25);
                draw();
            })
        );
        row.appendChild(
            button('+', 'Zoom in', () => {
                state.view.scale = Math.min(384, state.view.scale * 1.25);
                draw();
            })
        );
        section.appendChild(row);
        const label = element('div', 'hint');
        label.id = 'view-label';
        section.appendChild(label);
        updateViewLabel(label);
        return section;
    }

    function updateViewLabel(target) {
        const label = target || document.getElementById('view-label');
        if (!label) return;
        const flips = `${state.view.flipH ? ' flipH' : ''}${state.view.flipV ? ' flipV' : ''}`;
        label.textContent = `rotation ${state.view.rotation}°${flips} (view only, coordinates stay rotation-0)`;
    }

    function sizeControls() {
        const section = element('div', 'section');
        section.appendChild(element('h3', null, 'Size'));
        const row = element('div', 'row');
        const label = element('span', 'value', `${state.data.size.width} × ${state.data.size.height}`);
        const resize = (dw, dh) => {
            const width = Math.max(1, state.data.size.width + dw);
            const height = Math.max(1, state.data.size.height + dh);
            sendMutation({ op: 'setSize', size: { width, height } });
            renderSidebar();
        };
        row.appendChild(button('W−', 'Shrink width', () => resize(-1, 0)));
        row.appendChild(button('W+', 'Grow width', () => resize(1, 0)));
        row.appendChild(button('H−', 'Shrink height', () => resize(0, -1)));
        row.appendChild(button('H+', 'Grow height', () => resize(0, 1)));
        row.appendChild(label);
        section.appendChild(row);
        const hint = element('div', 'hint', 'Resizing does not move existing cell entries.');
        section.appendChild(hint);
        return section;
    }

    function spriteList() {
        const section = element('div', 'section');
        section.appendChild(element('h3', null, 'Sprites'));
        for (const sprite of state.data.sprites) {
            const row = element('label', 'row item');
            const check = element('input');
            check.type = 'checkbox';
            check.checked = state.visibleSprites.has(sprite.id);
            check.addEventListener('change', () => {
                if (check.checked) state.visibleSprites.add(sprite.id);
                else state.visibleSprites.delete(sprite.id);
                draw();
            });
            row.appendChild(check);
            row.appendChild(element('span', null, sprite.label + (sprite.uri ? '' : ' (missing)')));
            section.appendChild(row);
        }
        if (!state.data.sprites.length) section.appendChild(element('div', 'hint', 'No sprites resolved.'));
        return section;
    }

    /** The sidebar order of the layer groups. Unknown groups sort last. */
    const GROUP_ORDER = ['Part', 'Components', 'Colliders', 'Networks', 'Crew', 'Resources', 'Regions', 'Logic', 'Graphics'];

    function layerList() {
        const section = element('div', 'section');
        section.appendChild(element('h3', null, 'Layers'));
        const groups = new Map();
        for (const layer of state.data.layers) {
            const key = layer.group || 'Part';
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(layer);
        }
        const sorted = Array.from(groups.keys()).sort((a, b) => {
            const ai = GROUP_ORDER.indexOf(a);
            const bi = GROUP_ORDER.indexOf(b);
            return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
        });
        for (const key of sorted) {
            const layers = groups.get(key);
            const details = element('details');
            const used = layers.some((layer) => countOf(layer) || layer.id === state.activeLayerId);
            if (key === 'Part' || used) details.open = true;
            const summary = element('summary', null, `${key} `);
            summary.appendChild(element('span', 'count', String(layers.length)));
            details.appendChild(summary);
            for (const layer of layers) details.appendChild(layerRow(layer));
            section.appendChild(details);
        }
        return section;
    }

    function layerRow(layer) {
        const row = element('div', 'layer-row');
        row.style.setProperty('--layer-color', layerColor(layer));
        if (layer.id === state.activeLayerId) row.classList.add('active');
        row.tabIndex = 0;
        const activate = () => {
            state.activeLayerId = layer.id;
            state.visibleLayers.add(layer.id);
            state.selectedCell = null;
            state.pendingExternal = null;
            state.selectedComponent = null;
            renderSidebar();
            draw();
        };
        // The whole legend row activates the layer. The visibility checkbox and the source
        // button keep their own click actions.
        row.addEventListener('click', (event) => {
            if (event.target instanceof HTMLInputElement || event.target instanceof HTMLButtonElement) return;
            activate();
        });
        row.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                activate();
            }
        });
        const radio = element('input');
        radio.type = 'radio';
        radio.name = 'active-layer';
        radio.checked = layer.id === state.activeLayerId;
        radio.title = 'Edit this layer';
        radio.addEventListener('change', activate);
        const check = element('input');
        check.type = 'checkbox';
        check.checked = state.visibleLayers.has(layer.id);
        check.title = 'Show this layer';
        check.addEventListener('change', () => {
            if (check.checked) state.visibleLayers.add(layer.id);
            else state.visibleLayers.delete(layer.id);
            draw();
        });
        const swatch = element('span', 'swatch');
        swatch.style.background = layerColor(layer);
        const count = countOf(layer);
        const label = element('span', 'grow', layer.label);
        row.appendChild(radio);
        row.appendChild(check);
        row.appendChild(swatch);
        row.appendChild(label);
        if (count) row.appendChild(element('span', 'count', String(count)));
        if (layer.inherited) {
            const badge = element('span', 'badge', 'inherited');
            badge.title = 'Defined on a base part. Editing creates a local override.';
            row.appendChild(badge);
        }
        if (layer.origin) {
            row.appendChild(
                button('↗', 'Go to source', () =>
                    vscode.postMessage({ type: 'openLocation', uri: layer.origin.uri, range: layer.origin.range })
                )
            );
        }
        return row;
    }

    function countOf(layer) {
        if (layer.kind === 'cellSet') return layer.cells.length;
        if (layer.kind === 'cellToValues') return layer.entries.length;
        if (layer.kind === 'pointList') return layer.points.length;
        if (layer.kind === 'cellPairList') return layer.pairs.length;
        if (layer.kind === 'point') return layer.point ? 1 : 0;
        if (layer.kind === 'cell') return layer.cell ? 1 : 0;
        if (layer.kind === 'cellDirection' || layer.kind === 'cellRay') return layer.cell ? 1 : 0;
        if (layer.kind === 'polygon') return layer.vertices.length;
        if (layer.kind === 'circle') return layer.center || layer.radius ? 1 : 0;
        if (layer.kind === 'rectList') return layer.entries.length;
        if (layer.kind === 'componentPoints') return layer.entries.length;
        return layer.rect ? 1 : 0;
    }

    function layerPanel(layer) {
        const section = element('div', 'section layer-panel');
        section.style.setProperty('--layer-color', layerColor(layer));
        const heading = element('h3');
        const swatch = element('span', 'swatch');
        swatch.style.background = layerColor(layer);
        heading.appendChild(swatch);
        heading.appendChild(element('span', null, layer.label));
        section.appendChild(heading);
        if (layer.kind === 'cellSet') {
            const domain =
                layer.domain === 'outside'
                    ? 'Each strip is a door opening in the wall toward that cell. A dashed cell is not adjacent to the physical rect and never matches a door.'
                    : layer.domain === 'inside'
                      ? 'Cells inside the part.'
                      : '';
            section.appendChild(element('div', 'hint', `Click a cell to toggle it. ${domain}`));
        } else if (layer.kind === 'cellToValues') {
            section.appendChild(
                element(
                    'div',
                    'hint',
                    layer.valueModel === 'flags'
                        ? 'Click near a cell edge/corner to toggle that wall. Right-click clears the cell.'
                        : 'Select a cell, then toggle directions below. Right-click clears the cell.'
                )
            );
            if (layer.fallback) {
                section.appendChild(element('div', 'hint', `Whole-part fallback: ${layer.fallback.join(', ')}`));
            }
            if (state.selectedCell) {
                section.appendChild(
                    element('div', 'value', `Cell [${state.selectedCell.x}, ${state.selectedCell.y}]`)
                );
                const entry = layer.entries.find(({ cell }) => sameCell(cell, state.selectedCell));
                const values = new Set(
                    layer.valueModel === 'flags'
                        ? expandAdjacency(entry ? entry.values : [])
                        : entry
                          ? entry.values
                          : []
                );
                const grid = element('div', 'toggles');
                const names = layer.enumNames.filter((name) => !['None', 'All', 'Sides', 'Corners'].includes(name));
                for (const name of names) {
                    const toggle = button(name, null, () => toggleEntryValue(layer, state.selectedCell, name));
                    if (values.has(name)) toggle.classList.add('on');
                    grid.appendChild(toggle);
                }
                section.appendChild(grid);
                const shortcuts = element('div', 'row');
                if (layer.valueModel === 'flags') {
                    for (const name of ['Sides', 'Corners', 'All']) {
                        shortcuts.appendChild(
                            button(name, `Set ${name}`, () =>
                                sendMutation({
                                    op: 'setEntryValues',
                                    layerId: layer.id,
                                    cell: state.selectedCell,
                                    values: [name],
                                })
                            )
                        );
                    }
                }
                shortcuts.appendChild(
                    button('Clear', 'Remove this cell entry', () => {
                        sendMutation({ op: 'setEntryValues', layerId: layer.id, cell: state.selectedCell, values: [] });
                        renderSidebar();
                    })
                );
                section.appendChild(shortcuts);
            }
        } else if (layer.kind === 'pointList') {
            section.appendChild(
                element(
                    'div',
                    'hint',
                    layer.fixedCount
                        ? 'Drag a point to move it. This list has a fixed length.'
                        : 'Click to place a point, drag to move it, right-click to remove.'
                )
            );
            section.appendChild(snapRow());
        } else if (layer.kind === 'cellPairList') {
            section.appendChild(
                element(
                    'div',
                    'hint',
                    'Click the external cell, then the internal cell. Right-click a pair to remove it.'
                )
            );
        } else if (layer.kind === 'rect') {
            section.appendChild(element('div', 'hint', 'Drag the corner handles to resize.'));
            const row = element('div', 'row');
            if (!layer.rect) {
                row.appendChild(
                    button('Create', 'Create the rect covering the part', () =>
                        sendMutation({
                            op: 'setRect',
                            layerId: layer.id,
                            rect: { x: 0, y: 0, width: state.data.size.width, height: state.data.size.height },
                        })
                    )
                );
            } else {
                row.appendChild(
                    button('Remove', 'Remove the local rect field', () =>
                        sendMutation({ op: 'setRect', layerId: layer.id, rect: null })
                    )
                );
            }
            section.appendChild(row);
        } else if (layer.kind === 'point') {
            section.appendChild(element('div', 'hint', 'Click to place the point, drag to move, right-click to remove.'));
            section.appendChild(snapRow());
        } else if (layer.kind === 'cell') {
            section.appendChild(element('div', 'hint', 'Click a cell to set it, right-click to remove the field.'));
        } else if (layer.kind === 'cellDirection' || layer.kind === 'cellRay') {
            section.appendChild(
                element('div', 'hint', 'Click a cell to move it. Click an edge of the current cell (or a button) to face it.')
            );
            const row = element('div', 'row');
            for (const direction of layer.directions) {
                const toggle = button(direction, `Face ${direction}`, () =>
                    sendMutation({ op: 'setDirection', layerId: layer.id, direction })
                );
                if (layer.direction === direction) toggle.classList.add('on');
                row.appendChild(toggle);
            }
            section.appendChild(row);
            if (layer.kind === 'cellRay') {
                const tilesRow = element('div', 'row');
                tilesRow.appendChild(element('span', null, 'MaxTiles:'));
                const input = element('input');
                input.type = 'text';
                input.className = 'intlist';
                input.value = layer.maxTiles === null ? '' : String(layer.maxTiles);
                tilesRow.appendChild(input);
                tilesRow.appendChild(
                    button('Set', 'Write MaxTiles', () => {
                        const value = Number(input.value);
                        if (!Number.isInteger(value) || value < 1) {
                            setStatus('MaxTiles: a positive integer');
                            return;
                        }
                        sendMutation({ op: 'setNumber', layerId: layer.id, field: 'MaxTiles', value });
                    })
                );
                section.appendChild(tilesRow);
            }
        } else if (layer.kind === 'polygon') {
            section.appendChild(
                element(
                    'div',
                    'hint',
                    'Drag a vertex to move it. Click an edge to insert a vertex there, elsewhere to append one. Right-click removes a vertex.'
                )
            );
            section.appendChild(snapRow());
        } else if (layer.kind === 'circle') {
            section.appendChild(
                element(
                    'div',
                    'hint',
                    layer.centerEditable
                        ? 'Click to place the center, drag the ring handle to change the radius.'
                        : 'Drag the ring handle to change the radius. The center follows the component location.'
                )
            );
        } else if (layer.kind === 'rectList') {
            section.appendChild(
                element('div', 'hint', 'Drag a corner handle to resize a rect, right-click one to remove it.')
            );
            const row = element('div', 'row');
            const tagInput = element('input');
            tagInput.type = 'text';
            tagInput.className = 'intlist';
            tagInput.placeholder = 'category (e.g. tall)';
            row.appendChild(tagInput);
            row.appendChild(
                button('Add rect', 'Append a rect above the part', () =>
                    sendMutation({
                        op: 'setRectEntry',
                        layerId: layer.id,
                        index: null,
                        tag: tagInput.value.trim() || null,
                        rect: { x: 0, y: -1, width: state.data.size.width, height: 1 },
                    })
                )
            );
            section.appendChild(row);
            if (layer.fallbackRects.length) {
                section.appendChild(
                    element('div', 'hint', `Scalar fields also prohibit: ${layer.fallbackRects.map((f) => f.label).join(', ')} (dashed).`)
                );
            }
        } else if (layer.kind === 'componentPoints') {
            section.appendChild(
                element(
                    'div',
                    'hint',
                    'Click a marker to select (clicking a stack cycles through it), drag to move. Grey markers are chained or reference-valued.'
                )
            );
            section.appendChild(snapRow());
            for (const entry of layer.entries) {
                const row = element('div', 'layer-row');
                if (entry.component === state.selectedComponent) row.classList.add('active');
                row.style.setProperty('--layer-color', layerColor(layer));
                row.addEventListener('click', () => {
                    state.selectedComponent = entry.component;
                    renderSidebar();
                    draw();
                });
                row.appendChild(element('span', 'grow', entry.label));
                if (entry.typeName) row.appendChild(element('span', 'count', entry.typeName));
                if (entry.location) {
                    row.appendChild(
                        element('span', 'count', `[${entry.location.x.toFixed(2)}, ${entry.location.y.toFixed(2)}]`)
                    );
                } else {
                    row.appendChild(element('span', 'badge', 'no location'));
                }
                if (entry.chainedTo) row.appendChild(element('span', 'badge', `⛓ ${entry.chainedTo}`));
                else if (entry.locationIsRef) row.appendChild(element('span', 'badge', 'ref'));
                section.appendChild(row);
            }
            const selected = layer.entries.find((entry) => entry.component === state.selectedComponent);
            if (selected) {
                section.appendChild(element('div', 'value', `${selected.label}${selected.typeName ? ` (${selected.typeName})` : ''}`));
                if (selected.chainedTo) {
                    section.appendChild(element('div', 'hint', `Chained to ${selected.chainedTo}. Dragging edits its local offset.`));
                }
                if (selected.locationIsRef) {
                    section.appendChild(element('div', 'hint', 'The location is a reference or expression, edit it in the text.'));
                }
                const rotationRow = element('div', 'row');
                rotationRow.appendChild(element('span', null, 'Rotation:'));
                const input = element('input');
                input.type = 'text';
                input.className = 'intlist';
                input.value = selected.rotationDeg === null ? '' : String(selected.rotationDeg);
                rotationRow.appendChild(input);
                rotationRow.appendChild(
                    button('Set', 'Write the rotation in degrees', () => {
                        const value = Number(input.value);
                        if (!Number.isFinite(value)) {
                            setStatus('Rotation: a number in degrees');
                            return;
                        }
                        sendMutation({ op: 'setComponentRotation', component: selected.component, degrees: value });
                    })
                );
                section.appendChild(rotationRow);
                const quickRow = element('div', 'row');
                for (const degrees of [0, 90, 180, 270]) {
                    quickRow.appendChild(
                        button(`${degrees}°`, `Rotate to ${degrees} degrees`, () =>
                            sendMutation({ op: 'setComponentRotation', component: selected.component, degrees })
                        )
                    );
                }
                section.appendChild(quickRow);
            }
        }
        return section;
    }

    /** The shared snap-step picker row used by the point-editing panels. */
    function snapRow() {
        const row = element('div', 'row');
        row.appendChild(element('span', null, 'Snap:'));
        for (const [label, step] of [
            ['¼', 0.25],
            ['0.05', 0.05],
            ['free', 0],
        ]) {
            const toggle = button(label, `Snap to ${label} cells`, () => {
                state.snapStep = step;
                renderSidebar();
            });
            if (state.snapStep === step) toggle.classList.add('on');
            row.appendChild(toggle);
        }
        return row;
    }

    function rotationPanel() {
        const section = element('div', 'section');
        section.appendChild(element('h3', null, 'Rotation & flipping'));
        const rotation = state.data.rotation;
        for (const [field, entry] of [
            ['IsRotateable', rotation.isRotateable],
            ['IsFlippable', rotation.isFlippable],
        ]) {
            const row = element('label', 'row item');
            const check = element('input');
            check.type = 'checkbox';
            check.checked = entry.value === true;
            check.indeterminate = entry.value === null;
            check.addEventListener('change', () => sendMutation({ op: 'setBool', field, value: check.checked }));
            row.appendChild(check);
            row.appendChild(element('span', 'grow', field));
            if (entry.origin && entry.origin.inherited) row.appendChild(element('span', 'badge', 'inherited'));
            section.appendChild(row);
        }
        for (const [field, entry] of [
            ['FlipHRotate', rotation.flipHRotate],
            ['FlipVRotate', rotation.flipVRotate],
            ['SelectionTypeRotations', rotation.selectionTypeRotations],
        ]) {
            const row = element('div', 'row item');
            row.appendChild(element('span', 'grow', field));
            const input = element('input');
            input.type = 'text';
            input.className = 'intlist';
            input.placeholder = 'e.g. 0, 2, 1, 3';
            input.value = entry ? entry.values.join(', ') : '';
            row.appendChild(input);
            row.appendChild(
                button('Set', `Write ${field}`, () => {
                    const values = input.value
                        .split(/[,\s]+/)
                        .filter((part) => part.length)
                        .map(Number);
                    if (values.some((value) => !Number.isInteger(value))) {
                        setStatus(`${field}: only integers`);
                        return;
                    }
                    sendMutation({ op: 'setIntList', field, values: values.length ? values : null });
                })
            );
            section.appendChild(row);
        }
        section.appendChild(
            element('div', 'hint', 'Use the view rotation above to preview how rotations will look.')
        );
        return section;
    }

    // ------------------------------------------------------------------ host messages

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
                        resolve();
                    };
                    image.onerror = () => resolve();
                    image.src = uri;
                })
            );
        }
        return Promise.all(loads);
    }

    window.addEventListener('message', (event) => {
        const message = event.data;
        if (!message) return;
        if (message.type === 'render') {
            const firstRender = !state.data;
            state.data = message.data;
            if (firstRender) {
                for (const sprite of state.data.sprites) {
                    if (sprite.defaultVisible) state.visibleSprites.add(sprite.id);
                }
                for (const layer of state.data.layers) {
                    if (countOf(layer)) state.visibleLayers.add(layer.id);
                }
                const first = state.data.layers.find((layer) => layer.id === 'AllowedDoorLocations');
                state.activeLayerId = first ? first.id : state.data.layers[0] && state.data.layers[0].id;
                if (state.activeLayerId) state.visibleLayers.add(state.activeLayerId);
            }
            // A render is authoritative and carries a fresh dataVersion, so queued clicks (absolute
            // coordinates by design) resume against it instead of being judged stale. Re-apply their
            // optimistic echo on top of the authoritative payload so the UI keeps reflecting them.
            state.inFlight = false;
            for (const pending of state.queue) applyLocally(pending);
            void loadSprites(message.spriteData).then(() => {
                renderSidebar();
                draw();
                pump();
            });
        } else if (message.type === 'empty') {
            state.data = null;
            sidebar.textContent = '';
            setStatus('No part found at this position.');
        } else if (message.type === 'editDone') {
            if (typeof message.dataVersion === 'number' && state.data) state.data.dataVersion = message.dataVersion;
            state.inFlight = false;
            pump();
        } else if (message.type === 'editRejected') {
            state.inFlight = false;
            state.queue.length = 0;
            // The document moved on under the recorded history, its inverses no longer apply.
            state.undoStack.length = 0;
            state.redoStack.length = 0;
            updateHistoryButtons();
            setStatus(`Edit rejected (${message.reason}). Resyncing…`);
            vscode.postMessage({ type: 'refresh' });
        }
    });

    window.addEventListener('keydown', (event) => {
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
    });

    vscode.postMessage({ type: 'ready' });
})();
