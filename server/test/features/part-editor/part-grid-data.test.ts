import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { join } from 'path';
import { readFileSync } from 'fs';
import { parseFilePath } from '../../../src/utils/ast.utils';
import { buildPartGridData, locatePartGroup } from '../../../src/features/part-editor/part-grid-data.service';
import {
    CellSetLayerData,
    CellToValuesLayerData,
    PartGridData,
    PointListLayerData,
    RectLayerData,
    CellPairListLayerData,
} from '../../../src/features/part-editor/part-grid.types';
import { FIXTURES_DIR } from '../../helpers';
import { initWorkspace } from '../../workspace-helper';

// The part grid editor's read side: the payload builder must see every grid-authorable field in
// both authoring forms (`[x, y]` lists and `{X= Y=}` groups, assignment and block lists), resolve
// values through cross-file inheritance with correct provenance, scan components for crew layers,
// and place sprites with the game's centered-on-Location formula.
const token = CancellationToken.None;
const FIXTURE_DIR = join(FIXTURES_DIR, 'part-editor');
const basePath = join(FIXTURE_DIR, 'base_part.rules');
const derivedPath = join(FIXTURE_DIR, 'derived_part.rules');

const layerOf = <T>(data: PartGridData, id: string): T => {
    const layer = data.layers.find((candidate) => candidate.id === id);
    expect(layer, `layer ${id}`).toBeTruthy();
    return layer as T;
};

