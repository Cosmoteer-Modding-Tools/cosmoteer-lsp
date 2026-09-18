import { beforeEach, describe, expect, it } from 'vitest';
import type {
    CellSetLayerData,
    GridLayerData,
    PartGridData,
    SpriteLayerData,
} from '../../../src/features/part-editor/part-grid.types';
import {
    ADJACENCY_NAMES,
    DrawRecord,
    GridHarness,
    LAYER_BASE,
    LOCAL_ORIGIN,
    StubElement,
    TRAVEL_NAMES,
    loadGridWebview,
    partGrid,
} from './part-grid-webview.harness';

/**
 * What the part grid editor page actually draws, read off the recording its 2D context keeps.
 *
 * The interaction suite asserts the mutations a gesture posts, which is the contract with the
 * server. These tests cover the other half: the picture. They are the questions a human was being
 * asked to eyeball, and every one of them has a right answer rather than a taste: a door strip
 * belongs on the wall the door opens through, an inherited value is drawn as a ghost, a roof draws
 * over the interior it covers, and every layer kind draws something at all.
 */

let page: GridHarness;

beforeEach(() => {
    page = loadGridWebview();
});

/** A cell origin marking a value that only exists on a base part. */
const INHERITED_ORIGIN = { ...LOCAL_ORIGIN, inherited: true };

/** The browser allocation limits the page keeps its backing store under, as the page states them. */
const MAX_CANVAS_DIMENSION = 8192;
const MAX_CANVAS_AREA = 1 << 25;

/** The calls that put ink on the canvas, as opposed to the ones that build a path. */
const PAINTS = new Set(['fill', 'stroke', 'fillRect', 'strokeRect', 'fillText', 'drawImage']);

/**
 * Asserts the four numbers of a recorded rect call.
 *
 * @param record the `fillRect` or `strokeRect` call to read.
 * @param expected the x, y, width and height it should carry.
 */
function expectRect(record: DrawRecord, expected: [number, number, number, number]): void {
    const actual = record.args.map(Number);
    for (const [index, value] of expected.entries()) expect(actual[index]).toBeCloseTo(value, 6);
}

/** The x, y, width and height of a recorded rect call. */
function rectOf(record: DrawRecord): { x: number; y: number; width: number; height: number } {
    const [x, y, width, height] = record.args.map(Number);
    return { x, y, width, height };
}

/** A door strip is the only thing the page fills that is narrow in exactly one direction. */
function isStrip(record: DrawRecord): boolean {
    const { width, height } = rectOf(record);
    return (width === 0.64 && height === 0.28) || (width === 0.28 && height === 0.64);
}

/** How many ink-laying calls the most recent draw pass made. */
function paintCount(harness: GridHarness): number {
    return harness.frame().filter((entry) => !entry.set && PAINTS.has(entry.name)).length;
}

/** The visibility checkbox of a legend row. */
function visibilityBox(row: StubElement): StubElement {
    const box = row.children.find((child) => child.tagName === 'INPUT' && child.type === 'checkbox');
    if (!box) throw new Error('the legend row has no visibility checkbox');
    return box;
}

/** A door ring layer: cells outside the part, each naming the wall a door opens through. */
function doorLayer(cells: Array<{ x: number; y: number }>): CellSetLayerData {
    return {
        ...LAYER_BASE,
        kind: 'cellSet',
        id: 'AllowedDoorLocations',
        label: 'AllowedDoorLocations',
        fieldName: 'AllowedDoorLocations',
        domain: 'outside',
        cells: cells.map((cell) => ({ cell, origin: LOCAL_ORIGIN })),
    };
}

/** A plain inside cell set, the simplest layer that fills cells. */
function insideLayer(overrides: Partial<CellSetLayerData> = {}): CellSetLayerData {
    return {
        ...LAYER_BASE,
        kind: 'cellSet',
        id: 'BlockedTravelCells',
        label: 'BlockedTravelCells',
        fieldName: 'BlockedTravelCells',
        domain: 'inside',
        cells: [{ cell: { x: 0, y: 0 }, origin: LOCAL_ORIGIN }],
        ...overrides,
    };
}

