import { beforeEach, describe, expect, it } from 'vitest';
import type {
    CellDirectionLayerData,
    CellLayerData,
    CellPairListLayerData,
    CellRayLayerData,
    CellSetLayerData,
    CellToValuesLayerData,
    CircleLayerData,
    ComponentPointEntry,
    ComponentPointsLayerData,
    EdgeRegionLayerData,
    GridLayerData,
    PartGridData,
    PointLayerData,
    PointListLayerData,
    PolygonLayerData,
    RectLayerData,
    RectListLayerData,
} from '../../../src/features/part-editor/part-grid.types';
import {
    ADJACENCY_NAMES,
    GridHarness,
    LAYER_BASE,
    LOCAL_ORIGIN,
    StubElement,
    TRAVEL_NAMES,
    loadGridWebview,
    partGrid,
} from './part-grid-webview.harness';

/**
 * Interaction coverage for the part grid editor page, driven through the real shipped script under
 * a DOM stub. Every test reads the same way: build a payload, render it, dispatch an event, assert
 * the mutation the page posted. The mutation is the contract with the server and it is what a wrong
 * hit-test corrupts, so it is what these tests look at rather than the drawn picture.
 */

let page: GridHarness;

beforeEach(() => {
    page = loadGridWebview();
});

/** A rectangle, spelled out so the rect expectations read as coordinates rather than as objects. */
function rect(x: number, y: number, width: number, height: number) {
    return { x, y, width, height };
}

/** The identifying fields a layer builder always needs spelled out by its caller. */
type Named<T extends GridLayerData> = Partial<T> & Pick<T, 'id' | 'label' | 'fieldName'>;

/** A rect layer, the kind whose null-rect guard moved into its renderer. */
function rectLayer(value: ReturnType<typeof rect> | null, overrides: Partial<RectLayerData> = {}): RectLayerData {
    return {
        ...LAYER_BASE,
        kind: 'rect',
        id: 'PhysicalRect',
        label: 'PhysicalRect',
        fieldName: 'PhysicalRect',
        rect: value,
        ...overrides,
    };
}

/** A buff circle, optionally with a centre the component gizmo owns instead. */
function circleLayer(overrides: Partial<CircleLayerData> = {}): CircleLayerData {
    return {
        ...LAYER_BASE,
        kind: 'circle',
        id: 'BuffArea',
        label: 'BuffArea',
        fieldName: 'BuffArea',
        center: { x: 2, y: 2 },
        radius: 1.5,
        radiusField: 'BuffRadius',
        centerEditable: true,
        ...overrides,
    };
}

/** A regulator region, whose distance is written through the registry's number accessor. */
function edgeRegionLayer(distance: number | null): EdgeRegionLayerData {
    return {
        ...LAYER_BASE,
        kind: 'edgeRegion',
        id: 'Region',
        label: 'Region',
        fieldName: 'Region',
        group: 'Regions',
        distance,
        distanceField: 'Distance',
    };
}

/** A tile line, the other kind that reaches the registry's number accessor. */
function cellRayLayer(overrides: Partial<CellRayLayerData> = {}): CellRayLayerData {
    return {
        ...LAYER_BASE,
        kind: 'cellRay',
        id: 'Line',
        label: 'Line',
        fieldName: 'Line',
        cell: { x: 1, y: 1 },
        direction: 'Up',
        maxTiles: 3,
        directions: TRAVEL_NAMES,
        ...overrides,
    };
}

/** A cell set, either a door ring around the part or a plain set of inside cells. */
function cellSetLayer(overrides: Named<CellSetLayerData>): CellSetLayerData {
    return {
        ...LAYER_BASE,
        kind: 'cellSet',
        domain: 'inside',
        cells: [],
        ...overrides,
    };
}

/** A per-cell enum map in either of its two value models. */
function cellToValuesLayer(
    overrides: Named<CellToValuesLayerData> & Pick<CellToValuesLayerData, 'valueModel'>
): CellToValuesLayerData {
    return {
        ...LAYER_BASE,
        kind: 'cellToValues',
        enumRef: 'Halfling.Geometry.AdjacencyFlags',
        enumNames: ADJACENCY_NAMES,
        fallback: null,
        entries: [],
        ...overrides,
    };
}

/** One entry of the component gizmo layer, with the fields a drag and the sidebar read. */
function componentEntry(overrides: Partial<ComponentPointEntry>): ComponentPointEntry {
    return {
        component: 'gun',
        label: 'gun',
        typeName: 'Cannon',
        location: { x: 1, y: 1 },
        rotationDeg: null,
        chainedTo: null,
        locationIsRef: false,
        origin: null,
        ...overrides,
    };
}

/** The aggregated component gizmo layer. */
function componentPointsLayer(entries: ComponentPointEntry[]): ComponentPointsLayerData {
    return {
        ...LAYER_BASE,
        kind: 'componentPoints',
        id: 'ComponentLocations',
        label: 'Component locations',
        fieldName: 'ComponentLocations',
        group: 'Components',
        entries,
    };
}

/** The visibility checkbox of a legend row. */
function visibilityBox(row: StubElement): StubElement {
    const box = row.children.find((child) => child.tagName === 'INPUT' && child.type === 'checkbox');
    if (!box) throw new Error('the legend row has no visibility checkbox');
    return box;
}

/** The count badge text of a legend row, or null when the row shows none. */
function countBadge(row: StubElement): string | null {
    const badge = row.children.find((child) => child.classList.contains('count'));
    return badge ? badge.textContent : null;
}

describe('part grid webview loading', () => {
    it('posts ready once the page has registered its listeners', () => {
        expect(page.posted).toEqual([{ type: 'ready' }]);
    });

    it('renders a payload into the canvas and the sidebar', async () => {
        await page.render(partGrid([rectLayer(rect(0, 0, 4, 4))]));
        expect(page.section('View')).toBeTruthy();
        expect(page.layerRow('PhysicalRect')).toBeTruthy();
        expect(page.mutations).toEqual([]);
    });
});

