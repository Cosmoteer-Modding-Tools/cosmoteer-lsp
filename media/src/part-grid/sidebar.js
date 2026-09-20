// The sidebar: the view controls and the history buttons, the size stepper, the sprite list, the
// layer list with its legend rows, the panel of the layer being edited, and the two whole-part
// panels for rotation and contiguity. It is rebuilt from scratch whenever the selection changes,
// which is what keeps it honest about the payload it is showing.

import { GROUP_ORDER, MAX_SCALE, MIN_SCALE } from './constants.js';
import { button, element, setStatus, sidebar, vscode } from './dom.js';
import { expandAdjacency } from './geometry.js';
import { countOf, LAYER_KINDS } from './layer-kinds.js';
import { redo, sendMutation, undo } from './mutations.js';
import { draw } from './render.js';
import { activeLayer, fitScale, layerColor, state } from './state.js';
import { t } from '../shared/strings.js';

/** Rebuilds the whole sidebar from the current payload and selection. */
export function renderSidebar() {
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

/** The view section: undo and redo, the rotation and flip buttons, the zoom, and the view label. */
function viewControls() {
    const section = element('div', 'section');
    section.appendChild(element('h3', null, t('View')));
    const history = element('div', 'row');
    const undoButton = button(t('↶ Undo'), t('Undo the last grid edit (Ctrl+Z)'), undo);
    undoButton.id = 'undo-button';
    undoButton.disabled = !state.undoStack.length;
    const redoButton = button(t('↷ Redo'), t('Redo the last undone grid edit (Ctrl+Y)'), redo);
    redoButton.id = 'redo-button';
    redoButton.disabled = !state.redoStack.length;
    history.appendChild(undoButton);
    history.appendChild(redoButton);
    section.appendChild(history);
    section.appendChild(viewButtons());
    const label = element('div', 'hint');
    label.id = 'view-label';
    section.appendChild(label);
    updateViewLabel(label);
    return section;
}

/** The row of view buttons: the two rotations, the two flips, the zoom steps and the fit. */
function viewButtons() {
    const row = element('div', 'row');
    row.appendChild(
        button('⟲', t('Rotate view counter-clockwise'), () => {
            state.view.rotation = (state.view.rotation + 270) % 360;
            updateViewLabel();
            draw();
        })
    );
    row.appendChild(
        button('⟳', t('Rotate view clockwise'), () => {
            state.view.rotation = (state.view.rotation + 90) % 360;
            updateViewLabel();
            draw();
        })
    );
    row.appendChild(
        button('↔', t('Flip view horizontally'), () => {
            state.view.flipH = !state.view.flipH;
            updateViewLabel();
            draw();
        })
    );
    row.appendChild(
        button('↕', t('Flip view vertically'), () => {
            state.view.flipV = !state.view.flipV;
            updateViewLabel();
            draw();
        })
    );
    row.appendChild(
        button('−', t('Zoom out'), () => {
            state.view.scale = Math.max(MIN_SCALE, state.view.scale / 1.25);
            draw();
        })
    );
    row.appendChild(
        button('+', t('Zoom in'), () => {
            state.view.scale = Math.min(MAX_SCALE, state.view.scale * 1.25);
            draw();
        })
    );
    row.appendChild(
        button('⛶', t('Fit the part in the panel'), () => {
            state.view.scale = fitScale();
            draw();
        })
    );
    return row;
}

/**
 * Writes the line saying which way the view is turned.
 *
 * @param target the label element, absent to look it up.
 */
function updateViewLabel(target) {
    const label = target || document.getElementById('view-label');
    if (!label) return;
    const flips = `${state.view.flipH ? ' flipH' : ''}${state.view.flipV ? ' flipV' : ''}`;
    label.textContent = t('rotation {0}°{1} (view only, coordinates stay rotation-0)', state.view.rotation, flips);
}

/** The size stepper, which grows and shrinks the part by one cell at a time. */
function sizeControls() {
    const section = element('div', 'section');
    section.appendChild(element('h3', null, t('Size')));
    const row = element('div', 'row');
    const label = element('span', 'value', `${state.data.size.width} × ${state.data.size.height}`);
    const resize = (dw, dh) => {
        const width = Math.max(1, state.data.size.width + dw);
        const height = Math.max(1, state.data.size.height + dh);
        sendMutation({ op: 'setSize', size: { width, height } });
        renderSidebar();
    };
    row.appendChild(button(t('W−'), t('Shrink width'), () => resize(-1, 0)));
    row.appendChild(button(t('W+'), t('Grow width'), () => resize(1, 0)));
    row.appendChild(button(t('H−'), t('Shrink height'), () => resize(0, -1)));
    row.appendChild(button(t('H+'), t('Grow height'), () => resize(0, 1)));
    row.appendChild(label);
    section.appendChild(row);
    const hint = element('div', 'hint', t('Resizing does not move existing cell entries.'));
    section.appendChild(hint);
    return section;
}

/** The sprite list, one visibility checkbox per resolved sprite. */
function spriteList() {
    const section = element('div', 'section');
    section.appendChild(element('h3', null, t('Sprites')));
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
        row.appendChild(element('span', null, sprite.uri ? sprite.label : t('{0} (missing)', sprite.label)));
        section.appendChild(row);
    }
    if (!state.data.sprites.length) section.appendChild(element('div', 'hint', t('No sprites resolved.')));
    return section;
}