/** A sprite entry, with the parts a test does not care about filled in. */
function spriteLayer(overrides: Partial<SpriteLayerData> & Pick<SpriteLayerData, 'id'>): SpriteLayerData {
    return {
        label: overrides.id,
        uri: `file:///${overrides.id}.png`,
        offset: [0, 0],
        size: null,
        defaultVisible: true,
        ...overrides,
    };
}

describe('part grid webview door strips', () => {
    /** A door on the north, south, west and east wall of the 4x4 part, in that order. */
    const ring = (): PartGridData =>
        partGrid(
            [
                doorLayer([
                    { x: 1, y: -1 },
                    { x: 1, y: 4 },
                    { x: -1, y: 1 },
                    { x: 4, y: 1 },
                ]),
            ],
            { margin: 3 }
        );

    it('draws each door strip on the wall its cell shares with the part', async () => {
        await page.render(ring());
        const strips = page.calls('fillRect').filter(isStrip);
        expect(strips).toHaveLength(4);
        const [north, south, west, east] = strips.map(rectOf);

        // The part is 4x4 at the origin, so its walls are the lines y=0, y=4, x=0 and x=4. Each
        // strip straddles the wall it belongs to and runs along it.
        expect(north.y).toBeLessThan(0);
        expect(north.y + north.height).toBeGreaterThan(0);
        expect(north.width).toBeGreaterThan(north.height);

        expect(south.y).toBeLessThan(4);
        expect(south.y + south.height).toBeGreaterThan(4);
        expect(south.width).toBeGreaterThan(south.height);

        expect(west.x).toBeLessThan(0);
        expect(west.x + west.width).toBeGreaterThan(0);
        expect(west.height).toBeGreaterThan(west.width);

        expect(east.x).toBeLessThan(4);
        expect(east.x + east.width).toBeGreaterThan(4);
        expect(east.height).toBeGreaterThan(east.width);

        // And the four differ in the direction the door faces, not just in shape.
        expect(north.y).toBeLessThan(south.y);
        expect(west.x).toBeLessThan(east.x);
    });

    it('puts the strip on the wall the physical rect declares, not on the part edge', async () => {
        // A part whose physical rect is inset by one cell: the door cell at (1,0) is inside the
        // part but outside the rect, so its strip sits on the rect's top wall at y=1.
        const inset: GridLayerData = {
            ...LAYER_BASE,
            kind: 'rect',
            id: 'PhysicalRect',
            label: 'PhysicalRect',
            fieldName: 'PhysicalRect',
            rect: { x: 0, y: 1, width: 4, height: 3 },
        };
        await page.render(partGrid([doorLayer([{ x: 1, y: 0 }]), inset]));
        const [strip] = page.calls('fillRect').filter(isStrip);
        expectRect(strip, [1.18, 0.86, 0.64, 0.28]);
    });

    it('draws a door cell that shares no wall as a dashed dead entry', async () => {
        await page.render(
            partGrid(
                [
                    doorLayer([
                        { x: 1, y: -1 },
                        { x: 6, y: 6 },
                    ]),
                ],
                { margin: 3 }
            )
        );
        // The live door draws its strip solid, the dead one draws no strip at all and marks the
        // cell dashed instead.
        const strips = page.calls('fillRect').filter(isStrip);
        expect(strips).toHaveLength(1);
        expect(strips[0].state.lineDash).toEqual([]);

        const dead = page.calls('fillRect').find((entry) => rectOf(entry).x === 6.05);
        expect(dead).toBeDefined();
        expect(dead?.state.lineDash.length).toBeGreaterThan(0);
        expectRect(dead as DrawRecord, [6.05, 6.05, 0.9, 0.9]);
    });
});