describe('part grid webview rect layer', () => {
    /** Renders the 4x4 part with a rect covering all of it, ready for a handle drag. */
    async function renderRect() {
        await page.render(partGrid([rectLayer(rect(0, 0, 4, 4))]));
        page.clear();
    }

    it('drags the top-left handle', async () => {
        await renderRect();
        await page.drag([0, 0], [1, 1]);
        expect(page.lastMutation()).toEqual({ op: 'setRect', layerId: 'PhysicalRect', rect: rect(1, 1, 3, 3) });
    });

    it('drags the top-right handle', async () => {
        await renderRect();
        await page.drag([4, 0], [3, 1]);
        expect(page.lastMutation()).toEqual({ op: 'setRect', layerId: 'PhysicalRect', rect: rect(0, 1, 3, 3) });
    });

    it('drags the bottom-right handle', async () => {
        await renderRect();
        await page.drag([4, 4], [3, 3]);
        expect(page.lastMutation()).toEqual({ op: 'setRect', layerId: 'PhysicalRect', rect: rect(0, 0, 3, 3) });
    });

    it('drags the bottom-left handle', async () => {
        await renderRect();
        await page.drag([0, 4], [1, 3]);
        expect(page.lastMutation()).toEqual({ op: 'setRect', layerId: 'PhysicalRect', rect: rect(1, 0, 3, 3) });
    });

    it('keeps a dragged handle from collapsing the rect past one cell', async () => {
        await renderRect();
        await page.drag([0, 0], [4, 4]);
        expect(page.lastMutation()).toEqual({ op: 'setRect', layerId: 'PhysicalRect', rect: rect(3, 3, 1, 1) });
    });

    it('ignores a press that lands away from every handle', async () => {
        await renderRect();
        await page.drag([2, 2], [2.5, 2.5]);
        expect(page.mutations).toEqual([]);
    });

    it('renders a rect layer whose field is absent and refuses canvas edits', async () => {
        await page.render(partGrid([rectLayer(null)]));
        page.clear();
        await page.drag([0, 0], [1, 1]);
        expect(page.mutations).toEqual([]);
        expect(countBadge(page.layerRow('PhysicalRect'))).toBeNull();
    });

    it('creates the rect from the panel when the field is absent', async () => {
        await page.render(partGrid([rectLayer(null)]));
        page.clear();
        await page.clickButton('Create', page.layerPanel());
        expect(page.lastMutation()).toEqual({ op: 'setRect', layerId: 'PhysicalRect', rect: rect(0, 0, 4, 4) });
    });

    it('removes the local rect from the panel', async () => {
        await renderRect();
        await page.clickButton('Remove', page.layerPanel());
        expect(page.lastMutation()).toEqual({ op: 'setRect', layerId: 'PhysicalRect', rect: null });
    });

    it('snaps a fractional rect to quarter cells', async () => {
        const layer = rectLayer(rect(0, 0, 4, 4), {
            id: 'IdleRect',
            label: 'IdleRect',
            fieldName: 'IdleRect',
            fractional: true,
        });
        await page.render(partGrid([layer]));
        page.clear();
        await page.drag([0, 0], [1.2, 1.2]);
        expect(page.lastMutation()).toEqual({ op: 'setRect', layerId: 'IdleRect', rect: rect(1.25, 1.25, 2.75, 2.75) });
    });
});

describe('part grid webview circle layer', () => {
    it('clears the centre on a right-click when the centre is editable', async () => {
        await page.render(partGrid([circleLayer()]));
        page.clear();
        await page.click(0.5, 0.5, 2);
        expect(page.lastMutation()).toEqual({ op: 'setPoint', layerId: 'BuffArea', point: null });
    });

    it('refuses a right-click when the centre follows the component', async () => {
        await page.render(partGrid([circleLayer({ centerEditable: false })]));
        page.clear();
        await page.click(0.5, 0.5, 2);
        expect(page.mutations).toEqual([]);
    });

    it('places the centre with a left-click, snapped to the step', async () => {
        await page.render(partGrid([circleLayer()]));
        page.clear();
        await page.click(3.2, 2);
        expect(page.lastMutation()).toEqual({ op: 'setPoint', layerId: 'BuffArea', point: { x: 3.25, y: 2 } });
    });

    it('refuses to place the centre when it follows the component', async () => {
        await page.render(partGrid([circleLayer({ centerEditable: false })]));
        page.clear();
        await page.click(2, 2.4);
        expect(page.mutations).toEqual([]);
        expect(page.status()).toContain('center follows the component');
    });

    it('drags the ring handle to write the radius field', async () => {
        await page.render(partGrid([circleLayer()]));
        page.clear();
        await page.drag([3.5, 2], [4.25, 2]);
        expect(page.lastMutation()).toEqual({
            op: 'setNumber',
            layerId: 'BuffArea',
            field: 'BuffRadius',
            value: 2.25,
        });
    });

    it('drags the ring handle even when the centre is not editable', async () => {
        await page.render(partGrid([circleLayer({ centerEditable: false })]));
        page.clear();
        await page.drag([3.5, 2], [4.25, 2]);
        expect(page.lastMutation()).toEqual({
            op: 'setNumber',
            layerId: 'BuffArea',
            field: 'BuffRadius',
            value: 2.25,
        });
    });
});

