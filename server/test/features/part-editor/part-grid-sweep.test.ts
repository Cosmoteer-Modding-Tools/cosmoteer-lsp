import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { join } from 'path';
import { readFileSync } from 'fs';
import { parseText, parseFilePath } from '../../../src/utils/ast.utils';
import { buildPartGridData } from '../../../src/features/part-editor/part-grid-data.service';
import { buildPartGridEdit } from '../../../src/features/part-editor/grid-edit.service';
import {
    CellDirectionLayerData,
    CellLayerData,
    CellRayLayerData,
    CellSetLayerData,
    CircleLayerData,
    ComponentPointsLayerData,
    GridMutation,
    PartGridData,
    PointLayerData,
    PointListLayerData,
    PolygonLayerData,
    RectLayerData,
    RectListLayerData,
} from '../../../src/features/part-editor/part-grid.types';
import { FIXTURES_DIR } from '../../helpers';
import { initWorkspace } from '../../workspace-helper';

// The sweep-round layers (component gizmo, ports, colliders, resource grids, prohibit rects, tile
// lines, buff circles, railgun segments, resource sprite offsets) and their mutations, against the
// extended fixture part.
const token = CancellationToken.None;
const basePath = join(FIXTURES_DIR, 'part-editor', 'base_part.rules');

const layerOf = <T>(data: PartGridData, id: string): T => {
    const layer = data.layers.find((candidate) => candidate.id === id);
    expect(layer, `layer ${id}`).toBeTruthy();
    return layer as T;
};

/** Applies LSP text edits to a source string. */
const applyEdits = (text: string, edits: Array<{ range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }>): string => {
    const toOffset = (position: { line: number; character: number }): number => {
        let line = 0;
        let offset = 0;
        while (line < position.line) {
            offset = text.indexOf('\n', offset) + 1;
            line++;
        }
        return offset + position.character;
    };
    const resolved = edits
        .map((edit) => ({ start: toOffset(edit.range.start), end: toOffset(edit.range.end), newText: edit.newText }))
        .sort((a, b) => b.start - a.start);
    let result = text;
    for (const { start, end, newText } of resolved) {
        result = result.slice(0, start) + newText + result.slice(end);
    }
    return result;
};

/** Runs one mutation and returns the edited text plus the rebuilt payload. */
const mutate = async (mutation: GridMutation): Promise<{ edited: string; data: PartGridData }> => {
    const text = readFileSync(basePath, 'utf-8');
    const document = parseText(text, basePath);
    const result = await buildPartGridEdit(document, text, basePath, 0, mutation, token);
    expect(result.status, result.message).toBe('ok');
    const edited = applyEdits(text, result.edit!.changes![basePath]);
    const data = (await buildPartGridData(parseText(edited, basePath), 0, 1, token))!;
    return { edited, data };
};