describe('part grid webview ghost rendering', () => {
    /** The fill of the one cell the layer carries. */
    const cellFill = (harness: GridHarness) =>
        harness.calls('fillRect').find((entry) => rectOf(entry).width === 0.9) as DrawRecord;

    it('draws a layer inherited from a base part dashed and dimmed', async () => {
        await page.render(partGrid([insideLayer()]));
        const local = cellFill(page);
        expect(local.state.lineDash).toEqual([]);

        const ghosted = loadGridWebview();
        await ghosted.render(partGrid([insideLayer({ inherited: true, origin: INHERITED_ORIGIN })]));
        const inherited = cellFill(ghosted);
        expect(inherited.state.lineDash.length).toBeGreaterThan(0);
        // The ghost modifier halves the alpha the same fill would have used locally.
        expect(inherited.state.globalAlpha).toBeCloseTo(local.state.globalAlpha / 2, 6);
    });

    it('ghosts only the entries a local layer inherited', async () => {
        await page.render(
            partGrid([
                insideLayer({
                    cells: [
                        { cell: { x: 0, y: 0 }, origin: LOCAL_ORIGIN },
                        { cell: { x: 1, y: 0 }, origin: INHERITED_ORIGIN },
                    ],
                }),
            ])
        );
        const fills = page.calls('fillRect').filter((entry) => rectOf(entry).width === 0.9);
        expect(fills).toHaveLength(2);
        expect(fills[0].state.lineDash).toEqual([]);
        expect(fills[1].state.lineDash.length).toBeGreaterThan(0);
        expect(fills[1].state.globalAlpha).toBeCloseTo(fills[0].state.globalAlpha / 2, 6);
    });

    it('ghosts a circle whose centre the payload never carried', async () => {
        // The centre falls back to the middle of the part, and the fallback says so by drawing
        // dashed rather than by pretending the part authored it.
        await page.render(
            partGrid([
                {
                    ...LAYER_BASE,
                    kind: 'circle',
                    id: 'BuffArea',
                    label: 'BuffArea',
                    fieldName: 'BuffArea',
                    center: null,
                    radius: 1.5,
                    radiusField: 'BuffRadius',
                    centerEditable: true,
                },
            ])
        );
        const [ring] = page.calls('fill');
        expect(ring.state.lineDash.length).toBeGreaterThan(0);
        expect(ring.state.globalAlpha).toBeCloseTo(0.06, 6);
    });
});

