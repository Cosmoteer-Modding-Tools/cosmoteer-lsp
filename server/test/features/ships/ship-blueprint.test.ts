import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { readShipBlueprint } from '../../../src/features/ships/ship-blueprint';
import { dataNode, listNode, mapNode, netString, partNode, shipPngBytes } from './blueprint.helper';

const DATA_DIR = process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const VANILLA_SHIP = join(DATA_DIR, 'builtin_ships', 'Cabal', 'Civilian', 'Acolyte.ship.png');

const root = mkdtempSync(join(tmpdir(), 'cosmoteer-ship-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/**
 * Writes a `.ship.png` into this test's scratch folder.
 *
 * @param tree the ObjectBits tree to hide.
 * @param name the file to write.
 * @returns the path written.
 */
const writeShipPng = (tree: Buffer, name: string): string => {
    const path = join(root, name);
    writeFileSync(path, shipPngBytes(tree));
    return path;
};

describe('reading a saved ship out of its picture', () => {
    it('reads the parts, their places and what the ship says about itself', async () => {
        const tree = mapNode([
            ['Author', dataNode(netString('Saris'))],
            ['Name', dataNode(netString('Probe'))],
            ['Description', dataNode(netString('A tiny ship.'))],
            ['Decals1', listNode([mapNode([]), mapNode([])])],
            ['Doors', listNode([mapNode([])])],
            [
                'Parts',
                listNode([
                    partNode('cosmoteer.corridor', -2, 1, 0, false),
                    partNode('cosmoteer.corridor', -1, 1, 1, true),
                    partNode('mod.invented_part', 3, 4, 2, false),
                ]),
            ],
        ]);
        const blueprint = await readShipBlueprint(writeShipPng(tree, 'probe.ship.png'));
        expect(blueprint?.name).toBe('Probe');
        expect(blueprint?.author).toBe('Saris');
        expect(blueprint?.description).toBe('A tiny ship.');
        expect(blueprint?.decals).toBe(2);
        expect(blueprint?.doors).toBe(1);
        expect(blueprint?.parts).toEqual([
            { id: 'cosmoteer.corridor', x: -2, y: 1, rotation: 0, flipX: false },
            { id: 'cosmoteer.corridor', x: -1, y: 1, rotation: 1, flipX: true },
            { id: 'mod.invented_part', x: 3, y: 4, rotation: 2, flipX: false },
        ]);
    });

    it('answers nothing for a picture carrying no ship', async () => {
        const path = writeShipPng(mapNode([]), 'empty.ship.png');
        // The payload is overwritten with a picture that hides nothing, which is every other PNG.
        writeFileSync(path, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(64)]));
        expect(await readShipBlueprint(path)).toBeUndefined();
    });

    it('answers nothing for a file that is not a picture', async () => {
        const path = join(root, 'not-a-png.ship.png');
        writeFileSync(path, Buffer.from('Part\n{\n}\n', 'utf8'));
        expect(await readShipBlueprint(path)).toBeUndefined();
    });
});

// The format belongs to the game, so the one test that can catch it changing reads a ship the game
// itself ships. Skipped where the game is not installed.
describe.skipIf(!existsSync(VANILLA_SHIP))('reading a ship the game ships', () => {
    it('reads its parts and its author', async () => {
        const blueprint = await readShipBlueprint(VANILLA_SHIP);
        expect(blueprint).toBeDefined();
        expect(blueprint!.parts.length).toBeGreaterThan(50);
        expect(blueprint!.name).toBeTruthy();
        // Every part of a ship the game ships is one the game declares.
        expect(blueprint!.parts.every((part) => part.id.startsWith('cosmoteer.'))).toBe(true);
    });
});
