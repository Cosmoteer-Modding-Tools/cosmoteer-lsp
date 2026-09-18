import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import { mediaBundle } from '../../media-bundle';

// The webview's pure geometry, read out of the built page (its exports become the CommonJS ones,
// and nothing starts without a host bridge). The view transform must round-trip for every
// rotation/flip combination, or clicks would land on the wrong cells in rotated views.
const require = createRequire(import.meta.url);
const webview = require(mediaBundle('part-grid-editor.js')) as {
    rotateQuarter(x: number, y: number, rotation: number): [number, number];
    gridToStage(x: number, y: number, view: object, center: { x: number; y: number }): [number, number];
    stageToGrid(sx: number, sy: number, view: object, center: { x: number; y: number }): [number, number];
    snapTo(value: number, step: number): number;
    adjacencyAt(fx: number, fy: number): string | null;
    directionOffset(name: string): [number, number];
    inverseOf(mutation: object, data: object): { op: string } & Record<string, unknown>;
    doorEdgeFor(cell: { x: number; y: number }, rect: { x: number; y: number; width: number; height: number }): string | null;
    edgeRegionDistanceAt(rect: { x: number; y: number; width: number; height: number }, point: { x: number; y: number }): number;
    backingRatio(size: { width: number; height: number }, dpr: number): number;
    LAYER_KINDS: Record<string, LayerKind>;
    countOf(layer: object): number;
    pointMemberOf(layer: object): LayerMember;
    numberMemberOf(layer: object): LayerMember;
};

/** One member accessor pair of a layer kind, the undo reader paired with the local-apply writer. */
type LayerMember = { read(layer: object): unknown; write(layer: object, value: unknown): void };

/** One entry of the layer-kind registry the page dispatches every per-kind behaviour through. */
type LayerKind = {
    count(layer: object): number;
    point?: LayerMember;
    number?: LayerMember;
    draw?: unknown;
    hitTest?: unknown;
    panel?: unknown;
};

/** A minimal layer payload of each kind, enough for the pure registry members to read. */
const SAMPLE_LAYERS: Record<string, Record<string, unknown>> = {
    cellSet: { cells: [{ cell: { x: 0, y: 0 } }, { cell: { x: 1, y: 0 } }] },
    cellToValues: { entries: [{ cell: { x: 0, y: 0 }, values: ['Top'] }] },
    pointList: { points: [{ point: { x: 0, y: 0 } }, { point: { x: 1, y: 1 } }, { point: { x: 2, y: 2 } }] },
    cellPairList: { pairs: [{ external: { x: -1, y: 0 }, internal: { x: 0, y: 0 } }] },
    point: { point: { x: 0.5, y: 0.5 } },
    cell: { cell: { x: 1, y: 1 } },
    cellDirection: { cell: { x: 1, y: 1 }, direction: 'Up' },
    cellRay: { cell: { x: 1, y: 1 }, direction: 'Up', maxTiles: 7 },
    polygon: { vertices: [{ point: { x: 0, y: 0 } }, { point: { x: 1, y: 0 } }, { point: { x: 1, y: 1 } }] },
    circle: { center: { x: 1, y: 1 }, radius: 3 },
    edgeRegion: { distance: 2 },
    rectList: { entries: [{ tag: 'tall', rect: { x: 0, y: 0, width: 1, height: 1 } }] },
    componentPoints: { entries: [{ component: 'a' }, { component: 'b' }] },
    rect: { rect: { x: 0, y: 0, width: 2, height: 2 } },
};