describe('part grid webview draw order', () => {
    /** The index of the first call of a name in the frame. */
    const firstIndex = (harness: GridHarness, name: string) => {
        const [found] = harness.calls(name);
        if (!found) throw new Error(`the frame holds no ${name} call`);
        return found.index;
    };

    it('draws the sprites in payload order, so a roof covers the interior under it', async () => {
        await page.render(
            partGrid([insideLayer()], {
                sprites: [spriteLayer({ id: 'floor' }), spriteLayer({ id: 'walls' }), spriteLayer({ id: 'roof' })],
            }),
            { floor: 'data:floor', walls: 'data:walls', roof: 'data:roof' }
        );
        const drawn = page.calls('drawImage').map((entry) => (entry.args[0] as { src: string }).src);
        expect(drawn).toEqual(['data:floor', 'data:walls', 'data:roof']);
    });

    it('draws the layers in payload order rather than in sidebar group order', async () => {
        // The sidebar sorts Part before Graphics, the canvas does not sort at all. Pinning the
        // payload order is what keeps a later layer painting over an earlier one.
        const graphics = insideLayer({
            id: 'Overlay',
            label: 'Overlay',
            fieldName: 'Overlay',
            group: 'Graphics',
            cells: [{ cell: { x: 2, y: 2 }, origin: LOCAL_ORIGIN }],
        });
        await page.render(partGrid([graphics, insideLayer()]));
        const groups = page.descendants(page.section('Layers')).filter((node) => node.tagName === 'SUMMARY');
        expect(groups.map((node) => node.textContent.trim().split(' ')[0])).toEqual(['Part', 'Graphics']);

        const fills = page.calls('fillRect').filter((entry) => rectOf(entry).width === 0.9);
        expect(fills.map((entry) => rectOf(entry).x)).toEqual([2.05, 0.05]);
    });

    it('draws the sprites under the grid and the layers over it', async () => {
        await page.render(partGrid([insideLayer()], { sprites: [spriteLayer({ id: 'floor' })] }), {
            floor: 'data:floor',
        });
        const sprite = firstIndex(page, 'drawImage');
        // The part outline is the last thing the grid draws, the layer fill the first thing after it.
        const outline = page.calls('strokeRect').find((entry) => rectOf(entry).width === 4) as DrawRecord;
        const layerFill = page.calls('fillRect').find((entry) => rectOf(entry).width === 0.9) as DrawRecord;
        expect(sprite).toBeLessThan(outline.index);
        expect(outline.index).toBeLessThan(layerFill.index);
    });

    it('draws the in-progress gesture last of all', async () => {
        await page.render(
            partGrid([
                {
                    ...LAYER_BASE,
                    kind: 'cellToValues',
                    id: 'BlockedTravelCellDirections',
                    label: 'BlockedTravelCellDirections',
                    fieldName: 'BlockedTravelCellDirections',
                    valueModel: 'enumList',
                    enumRef: 'Cosmoteer.TravelDirection',
                    enumNames: TRAVEL_NAMES,
                    fallback: null,
                    entries: [{ cell: { x: 0, y: 0 }, values: ['Up'], origin: LOCAL_ORIGIN }],
                },
            ])
        );
        await page.click(2.5, 2.5);
        // Selecting a cell draws its marquee, and it has to sit over every layer or the selection
        // would disappear under the layer it belongs to.
        const marquee = page.calls('strokeRect').find((entry) => entry.state.strokeStyle === '#ffffff') as DrawRecord;
        expect(marquee).toBeDefined();
        expectRect(marquee, [2.02, 2.02, 0.96, 0.96]);
        const arrow = page.calls('stroke').at(-1) as DrawRecord;
        expect(arrow.index).toBeLessThan(marquee.index);
    });

    it('applies the view transform before anything is drawn', async () => {
        await page.render(partGrid([insideLayer()]));
        await page.rotateView();
        await page.flipViewH();
        const prologue = page
            .frame()
            .filter((entry) => ['setTransform', 'scale', 'rotate', 'translate'].includes(entry.name) && !entry.set)
            .slice(0, 5);
        const scale = page.scale();
        // The full transform, in the order it has to be composed: the backing-store scale and the
        // origin at the canvas centre, then the zoom, then the view rotation, then the mirror, and
        // last the shift that puts grid cell (0,0) where it belongs.
        expect(prologue.map((entry) => entry.name)).toEqual(['setTransform', 'scale', 'rotate', 'scale', 'translate']);
        expect(prologue[0].args).toEqual([1, 0, 0, 1, 288, 288]);
        expect(prologue[1].args).toEqual([scale, scale]);
        expect(prologue[2].args[0]).toBeCloseTo(Math.PI / 2, 6);
        expect(prologue[3].args).toEqual([-1, 1]);
        expect(prologue[4].args).toEqual([-2, -2]);
    });
});