describe('part grid webview edge region layer', () => {
    /** The halo reaches four cells past the part, so the payload carries a margin that fits it. */
    const roomy = (distance: number | null): PartGridData => partGrid([edgeRegionLayer(distance)], { margin: 4 });

    it('clears the distance on a right-click', async () => {
        await page.render(roomy(2));
        page.clear();
        await page.click(2, 2, 2);
        expect(page.lastMutation()).toEqual({
            op: 'setNumber',
            layerId: 'Region',
            field: 'Distance',
            value: null,
        });
    });

    it('drags the halo boundary to a whole ring', async () => {
        await page.render(roomy(2));
        page.clear();
        await page.drag([6, 2], [7.2, 2]);
        expect(page.lastMutation()).toEqual({ op: 'setNumber', layerId: 'Region', field: 'Distance', value: 3 });
    });

    it('seeds a first distance from any click when none is set', async () => {
        await page.render(roomy(null));
        page.clear();
        await page.drag([2, 2], [6.4, 2]);
        expect(page.lastMutation()).toEqual({ op: 'setNumber', layerId: 'Region', field: 'Distance', value: 2 });
    });

    it('writes the distance typed into the panel', async () => {
        await page.render(roomy(2));
        page.clear();
        page.input(page.layerPanel()).value = '3';
        await page.clickButton('Set', page.layerPanel());
        expect(page.lastMutation()).toEqual({ op: 'setNumber', layerId: 'Region', field: 'Distance', value: 3 });
    });

    it('refuses a panel distance that is not a whole number of cells', async () => {
        await page.render(roomy(2));
        page.clear();
        page.input(page.layerPanel()).value = '1.5';
        await page.clickButton('Set', page.layerPanel());
        expect(page.mutations).toEqual([]);
        expect(page.status()).toContain('non-negative integer');
    });
});

describe('part grid webview cell ray layer', () => {
    it('moves the ray start to the clicked cell', async () => {
        await page.render(partGrid([cellRayLayer()]));
        page.clear();
        await page.click(2.5, 2.5);
        expect(page.lastMutation()).toEqual({ op: 'setCell', layerId: 'Line', cell: { x: 2, y: 2 } });
    });

    it('turns the facing when an edge of the current cell is clicked', async () => {
        await page.render(partGrid([cellRayLayer()]));
        page.clear();
        await page.click(1.9, 1.5);
        expect(page.lastMutation()).toEqual({ op: 'setDirection', layerId: 'Line', direction: 'Right' });
    });

    it('faces a direction from the panel buttons', async () => {
        await page.render(partGrid([cellRayLayer()]));
        page.clear();
        await page.clickButton('Down', page.layerPanel());
        expect(page.lastMutation()).toEqual({ op: 'setDirection', layerId: 'Line', direction: 'Down' });
    });

    it('writes MaxTiles through the registry number accessor', async () => {
        await page.render(partGrid([cellRayLayer()]));
        page.clear();
        page.input(page.layerPanel()).value = '5';
        await page.clickButton('Set', page.layerPanel());
        expect(page.lastMutation()).toEqual({ op: 'setNumber', layerId: 'Line', field: 'MaxTiles', value: 5 });
    });

    it('undoes MaxTiles back to the value the payload carried', async () => {
        await page.render(partGrid([cellRayLayer()]));
        page.clear();
        page.input(page.layerPanel()).value = '5';
        await page.clickButton('Set', page.layerPanel());
        await page.keyDown({ key: 'z', ctrlKey: true });
        expect(page.mutations).toEqual([
            { op: 'setNumber', layerId: 'Line', field: 'MaxTiles', value: 5 },
            { op: 'setNumber', layerId: 'Line', field: 'MaxTiles', value: 3 },
        ]);
    });
});

describe('part grid webview cell set layer', () => {
    it('adds an outside door cell on the ring around the part', async () => {
        const door = cellSetLayer({
            id: 'AllowedDoorLocations',
            label: 'AllowedDoorLocations',
            fieldName: 'AllowedDoorLocations',
            domain: 'outside',
            cells: [{ cell: { x: -1, y: 0 }, origin: LOCAL_ORIGIN }],
        });
        await page.render(partGrid([door]));
        page.clear();
        await page.click(4.5, 1.5);
        expect(page.lastMutation()).toEqual({
            op: 'addCell',
            layerId: 'AllowedDoorLocations',
            cell: { x: 4, y: 1 },
        });
    });

    it('removes a door cell that is already authored', async () => {
        const door = cellSetLayer({
            id: 'AllowedDoorLocations',
            label: 'AllowedDoorLocations',
            fieldName: 'AllowedDoorLocations',
            domain: 'outside',
            cells: [{ cell: { x: -1, y: 0 }, origin: LOCAL_ORIGIN }],
        });
        await page.render(partGrid([door]));
        page.clear();
        await page.click(-0.5, 0.5);
        expect(page.lastMutation()).toEqual({
            op: 'removeCell',
            layerId: 'AllowedDoorLocations',
            cell: { x: -1, y: 0 },
        });
    });

    it('ignores a right-click on a cell set', async () => {
        const door = cellSetLayer({
            id: 'AllowedDoorLocations',
            label: 'AllowedDoorLocations',
            fieldName: 'AllowedDoorLocations',
            domain: 'outside',
            cells: [],
        });
        await page.render(partGrid([door]));
        page.clear();
        await page.click(-0.5, 0.5, 2);
        expect(page.mutations).toEqual([]);
    });

    it('toggles a plain inside cell set', async () => {
        const blocked = cellSetLayer({
            id: 'BlockedTravelCells',
            label: 'BlockedTravelCells',
            fieldName: 'BlockedTravelCells',
            cells: [{ cell: { x: 1, y: 1 }, origin: LOCAL_ORIGIN }],
        });
        await page.render(partGrid([blocked]));
        page.clear();
        await page.click(1.5, 1.5);
        await page.click(2.5, 2.5);
        expect(page.mutations).toEqual([
            { op: 'removeCell', layerId: 'BlockedTravelCells', cell: { x: 1, y: 1 } },
            { op: 'addCell', layerId: 'BlockedTravelCells', cell: { x: 2, y: 2 } },
        ]);
    });

    it('keeps a base-cell layer local to its own grid rect', async () => {
        const disabled = cellSetLayer({
            id: 'DisableCells',
            label: 'DisableCells',
            fieldName: 'DisableCells',
            group: 'Resources',
            baseCell: { x: 1, y: 1 },
            cells: [{ cell: { x: 0, y: 0 }, origin: LOCAL_ORIGIN }],
        });
        await page.render(partGrid([disabled]));
        page.clear();
        await page.click(2.5, 2.5);
        await page.click(1.5, 1.5);
        expect(page.mutations).toEqual([
            { op: 'addCell', layerId: 'DisableCells', cell: { x: 1, y: 1 } },
            { op: 'removeCell', layerId: 'DisableCells', cell: { x: 0, y: 0 } },
        ]);
    });
});