/** The layer list, folded into the groups the payload files its layers under. */
function layerList() {
    const section = element('div', 'section');
    section.appendChild(element('h3', null, t('Layers')));
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

/** One legend row: the edit radio, the visibility checkbox, the swatch, the label and its badges. */
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
    radio.title = t('Edit this layer');
    radio.addEventListener('change', activate);
    row.appendChild(radio);
    row.appendChild(visibilityCheck(layer));
    const swatch = element('span', 'swatch');
    swatch.style.background = layerColor(layer);
    row.appendChild(swatch);
    row.appendChild(element('span', 'grow', layer.label));
    const count = countOf(layer);
    if (count) row.appendChild(element('span', 'count', String(count)));
    if (layer.inherited) {
        const badge = element('span', 'badge', t('inherited'));
        badge.title = t('Defined on a base part. Editing creates a local override.');
        row.appendChild(badge);
    }
    if (layer.origin) {
        row.appendChild(
            button('↗', t('Go to source'), () =>
                vscode.postMessage({ type: 'openLocation', uri: layer.origin.uri, range: layer.origin.range })
            )
        );
    }
    return row;
}

/**
 * The visibility checkbox of a legend row.
 *
 * @param layer the layer the row stands for.
 * @returns the checkbox.
 */
function visibilityCheck(layer) {
    const check = element('input');
    check.type = 'checkbox';
    check.checked = state.visibleLayers.has(layer.id);
    check.title = t('Show this layer');
    check.addEventListener('change', () => {
        if (check.checked) state.visibleLayers.add(layer.id);
        else state.visibleLayers.delete(layer.id);
        // Switching the edited layer off swaps its panel for the reason it is inert.
        if (layer.id === state.activeLayerId) renderSidebar();
        draw();
    });
    return check;
}

/** The panel of the layer being edited, filled in by the `panel` member of its kind. */
function layerPanel(layer) {
    const section = element('div', 'section layer-panel');
    section.style.setProperty('--layer-color', layerColor(layer));
    const heading = element('h3');
    const swatch = element('span', 'swatch');
    swatch.style.background = layerColor(layer);
    heading.appendChild(swatch);
    heading.appendChild(element('span', null, layer.label));
    section.appendChild(heading);
    if (!state.visibleLayers.has(layer.id)) {
        section.classList.add('hidden-layer');
        section.appendChild(element('div', 'hint', t('{0} is hidden. Tick its checkbox to edit it.', layer.label)));
        return section;
    }
    const kind = LAYER_KINDS[layer.kind];
    if (kind && kind.panel) kind.panel(layer, section);
    return section;
}

/** The rotation and flipping panel: the two booleans and the three rotation int lists. */
function rotationPanel() {
    const section = element('div', 'section');
    section.appendChild(element('h3', null, t('Rotation & flipping')));
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
        if (entry.origin && entry.origin.inherited) row.appendChild(element('span', 'badge', t('inherited')));
        section.appendChild(row);
    }
    for (const [field, entry] of [
        ['FlipHRotate', rotation.flipHRotate],
        ['FlipVRotate', rotation.flipVRotate],
        ['SelectionTypeRotations', rotation.selectionTypeRotations],
    ]) {
        section.appendChild(rotationListRow(field, entry));
    }
    section.appendChild(element('div', 'hint', t('Use the view rotation above to preview how rotations will look.')));
    return section;
}

/**
 * One row of the rotation panel's int-list fields.
 *
 * @param field the rules field name.
 * @param entry the payload entry, absent where the field is not written.
 * @returns the row.
 */
function rotationListRow(field, entry) {
    const row = element('div', 'row item');
    row.appendChild(element('span', 'grow', field));
    const input = element('input');
    input.type = 'text';
    input.className = 'intlist';
    input.placeholder = t('e.g. 0, 2, 1, 3');
    input.value = entry ? entry.values.join(', ') : '';
    row.appendChild(input);
    row.appendChild(
        button(t('Set'), t('Write {0}', field), () => {
            const values = input.value
                .split(/[,\s]+/)
                .filter((part) => part.length)
                .map(Number);
            if (values.some((value) => !Number.isInteger(value))) {
                setStatus(t('{0}: only integers', field));
                return;
            }
            sendMutation({ op: 'setIntList', field, values: values.length ? values : null });
        })
    );
    return row;
}

/** The `AllowedContiguity` flags panel (which neighbor sides count as structurally connected). */
function contiguityPanel() {
    const section = element('div', 'section');
    section.appendChild(element('h3', null, 'AllowedContiguity'));
    const contiguity = state.data.contiguity || { values: null, enumNames: [] };
    const current = new Set(expandAdjacency(contiguity.values || ['Sides']));
    section.appendChild(
        element(
            'div',
            'hint',
            contiguity.values ? t('Toggling writes the field.') : t('Unset, the game defaults to Sides.')
        )
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
            button(name, t('Set {0}', name), () =>
                sendMutation({ op: 'setFlags', field: 'AllowedContiguity', values: [name] })
            )
        );
    }
    row.appendChild(
        button(t('Unset'), t('Remove the local field'), () =>
            sendMutation({ op: 'setFlags', field: 'AllowedContiguity', values: null })
        )
    );
    section.appendChild(row);
    return section;
}
