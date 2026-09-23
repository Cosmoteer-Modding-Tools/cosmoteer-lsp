import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken, TextEdit } from 'vscode-languageserver';
import { join } from 'path';
import { parseText } from '../../../src/utils/ast.utils';
import { filePathToUri } from '../../../src/document/reference-path';
import { buildPartGridData } from '../../../src/features/part-editor/part-grid-data.service';
import { buildPartGridEdit } from '../../../src/features/part-editor/grid-edit.service';
import {
    CellSetLayerData,
    CellToValuesLayerData,
    ComponentPointsLayerData,
    GridMutation,
    PartGridData,
    PartGridEditResult,
    PointListLayerData,
    RectListLayerData,
} from '../../../src/features/part-editor/part-grid.types';
import { FIXTURES_DIR } from '../../helpers';
import { initWorkspace } from '../../workspace-helper';

// The game reads every coordinate through its expression evaluator, so a cell written `2-1` is a
// cell it places and a rect written `1 - 14/64` is a rect it draws. These are about the editor
// seeing the same part the game sees, and about the write landing on the entry the author pointed
// at rather than on its neighbour.
const token = CancellationToken.None;
const partPath = join(FIXTURES_DIR, 'part-editor', 'computed_part.rules');

const PART = [
    'SIZE = [4, 2]',
    'Part',
    '{',
    '\tSize = [4, 2]',
    '\tAllowedDoorLocations',
    '\t[',
    '\t\t[3-1, -1]',
    '\t\t[0, 0]',
    '\t]',
    '\tExternalWallsByCell',
    '\t[',
    '\t\t{ Key = [2-1, 0]; Value = [Top] }',
    '\t\t{ Key = [2, 0]; Value = [Top] }',
    '\t]',
    '\tProhibitRects',
    '\t[',
    '\t\t[tall, [0, 0, 1, 1]]',
    '\t\t[tall, [1, 1, 2-1, 1]]',
    '\t\t[tall, [2, 2, 1, 1]]',
    '\t]',
    '\tComponents',
    '\t{',
    '\t\tcrew_a',
    '\t\t{',
    '\t\t\tType = PartCrew',
    '\t\t\tCrewDestinations',
    '\t\t\t[',
    '\t\t\t\t[1.5, 192/64]',
    '\t\t\t\t[0.5, 0.5]',
    '\t\t\t]',
    '\t\t}',
    '\t\tspot',
    '\t\t{',
    '\t\t\tType = Sprite',
    '\t\t\tLocation = [1.25, 0.75]',
    '\t\t}',
    '\t\tcrew_b',
    '\t\t{',
    '\t\t\tType = PartCrew',
    '\t\t\tCrewDestinations',
    '\t\t\t[',
    '\t\t\t\t&../../spot/Location',
    '\t\t\t]',
    '\t\t}',
    '\t\tturret',
    '\t\t{',
    '\t\t\tType = Sprite',
    '\t\t\tLocation = [1, 1]',
    '\t\t}',
    '\t\tammo',
    '\t\t{',
    '\t\t\tType = Sprite',
    '\t\t\tChainedTo = turret',
    '\t\t\tLocation = [-0.14+0.03, -0.38-0.015]',
    '\t\t}',
    '\t\tfeeder',
    '\t\t{',
    '\t\t\tType = Sprite',
    '\t\t\tChainedTo = turret',
    '\t\t\tLocation = [&../../nowhere/Location, 0]',
    '\t\t}',
    '\t\tstore',
    '\t\t{',
    '\t\t\tType = ResourceStorage',
    '\t\t\tUITileRect = [7/64, 7/64, 1 - 14/64, 1 - 14/64]',
    '\t\t}',
    '\t}',
    '}',
    '',
].join('\n');