describe('part grid webview cell-to-values flags model', () => {
    /** The external walls map, the flags model that authors AdjacencyFlags per cell. */
    const walls = (entries: CellToValuesLayerData['entries'] = []) =>
        cellToValuesLayer({
            id: 'ExternalWallsByCell',
            label: 'ExternalWallsByCell',
            fieldName: 'ExternalWallsByCell',
            valueModel: 'flags',
            entries,
        });

    it('toggles the flag nearest the clicked cell edge', async () => {
        await page.render(partGrid([walls()]));
        page.clear();
        await page.click(1.5, 1.1);
        expect(page.lastMutation()).toEqual({
            op: 'setEntryValues',
            layerId: 'ExternalWallsByCell',
            cell: { x: 1, y: 1 },
            values: ['Top'],
        });
    });

    it('toggles an authored flag back off', async () => {
        await page.render(partGrid([walls([{ cell: { x: 1, y: 1 }, values: ['Top'], origin: LOCAL_ORIGIN }])]));
        page.clear();
        await page.click(1.5, 1.1);
        expect(page.lastMutation()).toEqual({
            op: 'setEntryValues',
            layerId: 'ExternalWallsByCell',
            cell: { x: 1, y: 1 },
            values: [],
        });
    });

    it('selects the cell without editing when the click lands in the middle', async () => {
        await page.render(partGrid([walls([{ cell: { x: 2, y: 2 }, values: ['Top'], origin: LOCAL_ORIGIN }])]));
        page.clear();
        await page.click(2.5, 2.5);
        expect(page.mutations).toEqual([]);
        await page.clickButton('Right', page.layerPanel());
        expect(page.lastMutation()).toEqual({
            op: 'setEntryValues',
            layerId: 'ExternalWallsByCell',
            cell: { x: 2, y: 2 },
            values: ['Top', 'Right'],
        });
    });

    it('writes a flags shortcut from the panel', async () => {
        await page.render(partGrid([walls()]));
        page.clear();
        await page.click(2.5, 2.5);
        await page.clickButton('Sides', page.layerPanel());
        expect(page.lastMutation()).toEqual({
            op: 'setEntryValues',
            layerId: 'ExternalWallsByCell',
            cell: { x: 2, y: 2 },
            values: ['Sides'],
        });
    });

    it('clears the cell entry on a right-click', async () => {
        await page.render(partGrid([walls([{ cell: { x: 2, y: 2 }, values: ['Top'], origin: LOCAL_ORIGIN }])]));
        page.clear();
        await page.click(2.5, 2.5, 2);
        expect(page.lastMutation()).toEqual({
            op: 'setEntryValues',
            layerId: 'ExternalWallsByCell',
            cell: { x: 2, y: 2 },
            values: [],
        });
    });
});

describe('part grid webview cell-to-values direction-list model', () => {
    /** The blocked travel directions map, the enum-list model with per-value toggles. */
    const directions = (entries: CellToValuesLayerData['entries'] = []) =>
        cellToValuesLayer({
            id: 'BlockedTravelCellDirections',
            label: 'BlockedTravelCellDirections',
            fieldName: 'BlockedTravelCellDirections',
            valueModel: 'enumList',
            enumRef: 'Cosmoteer.Ships.TravelDirection',
            enumNames: TRAVEL_NAMES,
            entries,
        });

    it('selects a cell without writing anything', async () => {
        await page.render(partGrid([directions()]));
        page.clear();
        await page.click(1.5, 1.1);
        expect(page.mutations).toEqual([]);
    });

    it('adds a direction to the selected cell from the panel toggles', async () => {
        await page.render(partGrid([directions()]));
        page.clear();
        await page.click(1.5, 1.5);
        await page.clickButton('Up', page.layerPanel());
        expect(page.lastMutation()).toEqual({
            op: 'setEntryValues',
            layerId: 'BlockedTravelCellDirections',
            cell: { x: 1, y: 1 },
            values: ['Up'],
        });
    });

    it('removes a direction that the cell already carries', async () => {
        const authored = [{ cell: { x: 1, y: 1 }, values: ['Up', 'Left'], origin: LOCAL_ORIGIN }];
        await page.render(partGrid([directions(authored)]));
        page.clear();
        await page.click(1.5, 1.5);
        await page.clickButton('Left', page.layerPanel());
        expect(page.lastMutation()).toEqual({
            op: 'setEntryValues',
            layerId: 'BlockedTravelCellDirections',
            cell: { x: 1, y: 1 },
            values: ['Up'],
        });
    });

    it('clears the cell entry on a right-click', async () => {
        const authored = [{ cell: { x: 1, y: 1 }, values: ['Up'], origin: LOCAL_ORIGIN }];
        await page.render(partGrid([directions(authored)]));
        page.clear();
        await page.click(1.5, 1.5, 2);
        expect(page.lastMutation()).toEqual({
            op: 'setEntryValues',
            layerId: 'BlockedTravelCellDirections',
            cell: { x: 1, y: 1 },
            values: [],
        });
    });
});

