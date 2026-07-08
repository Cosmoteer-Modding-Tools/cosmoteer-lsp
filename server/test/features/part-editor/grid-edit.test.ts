import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken, Range, TextEdit } from 'vscode-languageserver';
import { join } from 'path';
import { readFileSync } from 'fs';
import { parseText } from '../../../src/utils/ast.utils';
import { buildPartGridData } from '../../../src/features/part-editor/part-grid-data.service';
import { buildPartGridEdit } from '../../../src/features/part-editor/grid-edit.service';
import {
    CellPairListLayerData,
    CellSetLayerData,
    CellToValuesLayerData,
    GridMutation,
    PartGridData,
    PointListLayerData,
    RectLayerData,
} from '../../../src/features/part-editor/part-grid.types';
import { FIXTURES_DIR } from '../../helpers';
import { initWorkspace } from '../../workspace-helper';

// The write side of the part grid editor: every mutation kind must produce a minimal edit that
// round-trips (apply, re-parse, rebuild the payload, observe the mutated state), preserve the
// authored vector form it touches, and materialize local overrides for inherited-only fields.
const token = CancellationToken.None;
const FIXTURE_DIR = join(FIXTURES_DIR, 'part-editor');
const basePath = join(FIXTURE_DIR, 'base_part.rules');
const derivedPath = join(FIXTURE_DIR, 'derived_part.rules');