describe('part grid webview geometry', () => {
    it('rotates quarter turns clockwise in y-down space', () => {
        const rotated = (rotation: number) => webview.rotateQuarter(1, 0, rotation).map((n) => n + 0);
        expect(rotated(90)).toEqual([0, 1]);
        expect(rotated(180)).toEqual([-1, 0]);
        expect(rotated(270)).toEqual([0, -1]);
        expect(rotated(0)).toEqual([1, 0]);
    });

    it('round-trips grid to stage for every rotation and flip combination', () => {
        const center = { x: 0.5, y: 1 };
        const points = [
            [0, 0],
            [1, 2],
            [-1, 0.5],
            [0.25, 1.75],
        ];
        for (const rotation of [0, 90, 180, 270]) {
            for (const flipH of [false, true]) {
                for (const flipV of [false, true]) {
                    const view = { rotation, flipH, flipV };
                    for (const [x, y] of points) {
                        const [sx, sy] = webview.gridToStage(x, y, view, center);
                        const [gx, gy] = webview.stageToGrid(sx, sy, view, center);
                        expect(gx, `x @ rot ${rotation} flipH ${flipH} flipV ${flipV}`).toBeCloseTo(x, 10);
                        expect(gy, `y @ rot ${rotation} flipH ${flipH} flipV ${flipV}`).toBeCloseTo(y, 10);
                    }
                }
            }
        }
    });

    it('snaps to steps and rounds free placement to milli-cells', () => {
        expect(webview.snapTo(0.37, 0.25)).toBeCloseTo(0.25);
        expect(webview.snapTo(0.4, 0.25)).toBeCloseTo(0.5);
        expect(webview.snapTo(0.123456, 0)).toBeCloseTo(0.123);
    });

    it('hit-tests the adjacency rosette regions of a cell', () => {
        expect(webview.adjacencyAt(0.5, 0.1)).toBe('Top');
        expect(webview.adjacencyAt(0.9, 0.5)).toBe('Right');
        expect(webview.adjacencyAt(0.5, 0.9)).toBe('Bottom');
        expect(webview.adjacencyAt(0.1, 0.5)).toBe('Left');
        expect(webview.adjacencyAt(0.1, 0.1)).toBe('TopLeft');
        expect(webview.adjacencyAt(0.9, 0.9)).toBe('BottomRight');
        expect(webview.adjacencyAt(0.5, 0.5)).toBeNull();
    });

    it('maps travel directions to the verified y-down offsets', () => {
        expect(webview.directionOffset('Up')).toEqual([0, -1]);
        expect(webview.directionOffset('Down')).toEqual([0, 1]);
        expect(webview.directionOffset('Left')).toEqual([-1, 0]);
        expect(webview.directionOffset('Right')).toEqual([1, 0]);
    });

    it('places the door strip on the edge facing the physical rect', () => {
        // The cannon_med cases: Size [2, 2] with PhysicalRect [0, 1, 2, 1] (the bottom row).
        const rect = { x: 0, y: 1, width: 2, height: 1 };
        expect(webview.doorEdgeFor({ x: -1, y: 1 }, rect)).toBe('Right');
        expect(webview.doorEdgeFor({ x: 2, y: 1 }, rect)).toBe('Left');
        expect(webview.doorEdgeFor({ x: 0, y: 2 }, rect)).toBe('Top');
        expect(webview.doorEdgeFor({ x: 1, y: 2 }, rect)).toBe('Top');
        // The barrel cell above the physical row can host a door on its bottom edge.
        expect(webview.doorEdgeFor({ x: 0, y: 0 }, rect)).toBe('Bottom');
        // Inside the rect, or diagonal to it, no door can exist.
        expect(webview.doorEdgeFor({ x: 0, y: 1 }, rect)).toBeNull();
        expect(webview.doorEdgeFor({ x: -1, y: 0 }, rect)).toBeNull();

        // The thruster cases: physical rect [0, 0, 1, 1], doors above, right, and left.
        const thruster = { x: 0, y: 0, width: 1, height: 1 };
        expect(webview.doorEdgeFor({ x: 0, y: -1 }, thruster)).toBe('Bottom');
        expect(webview.doorEdgeFor({ x: 1, y: 0 }, thruster)).toBe('Left');
        expect(webview.doorEdgeFor({ x: -1, y: 0 }, thruster)).toBe('Right');
    });

    it('measures the edge-distance region contour as the rect grown outward on every side', () => {
        // A 2x2 part at the origin. The contour value is the largest orthogonal gap to the rect, so
        // the level set = d is exactly the rect expanded by d, and the corner reads the same as edges.
        const rect = { x: 0, y: 0, width: 2, height: 2 };
        expect(webview.edgeRegionDistanceAt(rect, { x: 1, y: 1 })).toBe(0); // inside
        expect(webview.edgeRegionDistanceAt(rect, { x: 3, y: 1 })).toBe(1); // one cell right of the edge
        expect(webview.edgeRegionDistanceAt(rect, { x: 1, y: -2 })).toBe(2); // two cells above
        expect(webview.edgeRegionDistanceAt(rect, { x: 5, y: -5 })).toBe(5); // beyond a corner, still chebyshev
    });

    it('computes exact inverses for the undo command pattern', () => {
        const data = {
            size: { width: 1, height: 2 },
            rotation: { isRotateable: { value: null }, flipHRotate: { values: [0, 2] } },
            contiguity: { values: ['Top'] },
            layers: [
                {
                    id: 'doors',
                    kind: 'cellSet',
                    cells: [{ cell: { x: 0, y: -1 } }],
                    entries: [],
                    points: [{ point: { x: 0.5, y: 0.5 } }],
                },
                { id: 'rect', kind: 'rect', rect: { x: 0, y: 0, width: 1, height: 2 } },
                { id: 'ray', kind: 'cellRay', direction: null, maxTiles: 10 },
                { id: 'region', kind: 'edgeRegion', distance: 5, distanceField: 'Distance' },
            ],
        };
        expect(webview.inverseOf({ op: 'addCell', layerId: 'doors', cell: { x: 1, y: 0 } }, data)).toEqual({
            op: 'removeCell',
            layerId: 'doors',
            cell: { x: 1, y: 0 },
        });
        expect(webview.inverseOf({ op: 'addPoint', layerId: 'doors', point: { x: 0, y: 0 } }, data)).toEqual({
            op: 'removePoint',
            layerId: 'doors',
            index: 1,
        });
        expect(
            webview.inverseOf({ op: 'setRect', layerId: 'rect', rect: { x: 0, y: 1, width: 1, height: 1 } }, data)
        ).toEqual({ op: 'setRect', layerId: 'rect', rect: { x: 0, y: 0, width: 1, height: 2 } });
        expect(webview.inverseOf({ op: 'setSize', size: { width: 2, height: 2 } }, data)).toEqual({
            op: 'setSize',
            size: { width: 1, height: 2 },
        });
        // A previously unset boolean undoes back to removal, an unset facing to a member removal.
        expect(webview.inverseOf({ op: 'setBool', field: 'IsRotateable', value: true }, data)).toEqual({
            op: 'setBool',
            field: 'IsRotateable',
            value: null,
        });
        expect(webview.inverseOf({ op: 'setDirection', layerId: 'ray', direction: 'Up' }, data)).toEqual({
            op: 'setNumber',
            layerId: 'ray',
            field: 'Direction',
            value: null,
        });
        expect(webview.inverseOf({ op: 'setFlags', field: 'AllowedContiguity', values: ['All'] }, data)).toEqual({
            op: 'setFlags',
            field: 'AllowedContiguity',
            values: ['Top'],
        });
        expect(webview.inverseOf({ op: 'setIntList', field: 'FlipHRotate', values: [1] }, data)).toEqual({
            op: 'setIntList',
            field: 'FlipHRotate',
            values: [0, 2],
        });
        // A region distance change undoes by restoring the previous distance.
        expect(webview.inverseOf({ op: 'setNumber', layerId: 'region', field: 'Distance', value: 8 }, data)).toEqual({
            op: 'setNumber',
            layerId: 'region',
            field: 'Distance',
            value: 5,
        });
    });

    it('keeps the canvas backing store inside what a browser will allocate', () => {
        // A modest part backs at the display's own ratio, so nothing renders softer than it must.
        expect(webview.backingRatio({ width: 800, height: 1200 }, 2)).toBe(2);
        // A large grid at a high zoom would ask for a store no browser hands out, and a canvas that
        // fails to allocate draws nothing: the ratio drops instead, within both limits.
        const huge = { width: 30720, height: 35712 };
        const ratio = webview.backingRatio(huge, 2);
        expect(ratio).toBeLessThan(1);
        expect(Math.max(huge.width, huge.height) * ratio).toBeLessThanOrEqual(8192);
        expect(huge.width * ratio * (huge.height * ratio)).toBeLessThanOrEqual(1 << 25);
    });
});