describe('part grid webview component gizmo', () => {
    /** Two components sharing one marker, plus a chain parent and the component riding it. */
    const gizmo = () =>
        componentPointsLayer([
            componentEntry({ component: 'gun', label: 'gun turret' }),
            componentEntry({ component: 'sight', label: 'gun sight', typeName: 'Sight' }),
            componentEntry({ component: 'base', label: 'turret base', location: { x: 3, y: 1 }, rotationDeg: 90 }),
            componentEntry({
                component: 'arm',
                label: 'turret arm',
                location: { x: 3, y: 2 },
                chainedTo: 'base',
            }),
        ]);

    it('cycles the selection when a stack of markers is clicked', async () => {
        await page.render(partGrid([gizmo()]));
        page.clear();
        await page.click(1, 1);
        await page.clickButton('90°', page.layerPanel());
        await page.click(1, 1);
        await page.clickButton('90°', page.layerPanel());
        await page.click(1, 1);
        await page.clickButton('90°', page.layerPanel());
        expect(page.mutations).toEqual([
            { op: 'setComponentRotation', component: 'gun', degrees: 90 },
            { op: 'setComponentRotation', component: 'sight', degrees: 90 },
            { op: 'setComponentRotation', component: 'gun', degrees: 90 },
        ]);
    });

    it('writes no mutation for a press that only selects', async () => {
        await page.render(partGrid([gizmo()]));
        page.clear();
        await page.click(1, 1);
        expect(page.mutations).toEqual([]);
    });

    it('clears the selection when the click misses every marker', async () => {
        await page.render(partGrid([gizmo()]));
        page.clear();
        await page.click(1, 1);
        await page.click(0, 3);
        expect(page.mutations).toEqual([]);
        expect(page.buttons('90°', page.layerPanel())).toEqual([]);
    });

    it('drags an unchained marker straight to the dropped point', async () => {
        await page.render(partGrid([gizmo()]));
        page.clear();
        await page.drag([3, 1], [2, 3]);
        expect(page.lastMutation()).toEqual({
            op: 'moveComponentLocation',
            component: 'base',
            point: { x: 2, y: 3 },
        });
    });

    it('writes a chained marker back through the inverse chain transform', async () => {
        await page.render(partGrid([gizmo()]));
        page.clear();
        await page.drag([3, 2], [4, 1]);
        expect(page.lastMutation()).toEqual({
            op: 'moveComponentLocation',
            component: 'arm',
            point: { x: 0, y: -1 },
        });
    });

    it('writes the rotation typed into the panel', async () => {
        await page.render(partGrid([gizmo()]));
        page.clear();
        await page.click(1, 1);
        page.input(page.layerPanel()).value = '45';
        await page.clickButton('Set', page.layerPanel());
        expect(page.lastMutation()).toEqual({ op: 'setComponentRotation', component: 'gun', degrees: 45 });
    });
});

describe('part grid webview undo and redo', () => {
    it('round-trips a circle setPoint through the point accessor', async () => {
        await page.render(partGrid([circleLayer()]));
        page.clear();
        await page.click(3.2, 2);
        await page.keyDown({ key: 'z', ctrlKey: true });
        await page.keyDown({ key: 'y', ctrlKey: true });
        expect(page.mutations).toEqual([
            { op: 'setPoint', layerId: 'BuffArea', point: { x: 3.25, y: 2 } },
            { op: 'setPoint', layerId: 'BuffArea', point: { x: 2, y: 2 } },
            { op: 'setPoint', layerId: 'BuffArea', point: { x: 3.25, y: 2 } },
        ]);
    });

    it('round-trips an edge region setNumber through the number accessor', async () => {
        await page.render(partGrid([edgeRegionLayer(2)], { margin: 4 }));
        page.clear();
        page.input(page.layerPanel()).value = '3';
        await page.clickButton('Set', page.layerPanel());
        await page.keyDown({ key: 'z', ctrlKey: true });
        await page.keyDown({ key: 'y', ctrlKey: true });
        expect(page.mutations).toEqual([
            { op: 'setNumber', layerId: 'Region', field: 'Distance', value: 3 },
            { op: 'setNumber', layerId: 'Region', field: 'Distance', value: 2 },
            { op: 'setNumber', layerId: 'Region', field: 'Distance', value: 3 },
        ]);
    });

    it('undoes a circle centre that the payload never carried by removing the field', async () => {
        await page.render(partGrid([circleLayer({ center: null })]));
        page.clear();
        await page.click(3.2, 3.2);
        await page.keyDown({ key: 'z', ctrlKey: true });
        expect(page.mutations).toEqual([
            { op: 'setPoint', layerId: 'BuffArea', point: { x: 3.25, y: 3.25 } },
            { op: 'setPoint', layerId: 'BuffArea', point: null },
        ]);
    });

    it('does nothing when there is nothing left to undo', async () => {
        await page.render(partGrid([circleLayer()]));
        page.clear();
        await page.keyDown({ key: 'z', ctrlKey: true });
        expect(page.mutations).toEqual([]);
    });
});