/** Applies LSP text edits to a source string (offsets computed with the same line math the server uses). */
const applyEdits = (text: string, edits: TextEdit[]): string => {
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

/** Runs one mutation against a fixture and returns the edited text plus the rebuilt payload. */
const mutate = async (
    path: string,
    mutation: GridMutation
): Promise<{ text: string; edited: string; data: PartGridData; edits: TextEdit[] }> => {
    const text = readFileSync(path, 'utf-8');
    const document = parseText(text, path);
    const result = await buildPartGridEdit(document, text, path, 0, mutation, token);
    expect(result.status, result.message).toBe('ok');
    const edits = result.edit!.changes![path];
    const edited = applyEdits(text, edits);
    const data = (await buildPartGridData(parseText(edited, path), 0, 1, token))!;
    expect(data).toBeTruthy();
    return { text, edited, data, edits };
};

const layerOf = <T>(data: PartGridData, id: string): T => data.layers.find((layer) => layer.id === id) as T;

beforeAll(async () => {
    await initWorkspace();
});

describe('buildPartGridEdit', () => {
    it('appends a cell to a block-form list on its own indented line', async () => {
        const { edited, data } = await mutate(basePath, {
            op: 'addCell',
            layerId: 'AllowedDoorLocations',
            cell: { x: -1, y: 0 },
        });
        expect(edited).toContain('\t\t[-1, 0]');
        const doors = layerOf<CellSetLayerData>(data, 'AllowedDoorLocations');
        expect(doors.cells.map(({ cell }) => [cell.x, cell.y])).toEqual([
            [0, -1],
            [1, 0],
            [-1, 0],
        ]);
    });

    it('appends a cell to a single-line list inline', async () => {
        const { edited, data } = await mutate(basePath, {
            op: 'addCell',
            layerId: 'BlockedTravelCells',
            cell: { x: 0, y: 0 },
        });
        expect(edited).toContain('BlockedTravelCells = [ [0, 1], [0, 0] ]');
        expect(layerOf<CellSetLayerData>(data, 'BlockedTravelCells').cells).toHaveLength(2);
    });

    it('removes a leading cell together with the separator toward its follower', async () => {
        const { data } = await mutate(basePath, {
            op: 'removeCell',
            layerId: 'AllowedDoorLocations',
            cell: { x: 0, y: -1 },
        });
        const doors = layerOf<CellSetLayerData>(data, 'AllowedDoorLocations');
        expect(doors.cells.map(({ cell }) => [cell.x, cell.y])).toEqual([[1, 0]]);
    });

    it('replaces an existing map entry value in place', async () => {
        const { data } = await mutate(basePath, {
            op: 'setEntryValues',
            layerId: 'ExternalWallsByCell',
            cell: { x: 0, y: 0 },
            values: ['Left', 'TopLeft'],
        });
        const walls = layerOf<CellToValuesLayerData>(data, 'ExternalWallsByCell');
        expect(walls.entries.find(({ cell }) => cell.x === 0 && cell.y === 0)?.values).toEqual(['Left', 'TopLeft']);
        expect(walls.entries).toHaveLength(2);
    });

    it('appends a new map entry in the vanilla Key/Value form', async () => {
        const { edited, data } = await mutate(basePath, {
            op: 'setEntryValues',
            layerId: 'ExternalWallsByCell',
            cell: { x: 0, y: -1 },
            values: ['Top'],
        });
        expect(edited).toContain('{ Key = [0, -1]; Value = [Top] }');
        expect(layerOf<CellToValuesLayerData>(data, 'ExternalWallsByCell').entries).toHaveLength(3);
    });

    it('removes a map entry when the new value set is empty', async () => {
        const { data } = await mutate(basePath, {
            op: 'setEntryValues',
            layerId: 'ExternalWallsByCell',
            cell: { x: 0, y: 0 },
            values: [],
        });
        const walls = layerOf<CellToValuesLayerData>(data, 'ExternalWallsByCell');
        expect(walls.entries).toHaveLength(1);
        expect(walls.entries[0].cell).toEqual({ x: 0, y: 1 });
    });

    it('adds a fractional crew point to a component layer', async () => {
        const { data } = await mutate(basePath, {
            op: 'addPoint',
            layerId: 'Components/crew_a/CrewDestinations',
            point: { x: 0.75, y: 1.25 },
        });
        const crew = layerOf<PointListLayerData>(data, 'Components/crew_a/CrewDestinations');
        expect(crew.points.map(({ point }) => [point.x, point.y])).toEqual([
            [0.5, 0.5],
            [0.75, 1.25],
        ]);
    });

    it('moves a group-form point preserving the {X= Y=} authoring form', async () => {
        const { edited, data } = await mutate(basePath, {
            op: 'movePoint',
            layerId: 'Components/crew_b/CrewDestinations',
            index: 1,
            point: { x: 0.5, y: 1 },
        });
        expect(edited).toContain('{X = 0.5; Y = 1}');
        const crew = layerOf<PointListLayerData>(data, 'Components/crew_b/CrewDestinations');
        expect(crew.points[1].point).toEqual({ x: 0.5, y: 1 });
    });

    it('removes a point by index', async () => {
        const { data } = await mutate(basePath, {
            op: 'removePoint',
            layerId: 'Components/crew_b/CrewDestinations',
            index: 0,
        });
        const crew = layerOf<PointListLayerData>(data, 'Components/crew_b/CrewDestinations');
        expect(crew.points.map(({ point }) => [point.x, point.y])).toEqual([[0.25, 0.75]]);
    });

    it('appends and removes virtual cell pairs', async () => {
        const appended = await mutate(basePath, {
            op: 'setPair',
            layerId: 'VirtualInternalCells',
            index: null,
            external: { x: 1, y: 2 },
            internal: { x: 0, y: 1 },
        });
        expect(appended.edited).toContain('{ ExternalCell = [1, 2]; InternalCell = [0, 1] }');
        expect(layerOf<CellPairListLayerData>(appended.data, 'VirtualInternalCells').pairs).toHaveLength(2);

        const removed = await mutate(basePath, { op: 'removePair', layerId: 'VirtualInternalCells', index: 0 });
        expect(layerOf<CellPairListLayerData>(removed.data, 'VirtualInternalCells').pairs).toHaveLength(0);
    });

    it('rewrites a rect in positional form and removes it cleanly', async () => {
        const set = await mutate(basePath, {
            op: 'setRect',
            layerId: 'PhysicalRect',
            rect: { x: 0, y: 1, width: 1, height: 1 },
        });
        expect(set.edited).toContain('PhysicalRect = [0, 1, 1, 1]');
        expect(layerOf<RectLayerData>(set.data, 'PhysicalRect').rect).toEqual({ x: 0, y: 1, width: 1, height: 1 });

        const removed = await mutate(basePath, { op: 'setRect', layerId: 'PhysicalRect', rect: null });
        expect(removed.edited).not.toContain('PhysicalRect');
        expect(removed.edited).not.toMatch(/\n\t\n\tExternalWalls/);
        expect(layerOf<RectLayerData>(removed.data, 'PhysicalRect').rect).toBeNull();
    });

    it('creates a rect field when none exists', async () => {
        const { edited, data } = await mutate(basePath, {
            op: 'setRect',
            layerId: 'SaveRect',
            rect: { x: 0, y: 0, width: 1, height: 2 },
        });
        expect(edited).toContain('SaveRect = [0, 0, 1, 2]');
        expect(layerOf<RectLayerData>(data, 'SaveRect').rect).toEqual({ x: 0, y: 0, width: 1, height: 2 });
    });

    it('resizes the part in place', async () => {
        const { edited, data } = await mutate(basePath, { op: 'setSize', size: { width: 2, height: 2 } });
        expect(edited).toContain('Size = [2, 2]');
        expect(data.size).toMatchObject({ width: 2, height: 2 });
    });

    it('sets the rotation booleans and int lists', async () => {
        const flipped = await mutate(basePath, { op: 'setBool', field: 'IsFlippable', value: true });
        expect(flipped.edited).toContain('IsFlippable = true');
        expect(flipped.data.rotation.isFlippable.value).toBe(true);

        const inserted = await mutate(basePath, { op: 'setIntList', field: 'FlipVRotate', values: [0, 2, 1, 3] });
        expect(inserted.edited).toContain('FlipVRotate = [0, 2, 1, 3]');
        expect(inserted.data.rotation.flipVRotate?.values).toEqual([0, 2, 1, 3]);

        const removed = await mutate(basePath, { op: 'setIntList', field: 'FlipHRotate', values: null });
        expect(removed.edited).not.toContain('FlipHRotate');
        expect(removed.data.rotation.flipHRotate).toBeNull();
    });

    it('materializes a local override when toggling a cell of an inherited-only field', async () => {
        const { edited, data } = await mutate(derivedPath, {
            op: 'addCell',
            layerId: 'AllowedDoorLocations',
            cell: { x: -1, y: 1 },
        });
        // The inherited cells are written out locally with the new one appended.
        expect(edited).toContain('AllowedDoorLocations');
        const doors = layerOf<CellSetLayerData>(data, 'AllowedDoorLocations');
        expect(doors.inherited).toBe(false);
        expect(doors.cells.map(({ cell }) => [cell.x, cell.y])).toEqual([
            [0, -1],
            [1, 0],
            [-1, 1],
        ]);
    });

    it('refuses edits on a component that only exists on the base part', async () => {
        const text = readFileSync(derivedPath, 'utf-8');
        const document = parseText(text, derivedPath);
        const result = await buildPartGridEdit(
            document,
            text,
            derivedPath,
            0,
            { op: 'addPoint', layerId: 'Components/crew_a/CrewDestinations', point: { x: 0.5, y: 0.5 } },
            token
        );
        expect(result.status).toBe('error');
        expect(result.message).toBeTruthy();
    });

    it('removes the whole field when the last cell of a non-inherited field is removed', async () => {
        // BlockedTravelCells holds a single cell and no base part defines the field, so emptying
        // it must not leave `BlockedTravelCells [ ]` noise behind.
        const { edited, data } = await mutate(basePath, {
            op: 'removeCell',
            layerId: 'BlockedTravelCells',
            cell: { x: 0, y: 1 },
        });
        expect(edited).not.toContain('BlockedTravelCells');
        const blocked = layerOf<CellSetLayerData>(data, 'BlockedTravelCells');
        expect(blocked.origin).toBeNull();
        expect(blocked.cells).toEqual([]);
    });

    it('keeps an explicit empty list when the emptied field overrides an inherited one', async () => {
        // The derived part's local BlockedTravelCells overrides the base's. Emptying it must stay
        // an explicit empty override, or the base's cells would silently come back.
        const { edited, data } = await mutate(derivedPath, {
            op: 'removeCell',
            layerId: 'BlockedTravelCells',
            cell: { x: 0, y: 0 },
        });
        expect(edited).toContain('BlockedTravelCells');
        const blocked = layerOf<CellSetLayerData>(data, 'BlockedTravelCells');
        expect(blocked.inherited).toBe(false);
        expect(blocked.cells).toEqual([]);
    });

    it('removes the whole field when the inherited definition is an empty list too', async () => {
        // The armor idiom: the base writes `AllowedDoorLocations = []`, the derived part got a
        // cell added by the editor and removed again. Since deleting the local field resurfaces
        // nothing (the base list is empty), the leftover `AllowedDoorLocations [ ]` must go.
        const emptyDerivedPath = join(FIXTURE_DIR, 'empty_derived.rules');
        const { edited, data } = await mutate(emptyDerivedPath, {
            op: 'removeCell',
            layerId: 'AllowedDoorLocations',
            cell: { x: 0, y: -1 },
        });
        expect(edited).not.toContain('AllowedDoorLocations');
        const doors = layerOf<CellSetLayerData>(data, 'AllowedDoorLocations');
        expect(doors.cells).toEqual([]);
        expect(doors.inherited).toBe(true);
    });

    it('removes an emptied map field and an emptied pair list the same way', async () => {
        const virtual = await mutate(basePath, { op: 'removePair', layerId: 'VirtualInternalCells', index: 0 });
        expect(virtual.edited).not.toContain('VirtualInternalCells');

        const walls = await mutate(basePath, {
            op: 'setEntryValues',
            layerId: 'ExternalWallsByCell',
            cell: { x: 0, y: 0 },
            values: [],
        });
        // Two entries exist, removing one keeps the field with the other.
        expect(walls.edited).toContain('ExternalWallsByCell');
    });

    it('touches nothing outside the edit ranges', async () => {
        const { text, edited, edits } = await mutate(basePath, {
            op: 'addCell',
            layerId: 'AllowedDoorLocations',
            cell: { x: -1, y: 0 },
        });
        expect(edits).toHaveLength(1);
        const range: Range = edits[0].range;
        // A pure insertion: everything before the point is byte-identical, as is everything after.
        expect(range.start).toEqual(range.end);
        const lines = text.split('\n');
        const before = lines.slice(0, range.start.line).join('\n');
        expect(edited.startsWith(before)).toBe(true);
        expect(edited.length).toBe(text.length + edits[0].newText.length);
    });
});