describe('sweep-round layers', () => {
    let base: PartGridData;

    beforeAll(async () => {
        await initWorkspace();
        base = (await buildPartGridData(await parseFilePath(basePath), 0, 1, token))!;
    });

    it('builds the network port layer with its facing', () => {
        const port = layerOf<CellDirectionLayerData>(base, 'Components/port/Location');
        expect(port.cell).toEqual({ x: 0, y: 0 });
        expect(port.direction).toBe('Down');
        expect(port.directions).toContain('Up');
    });

    it('builds the polygon collider layer', () => {
        const polygon = layerOf<PolygonLayerData>(base, 'Components/collider/Vertices');
        expect(polygon.vertices.map(({ point }) => [point.x, point.y])).toEqual([
            [0, 0],
            [1, 0],
            [1, 2],
            [0, 2],
        ]);
    });

    it('builds the resource grid rect with grid-local disable cells', () => {
        const rect = layerOf<RectLayerData>(base, 'Components/grid/GridRect');
        expect(rect.rect).toEqual({ x: 0, y: 1, width: 1, height: 1 });
        const disable = layerOf<CellSetLayerData>(base, 'Components/grid/DisableCells');
        expect(disable.baseCell).toEqual({ x: 0, y: 1 });
        expect(disable.cells.map(({ cell }) => [cell.x, cell.y])).toEqual([[0, 0]]);
    });

    it('builds the proxy part-location cell layer', () => {
        const proxy = layerOf<CellLayerData>(base, 'Components/proxy/PartLocation');
        expect(proxy.cell).toEqual({ x: -1, y: 0 });
    });

    it('builds the buff area and circle layers', () => {
        const area = layerOf<RectLayerData>(base, 'Components/buff/BuffArea');
        expect(area.rect).toEqual({ x: -1, y: 0, width: 1, height: 2 });
        const circle = layerOf<CircleLayerData>(base, 'Components/cbuff/BuffCenter');
        expect(circle.center).toEqual({ x: 0.5, y: 1 });
        expect(circle.radius).toBe(2);
    });

    it('builds the tile line ray layer', () => {
        const ray = layerOf<CellRayLayerData>(base, 'Components/line/Line');
        expect(ray.cell).toEqual({ x: 0, y: 0 });
        expect(ray.direction).toBe('Up');
        expect(ray.maxTiles).toBe(10);
    });

    it('builds the prohibit rect list with the scalar sugar as ghosts', () => {
        const prohibit = layerOf<RectListLayerData>(base, 'ProhibitRects');
        expect(prohibit.entries).toEqual([
            expect.objectContaining({ tag: 'tall', rect: { x: -1, y: -1, width: 3, height: 1 } }),
        ]);
        expect(prohibit.fallbackRects).toEqual([
            { rect: { x: 0, y: -2, width: 1, height: 2 }, label: 'ProhibitAbove' },
        ]);
    });

    it('builds storage point and fractional rect layers', () => {
        const pickup = layerOf<PointLayerData>(base, 'Components/storage/PickUpLocation');
        expect(pickup.point).toEqual({ x: 0.5, y: 1.5 });
        const tile = layerOf<RectLayerData>(base, 'Components/storage/UITileRect');
        expect(tile.fractional).toBe(true);
        expect(tile.rect).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    });

    it('builds the railgun segment point layers from the scalar pairs', () => {
        const start = layerOf<PointLayerData>(base, 'Components/rail/RailgunStart');
        expect(start.point).toEqual({ x: 0, y: -1 });
        const end = layerOf<PointLayerData>(base, 'Components/rail/RailgunEnd');
        expect(end.point).toEqual({ x: 0, y: 1 });
    });

    it('builds the fixed-count resource level offset layer', () => {
        const offsets = layerOf<PointListLayerData>(base, 'Components/rs/ResourceLevels:Offset');
        expect(offsets.fixedCount).toBe(true);
        expect(offsets.points.map(({ point }) => [point.x, point.y])).toEqual([[0, 0.5]]);
    });

    it('resolves the component gizmo with the chain transform applied', () => {
        const gizmo = layerOf<ComponentPointsLayerData>(base, 'ComponentLocations');
        const eff1 = gizmo.entries.find((entry) => entry.component === 'eff1')!;
        expect(eff1.location).toEqual({ x: 0.5, y: 0.5 });
        expect(eff1.rotationDeg).toBe(90);
        const eff2 = gizmo.entries.find((entry) => entry.component === 'eff2')!;
        // Own [0, 1] rotated by the parent's 90 degrees (clockwise, y-down) is [-1, 0].
        expect(eff2.chainedTo).toBe('eff1');
        expect(eff2.location!.x).toBeCloseTo(-0.5, 6);
        expect(eff2.location!.y).toBeCloseTo(0.5, 6);
        // Ports get their own layer, not a gizmo marker.
        expect(gizmo.entries.some((entry) => entry.component === 'port')).toBe(false);
    });

    it('reads the contiguity flags', () => {
        expect(base.contiguity.values).toEqual(['Top', 'Bottom']);
        expect(base.contiguity.enumNames).toContain('TopLeft');
    });

    it('evaluates reference-valued polygon vertices and flags them read-only', () => {
        // The armor idiom: vertices written as `[&~/SIZE/0, 0]` evaluate for display but must not
        // be rewritten to literals by a drag.
        const polygon = layerOf<PolygonLayerData>(base, 'Components/refcollider/Vertices');
        expect(polygon.vertices.map(({ point }) => [point.x, point.y])).toEqual([
            [1, 0],
            [1, 2],
            [0, 2],
        ]);
        expect(polygon.vertices.every(({ isRef }) => isRef)).toBe(true);
    });

    it('renders a circle collider as a radius circle with a component-bound center', () => {
        const circle = layerOf<CircleLayerData>(base, 'Components/ccol/Radius');
        expect(circle.center).toEqual({ x: 0.5, y: 0.5 });
        expect(circle.radius).toBe(0.6);
        expect(circle.centerEditable).toBe(false);
        expect(circle.radiusField).toBe('Radius');
    });
});