describe('part grid webview layer list', () => {
    /** One layer of every kind, each with an entry count the badge has to report. */
    const everyKind = (): GridLayerData[] => [
        cellSetLayer({
            id: 'BlockedTravelCells',
            label: 'BlockedTravelCells',
            fieldName: 'BlockedTravelCells',
            cells: [
                { cell: { x: 0, y: 0 }, origin: LOCAL_ORIGIN },
                { cell: { x: 1, y: 0 }, origin: LOCAL_ORIGIN },
            ],
        }),
        cellToValuesLayer({
            id: 'ExternalWallsByCell',
            label: 'ExternalWallsByCell',
            fieldName: 'ExternalWallsByCell',
            valueModel: 'flags',
            entries: [{ cell: { x: 0, y: 0 }, values: ['Top'], origin: LOCAL_ORIGIN }],
        }),
        {
            ...LAYER_BASE,
            kind: 'pointList',
            id: 'CrewDestinations',
            label: 'CrewDestinations',
            fieldName: 'CrewDestinations',
            points: [
                { point: { x: 0.5, y: 0.5 }, origin: LOCAL_ORIGIN },
                { point: { x: 1.5, y: 0.5 }, origin: LOCAL_ORIGIN },
                { point: { x: 2.5, y: 0.5 }, origin: LOCAL_ORIGIN },
            ],
        },
        {
            ...LAYER_BASE,
            kind: 'cellPairList',
            id: 'VirtualInternalCells',
            label: 'VirtualInternalCells',
            fieldName: 'VirtualInternalCells',
            pairs: [{ external: { x: -1, y: 0 }, internal: { x: 0, y: 0 }, origin: LOCAL_ORIGIN }],
        },
        {
            ...LAYER_BASE,
            kind: 'point',
            id: 'PickUpLocation',
            label: 'PickUpLocation',
            fieldName: 'PickUpLocation',
            point: { x: 1.5, y: 1.5 },
        },
        {
            ...LAYER_BASE,
            kind: 'cell',
            id: 'AdjacentCell',
            label: 'AdjacentCell',
            fieldName: 'AdjacentCell',
            cell: { x: 2, y: 2 },
        },
        {
            ...LAYER_BASE,
            kind: 'cellDirection',
            id: 'NetworkPort',
            label: 'NetworkPort',
            fieldName: 'NetworkPort',
            cell: { x: 3, y: 3 },
            direction: 'Up',
            directions: TRAVEL_NAMES,
        },
        cellRayLayer(),
        {
            ...LAYER_BASE,
            kind: 'polygon',
            id: 'Vertices',
            label: 'Vertices',
            fieldName: 'Vertices',
            vertices: [
                { point: { x: 0, y: 0 }, origin: LOCAL_ORIGIN },
                { point: { x: 4, y: 0 }, origin: LOCAL_ORIGIN },
                { point: { x: 4, y: 4 }, origin: LOCAL_ORIGIN },
            ],
        },
        circleLayer(),
        edgeRegionLayer(2),
        {
            ...LAYER_BASE,
            kind: 'rectList',
            id: 'ProhibitRects',
            label: 'ProhibitRects',
            fieldName: 'ProhibitRects',
            entries: [{ tag: 'tall', rect: rect(0, -1, 4, 1), origin: LOCAL_ORIGIN }],
            fallbackRects: [],
        },
        componentPointsLayer([
            componentEntry({ component: 'gun', label: 'gun turret' }),
            componentEntry({ component: 'base', label: 'turret base', location: { x: 3, y: 1 } }),
        ]),
        rectLayer(rect(0, 0, 4, 4)),
    ];

    it('shows the authored count of every layer kind', async () => {
        await page.render(partGrid(everyKind()));
        const counts = new Map([
            ['BlockedTravelCells', '2'],
            ['ExternalWallsByCell', '1'],
            ['CrewDestinations', '3'],
            ['VirtualInternalCells', '1'],
            ['PickUpLocation', '1'],
            ['AdjacentCell', '1'],
            ['NetworkPort', '1'],
            ['Line', '1'],
            ['Vertices', '3'],
            ['BuffArea', '1'],
            ['Region', '1'],
            ['ProhibitRects', '1'],
            ['Component locations', '2'],
            ['PhysicalRect', '1'],
        ]);
        for (const [label, expected] of counts) {
            expect(countBadge(page.layerRow(label)), label).toBe(expected);
        }
    });

    it('starts every layer that holds entries visible', async () => {
        await page.render(partGrid(everyKind()));
        for (const label of ['BlockedTravelCells', 'Vertices', 'Component locations', 'PhysicalRect']) {
            expect(visibilityBox(page.layerRow(label)).checked, label).toBe(true);
        }
    });

    it('leaves an empty layer hidden and unbadged', async () => {
        const populated = cellSetLayer({
            id: 'BlockedTravelCells',
            label: 'BlockedTravelCells',
            fieldName: 'BlockedTravelCells',
            cells: [{ cell: { x: 0, y: 0 }, origin: LOCAL_ORIGIN }],
        });
        await page.render(partGrid([populated, rectLayer(null)]));
        const row = page.layerRow('PhysicalRect');
        expect(countBadge(row)).toBeNull();
        expect(visibilityBox(row).checked).toBe(false);
    });

    // A written zero is a value, not an absence. The payload types these as `number | null`, where
    // null means the value could not be read, so counting truthiness used to hide a layer the
    // author had explicitly written: it opened switched off, with no badge, and nothing said why.
    it('counts an edge region whose distance is written as zero', async () => {
        await page.render(partGrid([edgeRegionLayer(0)]));
        const row = page.layerRow('Region');
        expect(countBadge(row)).toBe('1');
        expect(visibilityBox(row).checked).toBe(true);
    });

    // The first layer of a payload becomes the active one and is shown whatever it counts, so an
    // unreadable value has to be judged from a payload where something else holds that place.
    it('leaves an edge region whose distance could not be read hidden', async () => {
        await page.render(partGrid([rectLayer(rect(0, 0, 4, 4)), edgeRegionLayer(null)]));
        const row = page.layerRow('Region');
        expect(countBadge(row)).toBeNull();
        expect(visibilityBox(row).checked).toBe(false);
    });

    it('counts a circle whose radius is written as zero', async () => {
        await page.render(partGrid([circleLayer({ center: null, radius: 0 })]));
        const row = page.layerRow('BuffArea');
        expect(countBadge(row)).toBe('1');
        expect(visibilityBox(row).checked).toBe(true);
    });

    it('leaves a circle with neither a centre nor a radius hidden', async () => {
        await page.render(partGrid([rectLayer(rect(0, 0, 4, 4)), circleLayer({ center: null, radius: null })]));
        const row = page.layerRow('BuffArea');
        expect(countBadge(row)).toBeNull();
        expect(visibilityBox(row).checked).toBe(false);
    });

    it('refuses canvas edits on a layer that was switched off', async () => {
        await page.render(partGrid([rectLayer(rect(0, 0, 4, 4))]));
        page.clear();
        const box = visibilityBox(page.layerRow('PhysicalRect'));
        box.checked = false;
        box.dispatch('change');
        page.mouseDown(0, 0);
        expect(page.status()).toContain('hidden');
        page.mouseMove(1, 1);
        page.mouseUp();
        await page.settle();
        expect(page.mutations).toEqual([]);
    });

    it('makes a layer editable through its legend radio', async () => {
        const populated = cellSetLayer({
            id: 'BlockedTravelCells',
            label: 'BlockedTravelCells',
            fieldName: 'BlockedTravelCells',
            cells: [{ cell: { x: 0, y: 0 }, origin: LOCAL_ORIGIN }],
        });
        await page.render(partGrid([populated, rectLayer(rect(0, 0, 4, 4))]));
        page.clear();
        await page.activateLayer('PhysicalRect');
        await page.drag([0, 0], [1, 1]);
        expect(page.lastMutation()).toEqual({ op: 'setRect', layerId: 'PhysicalRect', rect: rect(1, 1, 3, 3) });
    });
});