describe('part grid layer-kind registry', () => {
    // The registry is the one place a layer kind is declared. Before it, the same fourteen kinds
    // were spread over five parallel switch chains up to 1500 lines apart, and a kind added to four
    // of them silently lost the fifth behaviour. These tests hold that shape.

    it('declares every behaviour for every kind it knows', () => {
        const kinds = Object.keys(webview.LAYER_KINDS);
        expect(kinds).toHaveLength(14);
        for (const name of kinds) {
            const kind = webview.LAYER_KINDS[name];
            expect(typeof kind.count, `${name} count`).toBe('function');
            expect(typeof kind.draw, `${name} draw`).toBe('function');
            expect(typeof kind.hitTest, `${name} hitTest`).toBe('function');
            expect(typeof kind.panel, `${name} panel`).toBe('function');
        }
        // Every kind the page can be handed has a sample below, so the counting test covers them all.
        expect(kinds.sort()).toEqual(Object.keys(SAMPLE_LAYERS).sort());
    });

    it('counts the authored entries of each kind', () => {
        const countFor = (kind: string) => webview.countOf({ kind, ...SAMPLE_LAYERS[kind] });
        expect(countFor('cellSet')).toBe(2);
        expect(countFor('cellToValues')).toBe(1);
        expect(countFor('pointList')).toBe(3);
        expect(countFor('cellPairList')).toBe(1);
        expect(countFor('polygon')).toBe(3);
        expect(countFor('rectList')).toBe(1);
        expect(countFor('componentPoints')).toBe(2);
        // The single-value kinds count one when they hold anything at all.
        for (const kind of ['point', 'cell', 'cellDirection', 'cellRay', 'circle', 'edgeRegion', 'rect']) {
            expect(countFor(kind), kind).toBe(1);
        }
    });

    it('counts an empty layer of every kind as zero', () => {
        const empty: Record<string, unknown> = {
            cells: [],
            entries: [],
            points: [],
            pairs: [],
            vertices: [],
            point: null,
            cell: null,
            center: null,
            radius: null,
            distance: null,
            rect: null,
        };
        for (const kind of Object.keys(webview.LAYER_KINDS)) {
            expect(webview.countOf({ kind, ...empty }), kind).toBe(0);
        }
        // An unknown kind counts zero rather than throwing, so a payload from a newer server that
        // names a kind this page does not have still renders its other layers.
        expect(webview.countOf({ kind: 'notAKind' })).toBe(0);
    });

    it('reads and writes the single point member each kind names', () => {
        // The circle's point member is its center, every other kind's is `point`. Reading is the
        // undo half (the value the inverse restores), writing the optimistic local apply.
        const circle = { kind: 'circle', center: { x: 1, y: 1 }, point: { x: 9, y: 9 } };
        expect(webview.pointMemberOf(circle).read(circle)).toEqual({ x: 1, y: 1 });
        webview.pointMemberOf(circle).write(circle, { x: 2, y: 3 });
        expect(circle.center).toEqual({ x: 2, y: 3 });
        expect(circle.point).toEqual({ x: 9, y: 9 });

        const single = { kind: 'point', point: { x: 4, y: 5 } };
        expect(webview.pointMemberOf(single).read(single)).toEqual({ x: 4, y: 5 });
        webview.pointMemberOf(single).write(single, null);
        expect(single.point).toBeNull();
    });

    it('reads and writes the single number member each kind names', () => {
        const cases: [string, string, number][] = [
            ['circle', 'radius', 3],
            ['cellRay', 'maxTiles', 7],
            ['edgeRegion', 'distance', 2],
        ];
        for (const [kind, member, value] of cases) {
            const layer: Record<string, unknown> = { kind, ...SAMPLE_LAYERS[kind] };
            expect(webview.numberMemberOf(layer).read(layer), kind).toBe(value);
            webview.numberMemberOf(layer).write(layer, 42);
            expect(layer[member], kind).toBe(42);
        }
        // A kind holding no single number reads null and its write is a no-op, which is what the
        // undo path needs: a mutation with no prior value to restore.
        const cells = { kind: 'cellSet', cells: [] };
        expect(webview.numberMemberOf(cells).read(cells)).toBeNull();
        expect(() => webview.numberMemberOf(cells).write(cells, 1)).not.toThrow();
        expect(Object.keys(cells)).toEqual(['kind', 'cells']);
    });

    it('routes the point and number inverses through the registry members', () => {
        const data = {
            layers: [
                { id: 'circle', kind: 'circle', center: { x: 1, y: 2 }, radius: 3 },
                { id: 'marker', kind: 'point', point: { x: 4, y: 5 } },
                { id: 'ray', kind: 'cellRay', cell: { x: 0, y: 0 }, maxTiles: 7 },
                { id: 'cells', kind: 'cellSet', cells: [] },
            ],
        };
        expect(webview.inverseOf({ op: 'setPoint', layerId: 'circle', point: null }, data)).toEqual({
            op: 'setPoint',
            layerId: 'circle',
            point: { x: 1, y: 2 },
        });
        expect(webview.inverseOf({ op: 'setPoint', layerId: 'marker', point: { x: 0, y: 0 } }, data)).toEqual({
            op: 'setPoint',
            layerId: 'marker',
            point: { x: 4, y: 5 },
        });
        expect(webview.inverseOf({ op: 'setNumber', layerId: 'ray', field: 'MaxTiles', value: 2 }, data)).toEqual({
            op: 'setNumber',
            layerId: 'ray',
            field: 'MaxTiles',
            value: 7,
        });
        expect(webview.inverseOf({ op: 'setNumber', layerId: 'cells', field: 'Nothing', value: 2 }, data)).toEqual({
            op: 'setNumber',
            layerId: 'cells',
            field: 'Nothing',
            value: null,
        });
    });
});
