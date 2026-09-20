// The sidebar panel of each layer kind: what clicking that kind does, and the typed fields a
// gesture cannot author. The map at the top is the half of the layer-kind registry that belongs to
// the sidebar, which `main.js` stitches into the registry proper.

import { button, element, setStatus } from './dom.js';
import { expandAdjacency, sameCell } from './geometry.js';
import { toggleEntryValue } from './hit-test.js';
import { sendMutation } from './mutations.js';
import { draw } from './render.js';
import { renderSidebar } from './sidebar.js';
import { layerColor, state } from './state.js';
import { t } from '../shared/strings.js';

/** The sidebar panel of each layer kind, by kind name. */
export const LAYER_PANEL = {
    cellSet: panelCellSet,
    cellToValues: panelCellToValues,
    pointList: panelPointList,
    cellPairList: panelCellPairList,
    point: panelPoint,
    cell: panelCell,
    cellDirection: panelCellDirection,
    cellRay: panelCellDirection,
    polygon: panelPolygon,
    circle: panelCircle,
    edgeRegion: panelEdgeRegion,
    rectList: panelRectList,
    componentPoints: panelComponentPoints,
    rect: panelRect,
};

/** The shared snap-step picker row used by the point-editing panels. */
function snapRow() {
    const row = element('div', 'row');
    row.appendChild(element('span', null, t('Snap:')));
    for (const [label, step] of [
        ['¼', 0.25],
        ['0.05', 0.05],
        [t('free'), 0],
    ]) {
        const toggle = button(label, t('Snap to {0} cells', label), () => {
            state.snapStep = step;
            renderSidebar();
        });
        if (state.snapStep === step) toggle.classList.add('on');
        row.appendChild(toggle);
    }
    return row;
}

/** A cell set says which domain it addresses, since that decides how a door entry is read. */
function panelCellSet(layer, section) {
    const domain =
        layer.domain === 'outside'
            ? t(
                  'Each strip is a door opening in the wall toward that cell. A dashed cell is not adjacent to the physical rect and never matches a door.'
              )
            : layer.domain === 'inside'
              ? t('Cells inside the part.')
              : '';
    section.appendChild(element('div', 'hint', t('Click a cell to toggle it. {0}', domain)));
}

/** Cell entries show the selected cell's value set as toggles, plus the composite shortcuts. */
function panelCellToValues(layer, section) {
    section.appendChild(
        element(
            'div',
            'hint',
            layer.valueModel === 'flags'
                ? t('Click near a cell edge/corner to toggle that wall. Right-click clears the cell.')
                : t('Select a cell, then toggle directions below. Right-click clears the cell.')
        )
    );
    if (layer.fallback) {
        section.appendChild(element('div', 'hint', t('Whole-part fallback: {0}', layer.fallback.join(', '))));
    }
    if (!state.selectedCell) return;
    section.appendChild(element('div', 'value', t('Cell [{0}, {1}]', state.selectedCell.x, state.selectedCell.y)));
    const entry = layer.entries.find(({ cell }) => sameCell(cell, state.selectedCell));
    const values = new Set(
        layer.valueModel === 'flags' ? expandAdjacency(entry ? entry.values : []) : entry ? entry.values : []
    );
    const grid = element('div', 'toggles');
    const names = layer.enumNames.filter((name) => !['None', 'All', 'Sides', 'Corners'].includes(name));
    for (const name of names) {
        const toggle = button(name, null, () => toggleEntryValue(layer, state.selectedCell, name));
        if (values.has(name)) toggle.classList.add('on');
        grid.appendChild(toggle);
    }
    section.appendChild(grid);
    section.appendChild(entryShortcuts(layer));
}

/**
 * The composite and clearing buttons under a cell entry's toggles.
 *
 * @param layer the cellToValues layer.
 * @returns the row of buttons.
 */