describe('part grid webview rotated and flipped views', () => {
    /** A part wider than it is tall, so a view that forgets to swap its extents shows up. */
    const wide = () =>
        partGrid(
            [
                cellSetLayer({
                    id: 'BlockedTravelCells',
                    label: 'BlockedTravelCells',
                    fieldName: 'BlockedTravelCells',
                    cells: [],
                }),
            ],
            { size: { width: 4, height: 2, origin: null } }
        );

    it('lands a click on the cell under the cursor after a quarter turn', async () => {
        await page.render(wide());
        page.clear();
        await page.rotateView();
        await page.click(3.5, 0.5);
        expect(page.lastMutation()).toEqual({
            op: 'addCell',
            layerId: 'BlockedTravelCells',
            cell: { x: 3, y: 0 },
        });
    });

    it('lands a click on the cell under the cursor after three quarter turns', async () => {
        await page.render(wide());
        page.clear();
        await page.rotateView();
        await page.rotateView();
        await page.rotateView();
        await page.click(0.5, 1.5);
        expect(page.lastMutation()).toEqual({
            op: 'addCell',
            layerId: 'BlockedTravelCells',
            cell: { x: 0, y: 1 },
        });
    });

    it('lands a click on the cell under the cursor in a mirrored view', async () => {
        await page.render(wide());
        page.clear();
        await page.flipViewH();
        await page.click(3.5, 0.5);
        expect(page.lastMutation()).toEqual({
            op: 'addCell',
            layerId: 'BlockedTravelCells',
            cell: { x: 3, y: 0 },
        });
    });
});

describe('part grid webview single point and cell layers', () => {
    const pickUp = (point: { x: number; y: number } | null): PointLayerData => ({
        ...LAYER_BASE,
        kind: 'point',
        id: 'PickUpLocation',
        label: 'PickUpLocation',
        fieldName: 'PickUpLocation',
        point,
    });

    const adjacent = (cell: { x: number; y: number } | null): CellLayerData => ({
        ...LAYER_BASE,
        kind: 'cell',
        id: 'AdjacentCell',
        label: 'AdjacentCell',
        fieldName: 'AdjacentCell',
        cell,
    });

    it('places a single point away from the authored one', async () => {
        await page.render(partGrid([pickUp({ x: 1.5, y: 1.5 })]));
        page.clear();
        await page.click(3.2, 3.2);
        expect(page.lastMutation()).toEqual({
            op: 'setPoint',
            layerId: 'PickUpLocation',
            point: { x: 3.25, y: 3.25 },
        });
    });

    it('drags the authored point to a snapped position', async () => {
        await page.render(partGrid([pickUp({ x: 1.5, y: 1.5 })]));
        page.clear();
        await page.drag([1.5, 1.5], [2.2, 2.2]);
        expect(page.lastMutation()).toEqual({
            op: 'setPoint',
            layerId: 'PickUpLocation',
            point: { x: 2.25, y: 2.25 },
        });
    });

    it('removes the single point on a right-click', async () => {
        await page.render(partGrid([pickUp({ x: 1.5, y: 1.5 })]));
        page.clear();
        await page.click(1.5, 1.5, 2);
        expect(page.lastMutation()).toEqual({ op: 'setPoint', layerId: 'PickUpLocation', point: null });
    });

    it('sets and clears a single cell', async () => {
        await page.render(partGrid([adjacent({ x: 2, y: 2 })]));
        page.clear();
        await page.click(1.5, 0.5);
        await page.click(1.5, 0.5, 2);
        expect(page.mutations).toEqual([
            { op: 'setCell', layerId: 'AdjacentCell', cell: { x: 1, y: 0 } },
            { op: 'setCell', layerId: 'AdjacentCell', cell: null },
        ]);
    });

    it('moves a cell-with-facing layer through the shared hit-test', async () => {
        const port: CellDirectionLayerData = {
            ...LAYER_BASE,
            kind: 'cellDirection',
            id: 'NetworkPort',
            label: 'NetworkPort',
            fieldName: 'NetworkPort',
            cell: { x: 1, y: 1 },
            direction: 'Up',
            directions: TRAVEL_NAMES,
        };
        await page.render(partGrid([port]));
        page.clear();
        await page.click(3.5, 3.5);
        expect(page.lastMutation()).toEqual({ op: 'setCell', layerId: 'NetworkPort', cell: { x: 3, y: 3 } });
    });
});

describe('part grid webview point list layer', () => {
    const crew = (overrides: Partial<PointListLayerData> = {}): PointListLayerData => ({
        ...LAYER_BASE,
        kind: 'pointList',
        id: 'CrewDestinations',
        label: 'CrewDestinations',
        fieldName: 'CrewDestinations',
        group: 'Crew',
        points: [{ point: { x: 1.5, y: 1.5 }, origin: LOCAL_ORIGIN }],
        ...overrides,
    });

    it('appends a point where the click landed', async () => {
        await page.render(partGrid([crew()]));
        page.clear();
        await page.click(3.2, 3.2);
        expect(page.lastMutation()).toEqual({
            op: 'addPoint',
            layerId: 'CrewDestinations',
            point: { x: 3.25, y: 3.25 },
        });
    });

    it('moves an existing point by its index', async () => {
        await page.render(partGrid([crew()]));
        page.clear();
        await page.drag([1.5, 1.5], [2.2, 2.2]);
        expect(page.lastMutation()).toEqual({
            op: 'movePoint',
            layerId: 'CrewDestinations',
            index: 0,
            point: { x: 2.25, y: 2.25 },
        });
    });

    it('removes a point on a right-click', async () => {
        await page.render(partGrid([crew()]));
        page.clear();
        await page.click(1.5, 1.5, 2);
        expect(page.lastMutation()).toEqual({ op: 'removePoint', layerId: 'CrewDestinations', index: 0 });
    });

    it('neither adds nor removes when the list has a fixed length', async () => {
        await page.render(partGrid([crew({ fixedCount: true })]));
        page.clear();
        await page.click(3.2, 3.2);
        await page.click(1.5, 1.5, 2);
        expect(page.mutations).toEqual([]);
    });
});