describe('buildPartGridData', () => {
    let base: PartGridData;
    let derived: PartGridData;

    beforeAll(async () => {
        await initWorkspace();
        const baseDocument = await parseFilePath(basePath);
        const baseOffset = readFileSync(basePath, 'utf-8').indexOf('Size');
        base = (await buildPartGridData(baseDocument, baseOffset, 7, token))!;
        const derivedDocument = await parseFilePath(derivedPath);
        derived = (await buildPartGridData(derivedDocument, 0, 3, token))!;
    });

    it('reads the grid size and echoes the document version', () => {
        expect(base).toBeTruthy();
        expect(base.size.width).toBe(1);
        expect(base.size.height).toBe(2);
        expect(base.size.origin?.inherited).toBe(false);
        expect(base.dataVersion).toBe(7);
        expect(base.partName).toBe('base_part');
    });

    it('reads a block-form cell-set field with its outside domain', () => {
        const doors = layerOf<CellSetLayerData>(base, 'AllowedDoorLocations');
        expect(doors.domain).toBe('outside');
        expect(doors.cells.map(({ cell }) => [cell.x, cell.y])).toEqual([
            [0, -1],
            [1, 0],
        ]);
        expect(doors.inherited).toBe(false);
    });

    it('reads an assignment-form cell-set field', () => {
        const blocked = layerOf<CellSetLayerData>(base, 'BlockedTravelCells');
        expect(blocked.domain).toBe('inside');
        expect(blocked.cells.map(({ cell }) => [cell.x, cell.y])).toEqual([[0, 1]]);
    });

    it('reads map entries with list-form and group-form keys', () => {
        const walls = layerOf<CellToValuesLayerData>(base, 'ExternalWallsByCell');
        expect(walls.valueModel).toBe('flags');
        expect(walls.enumNames).toContain('TopRight');
        expect(walls.entries).toEqual([
            expect.objectContaining({ cell: { x: 0, y: 0 }, values: ['TopRight', 'Right'] }),
            expect.objectContaining({ cell: { x: 0, y: 1 }, values: ['Bottom'] }),
        ]);
        expect(walls.fallback).toEqual(['All']);
    });

    it('emits an empty layer with a null origin for a field absent everywhere', () => {
        const directions = layerOf<CellToValuesLayerData>(base, 'BlockedTravelCellDirections');
        expect(directions.entries).toEqual([]);
        expect(directions.origin).toBeNull();
        expect(directions.enumNames).toContain('Up');
    });

    it('builds one fractional point layer per crew component, reading both vector forms', () => {
        const crewA = layerOf<PointListLayerData>(base, 'Components/crew_a/CrewDestinations');
        expect(crewA.points.map(({ point }) => [point.x, point.y])).toEqual([[0.5, 0.5]]);
        const crewB = layerOf<PointListLayerData>(base, 'Components/crew_b/CrewDestinations');
        expect(crewB.points.map(({ point }) => [point.x, point.y])).toEqual([
            [0.5, 1.5],
            [0.25, 0.75],
        ]);
        expect(crewB.fieldPath).toEqual(['Components', 'crew_b']);
    });

    it('reads virtual internal cell pairs', () => {
        const virtual = layerOf<CellPairListLayerData>(base, 'VirtualInternalCells');
        expect(virtual.pairs).toEqual([
            expect.objectContaining({ external: { x: 0, y: -1 }, internal: { x: 0, y: 0 } }),
        ]);
    });

    it('reads the physical rect in positional form as X, Y, Width, Height', () => {
        const rect = layerOf<RectLayerData>(base, 'PhysicalRect');
        expect(rect.rect).toEqual({ x: 0, y: 0, width: 1, height: 2 });
        const save = layerOf<RectLayerData>(base, 'SaveRect');
        expect(save.rect).toBeNull();
        expect(save.origin).toBeNull();
    });

    it('reads the rotation fields', () => {
        expect(base.rotation.isRotateable.value).toBe(true);
        expect(base.rotation.isFlippable.value).toBe(false);
        expect(base.rotation.flipHRotate?.values).toEqual([0, 2, 1, 3]);
        expect(base.rotation.flipVRotate).toBeNull();
    });

    it('places sprites with the centered-on-Location formula and resolves their files', () => {
        const floor = base.sprites.find((sprite) => sprite.id === 'floor')!;
        expect(floor).toBeTruthy();
        // Location [0.5, 1] minus Size [1, 2] / 2 puts the floor exactly on the part rect.
        expect(floor.offset).toEqual([0, 0]);
        expect(floor.size).toEqual([1, 2]);
        expect(floor.uri).toMatch(/^file:.*floor\.png$/);
        const roof = base.sprites.find((sprite) => sprite.id === 'roof')!;
        // The Roof slot's own Offset [0, 0.5] shifts the centered rect down half a cell.
        expect(roof.offset).toEqual([0, 0.5]);
        expect(roof.defaultVisible).toBe(false);
    });

    it('renders a margin covering the out-of-bounds door and virtual cells', () => {
        expect(base.margin).toBeGreaterThanOrEqual(1);
    });

    it('resolves inherited fields through cross-file inheritance with inherited provenance', () => {
        expect(derived).toBeTruthy();
        expect(derived.size.width).toBe(1);
        expect(derived.size.height).toBe(2);
        expect(derived.size.origin?.inherited).toBe(true);
        expect(derived.size.origin?.uri).toMatch(/base_part\.rules$/);
        const doors = layerOf<CellSetLayerData>(derived, 'AllowedDoorLocations');
        expect(doors.inherited).toBe(true);
        expect(doors.cells).toHaveLength(2);
    });

    it('prefers local overrides over inherited values', () => {
        const blocked = layerOf<CellSetLayerData>(derived, 'BlockedTravelCells');
        expect(blocked.inherited).toBe(false);
        expect(blocked.cells.map(({ cell }) => [cell.x, cell.y])).toEqual([[0, 0]]);
        expect(blocked.cells[0].origin.uri).toMatch(/derived_part\.rules$/);
    });

    it('locates the part group from any offset inside the document', async () => {
        const document = await parseFilePath(basePath);
        expect(locatePartGroup(document, 0)).toBeTruthy();
        expect(locatePartGroup(document, readFileSync(basePath, 'utf-8').indexOf('CrewDestinations'))).toBeTruthy();
    });
});