function entryShortcuts(layer) {
    const shortcuts = element('div', 'row');
    if (layer.valueModel === 'flags') {
        for (const name of ['Sides', 'Corners', 'All']) {
            shortcuts.appendChild(
                button(name, t('Set {0}', name), () =>
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
        button(t('Clear'), t('Remove this cell entry'), () => {
            sendMutation({ op: 'setEntryValues', layerId: layer.id, cell: state.selectedCell, values: [] });
            renderSidebar();
        })
    );
    return shortcuts;
}

/** A point list says whether it can grow, and carries the snap picker. */
function panelPointList(layer, section) {
    section.appendChild(
        element(
            'div',
            'hint',
            layer.fixedCount
                ? t('Drag a point to move it. This list has a fixed length.')
                : t('Click to place a point, drag to move it, right-click to remove.')
        )
    );
    section.appendChild(snapRow());
}

/** A pair list explains its two-click gesture. */
function panelCellPairList(layer, section) {
    section.appendChild(
        element('div', 'hint', t('Click the external cell, then the internal cell. Right-click a pair to remove it.'))
    );
}

/** A single rect offers creating the part-covering rect, or removing the local field. */
function panelRect(layer, section) {
    section.appendChild(
        element(
            'div',
            'hint',
            layer.isRef
                ? t(
                      'Drag the corner handles to resize. This rect is written from references, so the numbers are written where they are declared.'
                  )
                : t('Drag the corner handles to resize.')
        )
    );
    const row = element('div', 'row');
    if (!layer.rect) {
        row.appendChild(
            button(t('Create'), t('Create the rect covering the part'), () =>
                sendMutation({
                    op: 'setRect',
                    layerId: layer.id,
                    rect: { x: 0, y: 0, width: state.data.size.width, height: state.data.size.height },
                })
            )
        );
    } else {
        row.appendChild(
            button(t('Remove'), t('Remove the local rect field'), () =>
                sendMutation({ op: 'setRect', layerId: layer.id, rect: null })
            )
        );
    }
    section.appendChild(row);
}

/** A single point explains its gesture and carries the snap picker. */
function panelPoint(layer, section) {
    section.appendChild(element('div', 'hint', t('Click to place the point, drag to move, right-click to remove.')));
    section.appendChild(snapRow());
}

/** A single cell explains its gesture. */
function panelCell(layer, section) {
    section.appendChild(element('div', 'hint', t('Click a cell to set it, right-click to remove the field.')));
}

/** A cell with a facing offers the facing buttons, and a ray also offers its reach. */
function panelCellDirection(layer, section) {
    section.appendChild(
        element(
            'div',
            'hint',
            t('Click a cell to move it. Click an edge of the current cell (or a button) to face it.')
        )
    );
    const row = element('div', 'row');
    for (const direction of layer.directions) {
        const toggle = button(direction, t('Face {0}', direction), () =>
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
            button(t('Set'), t('Write MaxTiles'), () => {
                const value = Number(input.value);
                if (!Number.isInteger(value) || value < 1) {
                    setStatus(t('MaxTiles: a positive integer'));
                    return;
                }
                sendMutation({ op: 'setNumber', layerId: layer.id, field: 'MaxTiles', value });
            })
        );
        section.appendChild(tilesRow);
    }
}

/** A polygon explains its vertex gestures and carries the snap picker. */
function panelPolygon(layer, section) {
    section.appendChild(
        element(
            'div',
            'hint',
            t(
                'Drag a vertex to move it. Click an edge to insert a vertex there, elsewhere to append one. Right-click removes a vertex.'
            )
        )
    );
    section.appendChild(snapRow());
}

/** A circle says whether its center can be moved here or follows a component. */
function panelCircle(layer, section) {
    section.appendChild(
        element(
            'div',
            'hint',
            layer.centerEditable
                ? t('Click to place the center, drag the ring handle to change the radius.')
                : t('Drag the ring handle to change the radius. The center follows the component location.')
        )
    );
}

/** An edge-distance region offers its distance as a typed value beside the halo drag. */
function panelEdgeRegion(layer, section) {
    section.appendChild(
        element(
            'div',
            'hint',
            t(
                'Drag the halo boundary to change how many cells the region reaches beyond the part. Right-click clears the distance.'
            )
        )
    );
    const distRow = element('div', 'row');
    distRow.appendChild(element('span', null, t('Distance:')));
    const input = element('input');
    input.type = 'text';
    input.className = 'intlist';
    input.value = layer.distance === null ? '' : String(layer.distance);
    distRow.appendChild(input);
    distRow.appendChild(
        button(t('Set'), t('Write the region distance'), () => {
            const value = Number(input.value);
            if (!Number.isInteger(value) || value < 0) {
                setStatus(t('Distance: a non-negative integer'));
                return;
            }
            sendMutation({ op: 'setNumber', layerId: layer.id, field: layer.distanceField, value });
        })
    );
    section.appendChild(distRow);
}

/** A rect list offers appending a tagged rect, and names the scalar fields that also prohibit. */
function panelRectList(layer, section) {
    section.appendChild(
        element('div', 'hint', t('Drag a corner handle to resize a rect, right-click one to remove it.'))
    );
    const row = element('div', 'row');
    const tagInput = element('input');
    tagInput.type = 'text';
    tagInput.className = 'intlist';
    tagInput.placeholder = t('category (e.g. tall)');
    row.appendChild(tagInput);
    row.appendChild(
        button(t('Add rect'), t('Append a rect above the part'), () =>
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
            element(
                'div',
                'hint',
                t('Scalar fields also prohibit: {0} (dashed).', layer.fallbackRects.map((f) => f.label).join(', '))
            )
        );
    }
}

/** The component gizmo lists every entry, and the selected one gets its rotation controls. */
function panelComponentPoints(layer, section) {
    section.appendChild(
        element(
            'div',
            'hint',
            t(
                'Click a marker to select (clicking a stack cycles through it), drag to move. Grey markers are chained or reference-valued.'
            )
        )
    );
    section.appendChild(snapRow());
    for (const entry of layer.entries) section.appendChild(componentRow(layer, entry));
    const selected = layer.entries.find((entry) => entry.component === state.selectedComponent);
    if (selected) componentDetails(selected, section);
}

/**
 * One row of the component gizmo's list.
 *
 * @param layer the gizmo layer, for its legend color.
 * @param entry the component entry.
 * @returns the row.
 */
function componentRow(layer, entry) {
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
        row.appendChild(element('span', 'count', `[${entry.location.x.toFixed(2)}, ${entry.location.y.toFixed(2)}]`));
    } else {
        row.appendChild(element('span', 'badge', t('no location')));
    }
    if (entry.chainedTo) row.appendChild(element('span', 'badge', `⛓ ${entry.chainedTo}`));
    else if (entry.locationIsRef) row.appendChild(element('span', 'badge', t('ref')));
    return row;
}

/**
 * What the selected component says about itself, and the rotation it is written with.
 *
 * @param selected the selected component entry.
 * @param section the panel to append to.
 */
function componentDetails(selected, section) {
    section.appendChild(
        element('div', 'value', `${selected.label}${selected.typeName ? ` (${selected.typeName})` : ''}`)
    );
    if (selected.chainedTo) {
        section.appendChild(
            element('div', 'hint', t('Chained to {0}. Dragging edits its local offset.', selected.chainedTo))
        );
    }
    if (selected.locationIsRef) {
        section.appendChild(
            element(
                'div',
                'hint',
                t('This location is written from references, so the numbers are written where they are declared.')
            )
        );
    }
    const rotationRow = element('div', 'row');
    rotationRow.appendChild(element('span', null, t('Rotation:')));
    const input = element('input');
    input.type = 'text';
    input.className = 'intlist';
    input.value = selected.rotationDeg === null ? '' : String(selected.rotationDeg);
    rotationRow.appendChild(input);
    rotationRow.appendChild(
        button(t('Set'), t('Write the rotation in degrees'), () => {
            const value = Number(input.value);
            if (!Number.isFinite(value)) {
                setStatus(t('Rotation: a number in degrees'));
                return;
            }
            sendMutation({ op: 'setComponentRotation', component: selected.component, degrees: value });
        })
    );
    section.appendChild(rotationRow);
    const quickRow = element('div', 'row');
    for (const degrees of [0, 90, 180, 270]) {
        quickRow.appendChild(
            button(`${degrees}°`, t('Rotate to {0} degrees', degrees), () =>
                sendMutation({ op: 'setComponentRotation', component: selected.component, degrees })
            )
        );
    }
    section.appendChild(quickRow);
}