describe('part grid webview polygon layer', () => {
    const collider = (): PolygonLayerData => ({
        ...LAYER_BASE,
        kind: 'polygon',
        id: 'Vertices',
        label: 'Vertices',
        fieldName: 'Vertices',
        group: 'Colliders',
        vertices: [
            { point: { x: 0, y: 0 }, origin: LOCAL_ORIGIN },
            { point: { x: 4, y: 0 }, origin: LOCAL_ORIGIN },
            { point: { x: 4, y: 4 }, origin: LOCAL_ORIGIN },
        ],
    });

    it('drags a vertex to a snapped position', async () => {
        await page.render(partGrid([collider()]));
        page.clear();
        await page.drag([0, 0], [1.1, 1.1]);
        expect(page.lastMutation()).toEqual({
            op: 'moveVertex',
            layerId: 'Vertices',
            index: 0,
            point: { x: 1, y: 1 },
        });
    });

    it('removes a vertex on a right-click', async () => {
        await page.render(partGrid([collider()]));
        page.clear();
        await page.click(4, 0, 2);
        expect(page.lastMutation()).toEqual({ op: 'removeVertex', layerId: 'Vertices', index: 1 });
    });

    it('inserts a vertex into the edge that was clicked', async () => {
        await page.render(partGrid([collider()]));
        page.clear();
        await page.click(2, 0.05);
        expect(page.lastMutation()).toEqual({
            op: 'insertVertex',
            layerId: 'Vertices',
            index: 1,
            point: { x: 2, y: 0 },
        });
    });

    it('appends a vertex when the click misses every edge', async () => {
        await page.render(partGrid([collider()]));
        page.clear();
        await page.click(2, 3);
        expect(page.lastMutation()).toEqual({
            op: 'insertVertex',
            layerId: 'Vertices',
            index: 3,
            point: { x: 2, y: 3 },
        });
    });
});

describe('part grid webview cell pair layer', () => {
    const virtualCells = (pairs: CellPairListLayerData['pairs'] = []): CellPairListLayerData => ({
        ...LAYER_BASE,
        kind: 'cellPairList',
        id: 'VirtualInternalCells',
        label: 'VirtualInternalCells',
        fieldName: 'VirtualInternalCells',
        pairs,
    });

    it('pairs an external cell with an internal one over two clicks', async () => {
        await page.render(partGrid([virtualCells()]));
        page.clear();
        await page.click(-0.5, 0.5);
        expect(page.mutations).toEqual([]);
        expect(page.status()).toContain('internal cell');
        await page.click(0.5, 0.5);
        expect(page.lastMutation()).toEqual({
            op: 'setPair',
            layerId: 'VirtualInternalCells',
            index: null,
            external: { x: -1, y: 0 },
            internal: { x: 0, y: 0 },
        });
    });

    it('cancels a half-finished pair on a right-click', async () => {
        await page.render(partGrid([virtualCells()]));
        page.clear();
        await page.click(-0.5, 0.5);
        await page.click(-0.5, 0.5, 2);
        await page.click(0.5, 0.5);
        expect(page.mutations).toEqual([]);
    });

    it('removes a pair when either of its cells is right-clicked', async () => {
        const pairs = [{ external: { x: -1, y: 0 }, internal: { x: 0, y: 0 }, origin: LOCAL_ORIGIN }];
        await page.render(partGrid([virtualCells(pairs)]));
        page.clear();
        await page.click(0.5, 0.5, 2);
        expect(page.lastMutation()).toEqual({ op: 'removePair', layerId: 'VirtualInternalCells', index: 0 });
    });
});

describe('part grid webview rect list layer', () => {
    const prohibit = (): RectListLayerData => ({
        ...LAYER_BASE,
        kind: 'rectList',
        id: 'ProhibitRects',
        label: 'ProhibitRects',
        fieldName: 'ProhibitRects',
        entries: [{ tag: 'tall', rect: rect(0, -1, 4, 1), origin: LOCAL_ORIGIN }],
        fallbackRects: [],
    });

    it('drags the handle of a tagged rect', async () => {
        await page.render(partGrid([prohibit()]));
        page.clear();
        await page.drag([4, 0], [3, 1]);
        expect(page.lastMutation()).toEqual({
            op: 'setRectEntry',
            layerId: 'ProhibitRects',
            index: 0,
            tag: null,
            rect: rect(0, -1, 3, 2),
        });
    });

    it('removes a tagged rect on a right-click of its handle', async () => {
        await page.render(partGrid([prohibit()]));
        page.clear();
        await page.click(0, -1, 2);
        expect(page.lastMutation()).toEqual({ op: 'removeRectEntry', layerId: 'ProhibitRects', index: 0 });
    });

    it('appends a tagged rect from the panel', async () => {
        await page.render(partGrid([prohibit()]));
        page.clear();
        page.input(page.layerPanel()).value = 'wide';
        await page.clickButton('Add rect', page.layerPanel());
        expect(page.lastMutation()).toEqual({
            op: 'setRectEntry',
            layerId: 'ProhibitRects',
            index: null,
            tag: 'wide',
            rect: rect(0, -1, 4, 1),
        });
    });
});
