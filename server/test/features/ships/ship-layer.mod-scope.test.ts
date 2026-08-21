import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
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

// The two shapes a mod really uses, on a fixture rather than on an installed mod:
//  - it registers its parts and its layers by pointing the manifest at a list kept in one of its own
//    files, so those entries resolve against THAT file, not against the manifest,
//  - it keeps a copy of a game part, which no list names by path but which declares the same id.
// Both used to leave every part of the mod unscoped, which quietly turned the check into a no-op:
// the fallback pool accepts every layer in the project, so a foreign one went unreported.
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/layer-scope-mod');
const DATA_DIR = join(FIXTURE, 'Data');
const MOD_DIR = join(FIXTURE, 'mod');
const token = CancellationToken.None;

const parseFile = (abs: string) => parser(lexer(readFileSync(abs, 'utf8')), pathToFileURL(abs).href).value;

describe('a mod own ship wiring decides which layers its parts may name', () => {
    let context: ShipLayerContext;

    beforeAll(() => {
        globalSettings.cosmoteerPath = DATA_DIR;
        invalidateShipLayers();
        context = {
            gameRootDocument: parseFile(join(DATA_DIR, 'cosmoteer.rules')),
            gameRootPath: join(DATA_DIR, 'cosmoteer.rules'),
            folderPaths: [DATA_DIR, MOD_DIR],
        };
    });

    it('scopes a part the manifest registers through a list in the mod own file', async () => {
        const scope = await layerScopeForPart(
            join(MOD_DIR, 'ships/terran/own_part/own_part.rules'),
            'Part',
            context,
            token,
            'author.own_part'
        );
        expect(scope.ships.map((ship) => ship.shipName)).toEqual(['Terran']);
        // The game's two, plus the one the mod adds to that ship.
        expect([...scope.ships[0].layers].sort()).toEqual(['author.glow', 'floors', 'roofs']);
        expect(judgeLayer(scope, 'author.glow')).toBe('accepted');
        expect(judgeLayer(scope, 'asteroid')).toBe('foreign');
    });

    it('scopes a copy of a game part by the id it declares', async () => {
        const scope = await layerScopeForPart(
            join(MOD_DIR, 'ships/terran/copied/vanilla_part.rules'),
            'Part',
            context,
            token,
            'game.vanilla_part'
        );
        expect(scope.ships.map((ship) => ship.shipName)).toEqual(['Terran']);
        expect(judgeLayer(scope, 'asteroid')).toBe('foreign');
    });

    it('still falls back to the pool when the copy declares no id to go by', async () => {
        const scope = await layerScopeForPart(
            join(MOD_DIR, 'ships/terran/copied/vanilla_part.rules'),
            'Part',
            context,
            token
        );
        expect(scope.ships).toEqual([]);
        expect(judgeLayer(scope, 'asteroid')).toBe('accepted');
    });

    // A part is written across several files. The fragment holds `Layer` too, and no list names it:
    // the ship that draws it is whichever ship draws the part that pulls it in.
    it('scopes a fragment through the part that pulls it in', async () => {
        const scope = await layerScopeForPart(
            join(MOD_DIR, 'ships/terran/own_part/own_sprites.rules'),
            'Sprites',
            context,
            token
        );
        expect(scope.ships.map((ship) => ship.shipName)).toEqual(['Terran']);
        expect(judgeLayer(scope, 'author.glow')).toBe('accepted');
        expect(judgeLayer(scope, 'asteroid')).toBe('foreign');
    });

    // A fragment both ship classes reach takes both, so either one's layers are fine in it. Reporting
    // it for whichever ship was found first would be a false positive on a file that is used by both.
    it('gives a shared fragment every ship that reaches it', async () => {
        const scope = await layerScopeForPart(
            join(DATA_DIR, 'ships/shared/shared_sprites.rules'),
            'Shared',
            context,
            token
        );
        expect(scope.ships.map((ship) => ship.shipName).sort()).toEqual(['Rock', 'Terran']);
        expect(judgeLayer(scope, 'floors')).toBe('accepted');
        expect(judgeLayer(scope, 'asteroid')).toBe('accepted');
        expect(judgeLayer(scope, 'nothing_declares_this')).toBe('unknown');
    });

    it('keeps each ship own set apart', async () => {
        const scope = await layerScopeForPart(
            join(DATA_DIR, 'ships/terran/vanilla_part/vanilla_part.rules'),
            'Part',
            context,
            token,
            'game.vanilla_part'
        );
        expect(scope.ships.map((ship) => ship.shipName)).toEqual(['Terran']);
        expect(judgeLayer(scope, 'floors')).toBe('accepted');
        expect(judgeLayer(scope, 'asteroid')).toBe('foreign');
        expect(judgeLayer(scope, 'nothing_declares_this')).toBe('unknown');
    });
});
