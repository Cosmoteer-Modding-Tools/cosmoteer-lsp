import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { globalSettings } from '../../../src/settings';
import {
    ShipLayerContext,
    invalidateShipLayers,
    judgeLayer,
    layerScopeForPart,
} from '../../../src/features/ships/ship-layer.index';

// The layer scope is derived from the game's own ship registry, so the install is the fixture: the
// three shipped ship classes declare 19, 2 and 1 layers, and every part belongs to exactly one of
// them. Self-skips without the install.
const DATA_DIR = process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const HAVE_DATA = existsSync(DATA_DIR);
const token = CancellationToken.None;

const parseFile = (abs: string) => parser(lexer(readFileSync(abs, 'utf8')), pathToFileURL(abs).href).value;

describe.skipIf(!HAVE_DATA)('the ship a part is drawn on decides its layers', () => {
    let context: ShipLayerContext;

    beforeAll(() => {
        globalSettings.cosmoteerPath = DATA_DIR;
        invalidateShipLayers();
        context = {
            gameRootDocument: parseFile(join(DATA_DIR, 'cosmoteer.rules')),
            gameRootPath: join(DATA_DIR, 'cosmoteer.rules'),
            folderPaths: [],
        };
    });

    it('scopes a terran part to the terran ship and its nineteen layers', async () => {
        const scope = await layerScopeForPart(join(DATA_DIR, 'ships/terran/airlock/airlock.rules'), 'Part', context, token);
        expect(scope.ships.map((ship) => ship.shipName)).toEqual(['Terran']);
        expect(scope.ships[0].layers.size).toBe(19);
        expect(scope.ships[0].layers.has('roofs')).toBe(true);
        expect(scope.ships[0].layers.has('asteroid')).toBe(false);
    });

    it('scopes an asteroid part to the asteroid ship and its two layers', async () => {
        const scope = await layerScopeForPart(join(DATA_DIR, 'ships/asteroid/rock/rock_1x1.rules'), 'Part', context, token);
        expect(scope.ships.map((ship) => ship.shipName)).toEqual(['Asteroid']);
        expect([...scope.ships[0].layers].sort()).toEqual(['asteroid', 'asteroid_roof_lights_fancy']);
    });

    it('judges a layer against the part own ship, not the project pool', async () => {
        const terran = await layerScopeForPart(join(DATA_DIR, 'ships/terran/airlock/airlock.rules'), 'Part', context, token);
        expect(judgeLayer(terran, 'roofs')).toBe('accepted');
        expect(judgeLayer(terran, 'ROOFS')).toBe('accepted');
        expect(judgeLayer(terran, 'asteroid')).toBe('foreign');
        expect(judgeLayer(terran, 'definitely_not_a_layer')).toBe('unknown');
    });

    // Every ship against every layer in the project, so the verdicts are pinned as a whole rather
    // than sampled: each ship accepts exactly what it declares and calls every other layer foreign.
    it('judges every layer of every ship the same way the game would', async () => {
        const parts: Array<[string, string, string[]]> = [
            ['Terran', 'ships/terran/airlock/airlock.rules', []],
            ['Asteroid', 'ships/asteroid/rock/rock_1x1.rules', ['asteroid', 'asteroid_roof_lights_fancy']],
            ['Megaroid', 'ships/megaroid/megarock/megarock_1x1.rules', ['asteroid']],
        ];
        for (const [shipName, partPath, expectedOwn] of parts) {
            const scope = await layerScopeForPart(join(DATA_DIR, partPath), 'Part', context, token);
            expect(scope.ships.map((ship) => ship.shipName)).toEqual([shipName]);
            const own = scope.ships[0].layers;
            if (expectedOwn.length > 0) expect([...own].sort()).toEqual(expectedOwn);
            for (const layer of scope.allLayers) {
                expect(judgeLayer(scope, layer), `${shipName} judging ${layer}`).toBe(
                    own.has(layer) ? 'accepted' : 'foreign'
                );
            }
            expect(judgeLayer(scope, 'not_a_layer_anywhere')).toBe('unknown');
        }
    });

    // The base every terran part derives from is named by no `Parts` list, but the parts that derive
    // from it are, and they reach it, so it is scoped like them rather than left to the pool.
    // The reach walk reads the install's part files, which outlasts the default timeout when the
    // whole suite runs in parallel.
    it('scopes a base file through the parts that derive from it', { timeout: 60_000 }, async () => {
        const base = await layerScopeForPart(join(DATA_DIR, 'ships/terran/base_part_terran.rules'), 'Part', context, token);
        expect(base.ships.map((ship) => ship.shipName)).toEqual(['Terran']);
        expect(judgeLayer(base, 'roofs')).toBe('accepted');
        expect(judgeLayer(base, 'asteroid')).toBe('foreign');
    });

    it('falls back to the whole pool for a file nothing reaches at all', async () => {
        const orphan = await layerScopeForPart(join(DATA_DIR, 'gui/nothing_reaches_this.rules'), 'Part', context, token);
        expect(orphan.ships).toEqual([]);
        expect(judgeLayer(orphan, 'roofs')).toBe('accepted');
        expect(judgeLayer(orphan, 'asteroid')).toBe('accepted');
        expect(judgeLayer(orphan, 'definitely_not_a_layer')).toBe('unknown');
    });
});
