import { describe, expect, it } from 'vitest';
import { existsSync } from 'fs';
import { join } from 'path';
import { CancellationToken } from 'vscode-languageserver';
import { parseFilePath } from '../../../src/utils/ast.utils';
import { buildPartGridData } from '../../../src/features/part-editor/part-grid-data.service';
import {
    CellDirectionLayerData,
    CellSetLayerData,
    CellToValuesLayerData,
    ComponentPointsLayerData,
    EdgeRegionLayerData,
    PolygonLayerData,
    RectLayerData,
    RectListLayerData,
} from '../../../src/features/part-editor/part-grid.types';

// Ground-truth exercise of the payload builder against real vanilla parts, the same files the
// coordinate conventions were verified on (wedge walls, thruster overhang and door ring). Needs the
// game install, so it self-skips when Data/ is absent (e.g. CI). Point it elsewhere with
// COSMOTEER_DATA_DIR.
const DATA_DIR =
    process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const HAVE_DATA = existsSync(DATA_DIR);
const token = CancellationToken.None;

const buildFor = async (relativePath: string) => {
    const path = join(DATA_DIR, relativePath);
    const document = await parseFilePath(path);
    return buildPartGridData(document, 0, 1, token);
};

describe.skipIf(!HAVE_DATA)('buildPartGridData over vanilla parts', () => {
    it('reads the armor wedge: size, per-cell walls, physical rect, and the exact floor placement', async () => {
        const data = (await buildFor('ships/terran/armor_1x2_wedge/armor_1x2_wedge.rules'))!;
        expect(data).toBeTruthy();
        expect(data.size).toMatchObject({ width: 1, height: 2 });

        const walls = data.layers.find((layer) => layer.id === 'ExternalWallsByCell') as CellToValuesLayerData;
        expect(walls.entries.length).toBeGreaterThanOrEqual(2);
        const topCell = walls.entries.find(({ cell }) => cell.x === 0 && cell.y === 0)!;
        expect(topCell.values).toEqual(['TopRight', 'Right']);

        const floor = data.sprites.find((sprite) => sprite.id.startsWith('floor'))!;
        expect(floor.uri).toMatch(/floor\.png$/);
        // Graphics Location [0.5, 1], sprite Size [1, 2]: the floor covers exactly the part rect.
        expect(floor.offset).toEqual([0, 0]);
        expect(floor.size).toEqual([1, 2]);
    });

    it('reads the small thruster: outside door ring, non-physical nozzle cell, crew destinations', async () => {
        const data = (await buildFor('ships/terran/thruster_small/thruster_small.rules'))!;
        expect(data).toBeTruthy();
        expect(data.size).toMatchObject({ width: 1, height: 2 });

        const doors = data.layers.find((layer) => layer.id === 'AllowedDoorLocations') as CellSetLayerData;
        expect(doors.domain).toBe('outside');
        expect(doors.cells.map(({ cell }) => [cell.x, cell.y])).toEqual(
            expect.arrayContaining([
                [0, -1],
                [1, 0],
                [-1, 0],
            ])
        );

        const physical = data.layers.find((layer) => layer.id === 'PhysicalRect') as RectLayerData;
        expect(physical.rect).toEqual({ x: 0, y: 0, width: 1, height: 1 });

        // The nozzle sprite overhangs the physical cell, so the payload must keep it on canvas.
        expect(data.margin).toBeGreaterThanOrEqual(1);

        // The nozzle collider is a polygon and the graphics components appear in the gizmo.
        const collider = data.layers.find(
            (layer): layer is PolygonLayerData => layer.kind === 'polygon' && layer.id.includes('NozzleCollider')
        );
        expect(collider).toBeTruthy();
        expect(collider!.vertices.length).toBeGreaterThanOrEqual(3);
        const gizmo = data.layers.find(
            (layer): layer is ComponentPointsLayerData => layer.kind === 'componentPoints'
        )!;
        expect(gizmo.entries.some((entry) => entry.component === 'NozzleGraphics' && entry.location)).toBe(true);
    });

    it('reads the heat exchanger network ports as cell-direction layers', async () => {
        const data = (await buildFor('ships/terran/heat_exchanger/heat_exchanger.rules'))!;
        expect(data).toBeTruthy();
        const ports = data.layers.filter(
            (layer): layer is CellDirectionLayerData => layer.kind === 'cellDirection'
        );
        expect(ports.length).toBeGreaterThanOrEqual(1);
        expect(ports.some((port) => port.direction === 'Down')).toBe(true);

        // The absorption area is an EdgeDistance region: a distance-from-edge halo, distance 5.
        const region = data.layers.find(
            (layer): layer is EdgeRegionLayerData => layer.kind === 'edgeRegion'
        )!;
        expect(region).toBeTruthy();
        expect(region.distance).toBe(5);
        expect(region.distanceField).toBe('Distance');
        expect(region.id).toBe('Components/HeatExchanger/Region');
    });

    it('reads the cannon deck prohibit rects and resource grids', async () => {
        const data = (await buildFor('ships/terran/cannon_deck/cannon_deck.rules'))!;
        expect(data).toBeTruthy();
        const prohibit = data.layers.find(
            (layer): layer is RectListLayerData => layer.kind === 'rectList'
        )!;
        expect(prohibit.entries.length).toBeGreaterThanOrEqual(3);
        expect(prohibit.entries[0]).toEqual(
            expect.objectContaining({ tag: 'tall', rect: { x: -2, y: -2, width: 8, height: 2 } })
        );
        const grids = data.layers.filter(
            (layer): layer is RectLayerData => layer.kind === 'rect' && layer.fieldName === 'GridRect'
        );
        expect(grids.length).toBeGreaterThanOrEqual(1);
    });
});