/** Applies LSP text edits to a source string. */
const applyEdits = (text: string, edits: readonly TextEdit[]): string => {
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

/** The payload of the fixture part as it stands. */
const payload = async (text: string = PART): Promise<PartGridData> =>
    (await buildPartGridData(parseText(text, partPath), 0, 1, token))!;

/** Runs one mutation against the fixture part and hands back the raw result. */
const edit = async (mutation: GridMutation, text: string = PART): Promise<PartGridEditResult> =>
    buildPartGridEdit(parseText(text, partPath), text, partPath, 0, mutation, token);

/** Runs one mutation and returns the text the part file ends up with. */
const rewritten = async (mutation: GridMutation, text: string = PART): Promise<string> => {
    const result = await edit(mutation, text);
    expect(result.status, result.message).toBe('ok');
    return applyEdits(text, result.edit!.changes![filePathToUri(partPath)] ?? []);
};

const layerOf = <T>(data: PartGridData, id: string): T => data.layers.find((layer) => layer.id === id) as T;

describe('grid layers of computed coordinates', () => {
    beforeAll(async () => {
        await initWorkspace();
    });

    it('draws a wall cell whose key is written as arithmetic', async () => {
        const walls = layerOf<CellToValuesLayerData>(await payload(), 'ExternalWallsByCell');
        expect(walls.entries.map(({ cell }) => [cell.x, cell.y])).toEqual([
            [1, 0],
            [2, 0],
        ]);
    });

    it('rewrites the arithmetic-keyed entry in place instead of naming the cell twice', async () => {
        const text = await rewritten({
            op: 'setEntryValues',
            layerId: 'ExternalWallsByCell',
            cell: { x: 1, y: 0 },
            values: ['Left'],
        });
        expect(text).toContain('{ Key = [2-1, 0]; Value = [Left] }');
        expect(text).toContain('{ Key = [2, 0]; Value = [Top] }');
        // The game builds this field with one dictionary add per entry and throws on a repeated
        // key, so a second entry for the same cell is a mod that stops loading.
        expect(text.match(/Key = /g)).toHaveLength(2);
    });

    it('refuses a new entry while the field holds a key it cannot read', async () => {
        const broken = PART.replace('{ Key = [2, 0]; Value = [Top] }', '{ Key = [&~/NOWHERE/0, 0]; Value = [Top] }');
        const result = await edit(
            { op: 'setEntryValues', layerId: 'ExternalWallsByCell', cell: { x: 3, y: 1 }, values: ['Top'] },
            broken
        );
        expect(result.status).toBe('error');
        expect(result.message).toBeTruthy();
    });

    it('counts prohibit rows the way the picture counts them', async () => {
        const rects = layerOf<RectListLayerData>(await payload(), 'ProhibitRects');
        expect(rects.entries.map(({ rect }) => [rect.x, rect.y])).toEqual([
            [0, 0],
            [1, 1],
            [2, 2],
        ]);
        const text = await rewritten({
            op: 'setRectEntry',
            layerId: 'ProhibitRects',
            index: 1,
            tag: null,
            rect: { x: 9, y: 9, width: 1, height: 1 },
        });
        expect(text).toContain('[tall, [9, 9, 2-1, 1]]');
        expect(text).toContain('[tall, [0, 0, 1, 1]]');
        expect(text).toContain('[tall, [2, 2, 1, 1]]');
    });

    it('deletes the prohibit row the picture pointed at', async () => {
        const text = await rewritten({ op: 'removeRectEntry', layerId: 'ProhibitRects', index: 1 });
        expect(text).not.toContain('[tall, [1, 1, 2-1, 1]]');
        expect(text).toContain('[tall, [0, 0, 1, 1]]');
        expect(text).toContain('[tall, [2, 2, 1, 1]]');
    });

    it('draws the crew destinations written as arithmetic', async () => {
        const crew = layerOf<PointListLayerData>(await payload(), 'Components/crew_a/CrewDestinations');
        expect(crew.points.map(({ point }) => [point.x, point.y])).toEqual([
            [1.5, 3],
            [0.5, 0.5],
        ]);
    });

    it('draws a crew destination written as a bare reference', async () => {
        // The shape the game's own crew components use, one destination naming another
        // component's location instead of repeating its numbers.
        const crew = layerOf<PointListLayerData>(await payload(), 'Components/crew_b/CrewDestinations');
        expect(crew.points.map(({ point }) => [point.x, point.y])).toEqual([[1.25, 0.75]]);
    });

    it('moves the crew destination the picture drew first', async () => {
        const text = await rewritten({
            op: 'movePoint',
            layerId: 'Components/crew_a/CrewDestinations',
            index: 0,
            point: { x: 1.5, y: 2 },
        });
        expect(text).toContain('[1.5, 2]');
        expect(text).toContain('[0.5, 0.5]');
    });

    it('draws a door cell written as arithmetic and never names it twice', async () => {
        const doors = layerOf<CellSetLayerData>(await payload(), 'AllowedDoorLocations');
        expect(doors.cells.map(({ cell }) => [cell.x, cell.y])).toEqual([
            [2, -1],
            [0, 0],
        ]);
        const added = await rewritten({ op: 'addCell', layerId: 'AllowedDoorLocations', cell: { x: 2, y: -1 } });
        expect(added).toBe(PART);
        const removed = await rewritten({ op: 'removeCell', layerId: 'AllowedDoorLocations', cell: { x: 2, y: -1 } });
        expect(removed).not.toContain('3-1');
        expect(removed).toContain('[0, 0]');
    });

    it('draws a chained component at its parent plus the offset its arithmetic works out to', async () => {
        // `[-0.14+0.03, -0.38-0.015]` is an offset from the component this one is chained to, so the
        // marker belongs at the parent's own point moved by it.
        const layer = layerOf<ComponentPointsLayerData>(await payload(), 'ComponentLocations');
        const ammo = layer.entries.find((entry) => entry.component === 'ammo')!;
        expect(ammo.location).toEqual({ x: 0.89, y: 0.605 });
        expect(layer.entries.find((entry) => entry.component === 'turret')!.location).toEqual({ x: 1, y: 1 });
    });

    it('draws no marker for a chained component whose own offset does not read', async () => {
        // Its offset names a component the part does not declare, so nothing can work it out.
        // Treating that as no offset at all would draw the marker on top of the component it is
        // chained to, and the first drag would move the sprite by whatever the offset was worth.
        const layer = layerOf<ComponentPointsLayerData>(await payload(), 'ComponentLocations');
        const feeder = layer.entries.find((entry) => entry.component === 'feeder')!;
        expect(feeder.locationIsRef).toBe(true);
        expect(feeder.location).toBeNull();
    });

    it('keeps the rect sides the drag left alone and says which value it replaced', async () => {
        const result = await edit({
            op: 'setRect',
            layerId: 'Components/store/UITileRect',
            rect: { x: 0.5, y: 0.109375, width: 0.78125, height: 0.78125 },
        });
        expect(result.status, result.message).toBe('ok');
        const text = applyEdits(PART, result.edit!.changes![filePathToUri(partPath)] ?? []);
        expect(text).toContain('UITileRect = [0.5, 7/64, 1 - 14/64, 1 - 14/64]');
        expect(result.note).toContain('7/64');
    });
});

describe('grid mutations the part file cannot hold', () => {
    beforeAll(async () => {
        await initWorkspace();
    });

    it('refuses a cell that is not a whole cell', async () => {
        const result = await edit({ op: 'addCell', layerId: 'AllowedDoorLocations', cell: { x: 0.5, y: -1.25 } });
        expect(result.status).toBe('error');
        expect(result.edit).toBeUndefined();
    });

    it('refuses a cell coordinate that is not a number at all', async () => {
        const result = await edit({
            op: 'addCell',
            layerId: 'AllowedDoorLocations',
            cell: { x: '2); DROP' as unknown as number, y: 0 },
        });
        expect(result.status).toBe('error');
    });

    it('refuses a part size below one cell', async () => {
        const zero = await edit({ op: 'setSize', size: { width: 0, height: 2 } });
        expect(zero.status).toBe('error');
        const fractional = await edit({ op: 'setSize', size: { width: 2.5, height: 2 } });
        expect(fractional.status).toBe('error');
    });

    it('refuses a facing name carrying anything but a name', async () => {
        const result = await edit({
            op: 'setDirection',
            layerId: 'Components/port/Location',
            direction: 'Up }\nID = x',
        });
        expect(result.status).toBe('error');
    });

    it('refuses a layer id the part has no layer for', async () => {
        const result = await edit({ op: 'addCell', layerId: 'NotAField', cell: { x: 0, y: 0 } });
        expect(result.status).toBe('error');
        expect(result.edit).toBeUndefined();
    });

    it('refuses a numeric sibling the layers do not offer', async () => {
        const result = await edit({
            op: 'setNumber',
            layerId: 'Components/store/UITileRect',
            field: 'Bogus',
            value: 7,
        });
        expect(result.status).toBe('error');
    });
});

describe('grid members inserted into a group', () => {
    beforeAll(async () => {
        await initWorkspace();
    });

    it('writes a new member at the group indent and leaves the closing brace where it was', async () => {
        const text = await rewritten({ op: 'setComponentRotation', component: 'spot', degrees: 45 });
        expect(text).toContain('\t\t\tLocation = [1.25, 0.75]\n\t\t\tRotation = 45d\n\t\t}');
    });

    it('writes a new member into a group written on one line', async () => {
        const inline = PART.replace(
            '\t\tspot\n\t\t{\n\t\t\tType = Sprite\n\t\t\tLocation = [1.25, 0.75]\n\t\t}',
            '\t\tspot { Type = Sprite; Location = [1.25, 0.75] }'
        );
        const text = await rewritten({ op: 'setComponentRotation', component: 'spot', degrees: 45 }, inline);
        expect(text).toContain('spot { Type = Sprite; Location = [1.25, 0.75]; Rotation = 45d }');
    });
});
