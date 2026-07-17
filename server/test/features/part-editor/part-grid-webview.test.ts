import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import { join, resolve } from 'path';

// The webview's pure geometry, imported straight from the shipped media script (its module.exports
// guard activates outside a webview). The view transform must round-trip for every rotation/flip
// combination, or clicks would land on the wrong cells in rotated views.
const require = createRequire(import.meta.url);
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const webview = require(join(REPO_ROOT, 'media', 'part-grid-editor.js')) as {
    rotateQuarter(x: number, y: number, rotation: number): [number, number];
    gridToStage(x: number, y: number, view: object, center: { x: number; y: number }): [number, number];
    stageToGrid(sx: number, sy: number, view: object, center: { x: number; y: number }): [number, number];
    snapTo(value: number, step: number): number;
    adjacencyAt(fx: number, fy: number): string | null;
    directionOffset(name: string): [number, number];
    inverseOf(mutation: object, data: object): { op: string } & Record<string, unknown>;
    doorEdgeFor(cell: { x: number; y: number }, rect: { x: number; y: number; width: number; height: number }): string | null;
    edgeRegionDistanceAt(rect: { x: number; y: number; width: number; height: number }, point: { x: number; y: number }): number;
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
});