describe('part grid webview layer kinds', () => {
    /** One populated layer of every kind the registry knows. */
    const LAYERS: ReadonlyArray<[string, GridLayerData]> = [
        ['cellSet', insideLayer()],
        [
            'cellToValues',
            {
                ...LAYER_BASE,
                kind: 'cellToValues',
                id: 'ExternalWallsByCell',
                label: 'ExternalWallsByCell',
                fieldName: 'ExternalWallsByCell',
                valueModel: 'flags',
                enumRef: 'Halfling.Geometry.AdjacencyFlags',
                enumNames: ADJACENCY_NAMES,
                fallback: null,
                entries: [{ cell: { x: 1, y: 1 }, values: ['Top', 'TopLeft'], origin: LOCAL_ORIGIN }],
            },
        ],
        [
            'pointList',
            {
                ...LAYER_BASE,
                kind: 'pointList',
                id: 'CrewDestinations',
                label: 'CrewDestinations',
                fieldName: 'CrewDestinations',
                points: [{ point: { x: 1.5, y: 1.5 }, origin: LOCAL_ORIGIN }],
            },
        ],
        [
            'cellPairList',
            {
                ...LAYER_BASE,
                kind: 'cellPairList',
                id: 'VirtualInternalCells',
                label: 'VirtualInternalCells',
                fieldName: 'VirtualInternalCells',
                pairs: [{ external: { x: -1, y: 0 }, internal: { x: 0, y: 0 }, origin: LOCAL_ORIGIN }],
            },
        ],
        [
            'point',
            {
                ...LAYER_BASE,
                kind: 'point',
                id: 'PickUpLocation',
                label: 'PickUpLocation',
                fieldName: 'PickUpLocation',
                point: { x: 2, y: 2 },
            },
        ],
        [
            'cell',
            {
                ...LAYER_BASE,
                kind: 'cell',
                id: 'PartLocation',
                label: 'PartLocation',
                fieldName: 'PartLocation',
                cell: { x: 1, y: 1 },
            },
        ],
        [
            'cellDirection',
            {
                ...LAYER_BASE,
                kind: 'cellDirection',
                id: 'NetworkPort',
                label: 'NetworkPort',
                fieldName: 'NetworkPort',
                cell: { x: 1, y: 1 },
                direction: 'Up',
                directions: TRAVEL_NAMES,
            },
        ],
        [
            'cellRay',
            {
                ...LAYER_BASE,
                kind: 'cellRay',
                id: 'Line',
                label: 'Line',
                fieldName: 'Line',
                cell: { x: 1, y: 1 },
                direction: 'Right',
                maxTiles: 3,
                directions: TRAVEL_NAMES,
            },
        ],
        [
            'polygon',
            {
                ...LAYER_BASE,
                kind: 'polygon',
                id: 'Vertices',
                label: 'Vertices',
                fieldName: 'Vertices',
                vertices: [
                    { point: { x: 0, y: 0 }, origin: LOCAL_ORIGIN },
                    { point: { x: 2, y: 0 }, origin: LOCAL_ORIGIN },
                    { point: { x: 2, y: 2 }, origin: LOCAL_ORIGIN },
                ],
            },
        ],
        [
            'circle',
            {
                ...LAYER_BASE,
                kind: 'circle',
                id: 'BuffArea',
                label: 'BuffArea',
                fieldName: 'BuffArea',
                center: { x: 2, y: 2 },
                radius: 1.5,
                radiusField: 'BuffRadius',
                centerEditable: true,
            },
        ],
        [
            'edgeRegion',
            {
                ...LAYER_BASE,
                kind: 'edgeRegion',
                id: 'Region',
                label: 'Region',
                fieldName: 'Region',
                distance: 1,
                distanceField: 'Distance',
            },
        ],
        [
            'rectList',
            {
                ...LAYER_BASE,
                kind: 'rectList',
                id: 'ProhibitRects',
                label: 'ProhibitRects',
                fieldName: 'ProhibitRects',
                entries: [{ tag: 'tall', rect: { x: 0, y: 0, width: 2, height: 2 }, origin: LOCAL_ORIGIN }],
                fallbackRects: [],
            },
        ],
        [
            'componentPoints',
            {
                ...LAYER_BASE,
                kind: 'componentPoints',
                id: 'ComponentLocations',
                label: 'Component locations',
                fieldName: 'ComponentLocations',
                group: 'Components',
                entries: [
                    {
                        component: 'gun',
                        label: 'gun',
                        typeName: 'Cannon',
                        location: { x: 1, y: 1 },
                        rotationDeg: null,
                        chainedTo: null,
                        locationIsRef: false,
                        origin: null,
                    },
                ],
            },
        ],
        [
            'rect',
            {
                ...LAYER_BASE,
                kind: 'rect',
                id: 'PhysicalRect',
                label: 'PhysicalRect',
                fieldName: 'PhysicalRect',
                rect: { x: 0, y: 0, width: 4, height: 4 },
            },
        ],
    ];

    it('covers every kind the registry declares', () => {
        // The point of the table below is that it is complete, so it fails when a kind is added
        // to the page without a drawing test coming with it.
        expect(LAYERS.map(([kind]) => kind).sort()).toEqual(
            [
                'cell',
                'cellDirection',
                'cellPairList',
                'cellRay',
                'cellSet',
                'cellToValues',
                'circle',
                'componentPoints',
                'edgeRegion',
                'point',
                'pointList',
                'polygon',
                'rect',
                'rectList',
            ].sort()
        );
    });

    it.each(LAYERS)('paints a populated %s layer', async (label, layer) => {
        expect(layer.kind).toBe(label);
        await page.render(partGrid([layer], { margin: 2 }));
        const withLayer = paintCount(page);

        // Switching the layer off leaves the sprites and the grid, so the difference is exactly
        // what this kind's renderer contributed.
        const box = visibilityBox(page.layerRow(layer.label));
        box.checked = false;
        box.dispatch('change');
        await page.settle();
        expect(withLayer).toBeGreaterThan(paintCount(page));
    });
});