describe('sweep-round mutations', () => {
    beforeAll(async () => {
        await initWorkspace();
    });

    it('sets and removes a single point field', async () => {
        const moved = await mutate({ op: 'setPoint', layerId: 'Components/storage/PickUpLocation', point: { x: 1, y: 2 } });
        expect(moved.edited).toContain('PickUpLocation = [1, 2]');
        const removed = await mutate({ op: 'setPoint', layerId: 'Components/storage/PickUpLocation', point: null });
        expect(removed.edited).not.toContain('PickUpLocation');
    });

    it('sets a proxy cell and the port facing', async () => {
        const cell = await mutate({ op: 'setCell', layerId: 'Components/proxy/PartLocation', cell: { x: 2, y: 0 } });
        expect(cell.edited).toContain('PartLocation = [2, 0]');
        const facing = await mutate({ op: 'setDirection', layerId: 'Components/port/Location', direction: 'Right' });
        expect(facing.edited).toContain('Direction = Right');
    });

    it('edits the tile line through its sub-group', async () => {
        const moved = await mutate({ op: 'setCell', layerId: 'Components/line/Line', cell: { x: 0, y: 1 } });
        const ray = layerOf<CellRayLayerData>(moved.data, 'Components/line/Line');
        expect(ray.cell).toEqual({ x: 0, y: 1 });
        const tiles = await mutate({ op: 'setNumber', layerId: 'Components/line/Line', field: 'MaxTiles', value: 25 });
        expect(tiles.edited).toContain('MaxTiles = 25');
    });

    it('moves, inserts, and removes polygon vertices', async () => {
        const moved = await mutate({ op: 'moveVertex', layerId: 'Components/collider/Vertices', index: 3, point: { x: 0.25, y: 1.75 } });
        const polygon = layerOf<PolygonLayerData>(moved.data, 'Components/collider/Vertices');
        expect(polygon.vertices[3].point).toEqual({ x: 0.25, y: 1.75 });

        const inserted = await mutate({ op: 'insertVertex', layerId: 'Components/collider/Vertices', index: 1, point: { x: 0.5, y: 0 } });
        const insertedPolygon = layerOf<PolygonLayerData>(inserted.data, 'Components/collider/Vertices');
        expect(insertedPolygon.vertices.map(({ point }) => [point.x, point.y])).toEqual([
            [0, 0],
            [0.5, 0],
            [1, 0],
            [1, 2],
            [0, 2],
        ]);

        const removed = await mutate({ op: 'removeVertex', layerId: 'Components/collider/Vertices', index: 0 });
        expect(layerOf<PolygonLayerData>(removed.data, 'Components/collider/Vertices').vertices).toHaveLength(3);
    });

    it('appends and reshapes tagged prohibit rects, inheriting the tag', async () => {
        const appended = await mutate({
            op: 'setRectEntry',
            layerId: 'ProhibitRects',
            index: null,
            tag: null,
            rect: { x: 0, y: 2, width: 1, height: 1 },
        });
        expect(appended.edited).toContain('[tall, [0, 2, 1, 1]]');
        const reshaped = await mutate({
            op: 'setRectEntry',
            layerId: 'ProhibitRects',
            index: 0,
            tag: null,
            rect: { x: -2, y: -1, width: 4, height: 1 },
        });
        const prohibit = layerOf<RectListLayerData>(reshaped.data, 'ProhibitRects');
        expect(prohibit.entries[0]).toEqual(
            expect.objectContaining({ tag: 'tall', rect: { x: -2, y: -1, width: 4, height: 1 } })
        );
    });

    it('moves a component and writes its rotation in degree form', async () => {
        const moved = await mutate({ op: 'moveComponentLocation', component: 'eff1', point: { x: 0.25, y: 0.75 } });
        expect(moved.edited).toContain('Location = [0.25, 0.75]');
        const rotated = await mutate({ op: 'setComponentRotation', component: 'eff2', degrees: 45 });
        expect(rotated.edited).toContain('Rotation = 45d');
    });

    it('writes the railgun segment as its two scalar fields', async () => {
        const { edited } = await mutate({ op: 'setPoint', layerId: 'Components/rail/RailgunStart', point: { x: 0.5, y: -2 } });
        expect(edited).toContain('XStartOffset = 0.5');
        expect(edited).toContain('YStartOffset = -2');
    });

    it('moves a fixed-count entry offset but refuses adding to it', async () => {
        const moved = await mutate({ op: 'movePoint', layerId: 'Components/rs/ResourceLevels:Offset', index: 0, point: { x: 0.5, y: 0 } });
        const offsets = layerOf<PointListLayerData>(moved.data, 'Components/rs/ResourceLevels:Offset');
        expect(offsets.points[0].point).toEqual({ x: 0.5, y: 0 });

        const text = readFileSync(basePath, 'utf-8');
        const document = parseText(text, basePath);
        const refused = await buildPartGridEdit(
            document,
            text,
            basePath,
            0,
            { op: 'addPoint', layerId: 'Components/rs/ResourceLevels:Offset', point: { x: 0, y: 0 } },
            token
        );
        expect(refused.status).toBe('error');
    });

    it('removes the local flags when set back to the inherited or default value', async () => {
        // base_part has no inherited AllowedContiguity, so the game default Sides is the baseline.
        // Writing Sides (or its expansion) back removes the local field instead of keeping a
        // redundant override.
        const named = await mutate({ op: 'setFlags', field: 'AllowedContiguity', values: ['Sides'] });
        expect(named.edited).not.toContain('AllowedContiguity');
        const expanded = await mutate({
            op: 'setFlags',
            field: 'AllowedContiguity',
            values: ['Left', 'Right', 'Top', 'Bottom'],
        });
        expect(expanded.edited).not.toContain('AllowedContiguity');
    });

    it('removes a rotation boolean set back to the inherited value', async () => {
        const derivedPath = join(FIXTURES_DIR, 'part-editor', 'derived_part.rules');
        const text = readFileSync(derivedPath, 'utf-8');
        // Override the inherited IsFlippable = false, then write false again: both steps go
        // through the server, the second one must drop the override it created.
        const first = await buildPartGridEdit(
            parseText(text, derivedPath),
            text,
            derivedPath,
            0,
            { op: 'setBool', field: 'IsFlippable', value: true },
            token
        );
        expect(first.status).toBe('ok');
        const overridden = applyEdits(text, first.edit!.changes![derivedPath]);
        expect(overridden).toContain('IsFlippable = true');
        const second = await buildPartGridEdit(
            parseText(overridden, derivedPath),
            overridden,
            derivedPath,
            0,
            { op: 'setBool', field: 'IsFlippable', value: false },
            token
        );
        expect(second.status).toBe('ok');
        const reverted = applyEdits(overridden, second.edit!.changes![derivedPath]);
        expect(reverted).not.toContain('IsFlippable');
    });

    it('writes and removes the contiguity flags', async () => {
        const single = await mutate({ op: 'setFlags', field: 'AllowedContiguity', values: ['All'] });
        expect(single.edited).toContain('AllowedContiguity = All');
        const multiple = await mutate({ op: 'setFlags', field: 'AllowedContiguity', values: ['Top', 'Left'] });
        expect(multiple.edited).toContain('AllowedContiguity = [Top, Left]');
        expect(multiple.data.contiguity.values).toEqual(['Top', 'Left']);
        const removed = await mutate({ op: 'setFlags', field: 'AllowedContiguity', values: null });
        expect(removed.edited).not.toContain('AllowedContiguity');
    });

    it('refuses to drag a reference-valued vertex but resizes a circle collider', async () => {
        const text = readFileSync(basePath, 'utf-8');
        const document = parseText(text, basePath);
        const refused = await buildPartGridEdit(
            document,
            text,
            basePath,
            0,
            { op: 'moveVertex', layerId: 'Components/refcollider/Vertices', index: 0, point: { x: 2, y: 0 } },
            token
        );
        expect(refused.status).toBe('error');

        const resized = await mutate({ op: 'setNumber', layerId: 'Components/ccol/Radius', field: 'Radius', value: 0.75 });
        expect(resized.edited).toContain('Radius = 0.75');
    });

    it('resizes the buff circle', async () => {
        const radius = await mutate({ op: 'setNumber', layerId: 'Components/cbuff/BuffCenter', field: 'BuffRadius', value: 3.5 });
        expect(radius.edited).toContain('BuffRadius = 3.5');
        const center = await mutate({ op: 'setPoint', layerId: 'Components/cbuff/BuffCenter', point: { x: 1, y: 1 } });
        const circle = layerOf<CircleLayerData>(center.data, 'Components/cbuff/BuffCenter');
        expect(circle.center).toEqual({ x: 1, y: 1 });
    });
});