describe('part grid webview sprites', () => {
    it('draws a sprite at the offset and size the payload carried', async () => {
        await page.render(
            partGrid([insideLayer()], {
                sprites: [spriteLayer({ id: 'walls', offset: [-0.5, -0.25], size: [5, 4.5] })],
            }),
            { walls: 'data:walls' }
        );
        const [drawn] = page.calls('drawImage');
        expect((drawn.args[0] as { src: string }).src).toBe('data:walls');
        expect(drawn.args.slice(1)).toEqual([-0.5, -0.25, 5, 4.5]);
    });

    it('fits a sprite that carries no size to the part', async () => {
        await page.render(
            partGrid([insideLayer()], {
                sprites: [spriteLayer({ id: 'floor' })],
                size: { width: 3, height: 2, origin: null },
            }),
            { floor: 'data:floor' }
        );
        const [drawn] = page.calls('drawImage');
        expect(drawn.args.slice(1)).toEqual([0, 0, 3, 2]);
    });

    it('loads the image with the natural size the host inlined', async () => {
        const sized = loadGridWebview({ images: { 'data:floor': { width: 256, height: 128 } } });
        await sized.render(partGrid([insideLayer()], { sprites: [spriteLayer({ id: 'floor' })] }), {
            floor: 'data:floor',
        });
        const [drawn] = sized.calls('drawImage');
        const image = drawn.args[0] as { naturalWidth: number; naturalHeight: number };
        expect([image.naturalWidth, image.naturalHeight]).toEqual([256, 128]);
    });

    it('keeps drawing when one sprite image fails to load', async () => {
        const broken = loadGridWebview({ images: { 'data:roof': null } });
        await broken.render(
            partGrid([insideLayer()], {
                sprites: [spriteLayer({ id: 'floor' }), spriteLayer({ id: 'roof' })],
            }),
            { floor: 'data:floor', roof: 'data:roof' }
        );
        // The broken one simply does not draw, and the render that carries it still completes.
        const drawn = broken.calls('drawImage').map((entry) => (entry.args[0] as { src: string }).src);
        expect(drawn).toEqual(['data:floor']);
        expect(broken.status()).not.toContain('could not be drawn');
        expect(broken.calls('fillRect').length).toBeGreaterThan(0);
    });

    it('draws a sprite the host resolved no image for not at all', async () => {
        await page.render(
            partGrid([insideLayer()], {
                sprites: [spriteLayer({ id: 'floor' }), spriteLayer({ id: 'roof', uri: null })],
            }),
            { floor: 'data:floor' }
        );
        expect(page.calls('drawImage')).toHaveLength(1);
        expect(page.descendants(page.section('Sprites')).some((node) => node.textContent.includes('(missing)'))).toBe(
            true
        );
    });

    it('draws only the sprites whose visibility box is ticked', async () => {
        await page.render(
            partGrid([insideLayer()], {
                sprites: [spriteLayer({ id: 'floor' }), spriteLayer({ id: 'roof', defaultVisible: false })],
            }),
            { floor: 'data:floor', roof: 'data:roof' }
        );
        expect(page.calls('drawImage')).toHaveLength(1);

        const boxes = page
            .descendants(page.section('Sprites'))
            .filter((node) => node.tagName === 'INPUT' && node.type === 'checkbox');
        expect(boxes.map((box) => box.checked)).toEqual([true, false]);
        boxes[1].checked = true;
        boxes[1].dispatch('change');
        await page.settle();
        expect(page.calls('drawImage').map((entry) => (entry.args[0] as { src: string }).src)).toEqual([
            'data:floor',
            'data:roof',
        ]);
    });
});

describe('part grid webview zoom and fit', () => {
    /** A part of a given size on a stage that reports a real panel size. */
    async function onStage(width: number, height: number): Promise<GridHarness> {
        const harness = loadGridWebview({ stage: { width: 800, height: 600 } });
        await harness.render(partGrid([insideLayer()], { size: { width, height, origin: null } }));
        return harness;
    }

    it('fits a part that is larger than the panel', async () => {
        const large = await onStage(20, 20);
        // 22 cells across the stage (the part plus its margin ring) into the 536 usable pixels of
        // an 800x600 panel.
        expect(large.scale()).toBeCloseTo(536 / 22, 6);
        expect(large.canvasMetrics().cssWidth).toBeCloseTo(536, 6);
    });

    it('never zooms past the default for a part smaller than the panel', async () => {
        const small = await onStage(1, 1);
        expect(small.scale()).toBe(96);
    });

    it('never fits below the minimum zoom', async () => {
        const huge = await onStage(400, 400);
        expect(huge.scale()).toBe(24);
    });

    it('opens at the default zoom when the panel has no size yet', async () => {
        await page.render(partGrid([insideLayer()]));
        expect(page.scale()).toBe(96);
    });

    it('zooms in and out in steps through the buttons', async () => {
        await page.render(partGrid([insideLayer()]));
        await page.clickButton('+');
        expect(page.scale()).toBeCloseTo(120, 6);
        await page.clickButton('−');
        expect(page.scale()).toBeCloseTo(96, 6);
        await page.clickButton('−');
        expect(page.scale()).toBeCloseTo(76.8, 6);
    });

    it('clamps zooming in at the maximum', async () => {
        await page.render(partGrid([insideLayer()]));
        for (let step = 0; step < 12; step++) await page.clickButton('+');
        expect(page.scale()).toBe(384);
    });

    it('clamps zooming out at the minimum', async () => {
        await page.render(partGrid([insideLayer()]));
        for (let step = 0; step < 12; step++) await page.clickButton('−');
        expect(page.scale()).toBe(24);
    });

    it('refits the part through the fit button after a zoom', async () => {
        const large = await onStage(20, 20);
        await large.clickButton('+');
        expect(large.scale()).toBeGreaterThan(536 / 22);
        await large.clickButton('⛶');
        expect(large.scale()).toBeCloseTo(536 / 22, 6);
    });

    it('keeps the backing store of a very large part inside the browser limits', async () => {
        const huge = await onStage(400, 400);
        const fitted = huge.canvasMetrics();
        // The layout size is the whole stage, the backing store is capped under it. A canvas asked
        // for more than the browser hands out draws nothing at all, which is what a dead zoom
        // button on a large part really is.
        expect(fitted.cssWidth).toBeCloseTo(402 * 24, 6);
        expect(fitted.pixelWidth).toBeGreaterThan(0);
        expect(fitted.pixelWidth).toBeLessThan(fitted.cssWidth);
        expect(fitted.pixelWidth).toBeLessThanOrEqual(MAX_CANVAS_DIMENSION);
        expect(fitted.pixelWidth * fitted.pixelHeight).toBeLessThanOrEqual(MAX_CANVAS_AREA);
    });

    it('keeps the backing store inside the limits at the deepest zoom too', async () => {
        const large = await onStage(100, 100);
        for (let step = 0; step < 16; step++) await large.clickButton('+');
        const zoomed = large.canvasMetrics();
        expect(large.scale()).toBe(384);
        expect(zoomed.cssWidth).toBeCloseTo(102 * 384, 6);
        expect(zoomed.pixelWidth).toBeGreaterThan(0);
        expect(zoomed.pixelWidth).toBeLessThanOrEqual(MAX_CANVAS_DIMENSION);
        expect(zoomed.pixelWidth * zoomed.pixelHeight).toBeLessThanOrEqual(MAX_CANVAS_AREA);
    });

    it('backs the canvas with the display pixel ratio while it fits', async () => {
        const retina = loadGridWebview({ devicePixelRatio: 2 });
        await retina.render(partGrid([insideLayer()]));
        const metrics = retina.canvasMetrics();
        expect(metrics.cssWidth).toBeCloseTo(6 * 96, 6);
        expect(metrics.pixelWidth).toBeCloseTo(2 * 6 * 96, 6);
    });
});
