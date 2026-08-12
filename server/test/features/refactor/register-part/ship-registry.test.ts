import { readFileSync } from 'fs';
import { join } from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { isListNode } from '../../../../src/core/ast/ast';
import {
    collectShipClasses,
    manifestsIn,
    modRootsUnder,
    partsListRegisters,
    shipEntryKey,
    shipPartsIn,
    shipPartsListOf,
} from '../../../../src/features/refactor/register-part/ship-registry';
import { clearBaseFileCache } from '../../../../src/features/refactor/shared-base/base-index';
import { parseText } from '../../../../src/utils/ast.utils';
import { FIXTURES_DIR } from '../../../helpers';

// The ship registry is read from the game's own `Ships` list plus the manifest actions that add to
// it, which is the only source that sees a mod ship at all.
const FIXTURE = join(FIXTURES_DIR, 'register-part-mod').replace(/\\/g, '/');
const DATA_DIR = `${FIXTURE}/Data`;
const GAME_ROOT = `${DATA_DIR}/cosmoteer.rules`;
const MOD_DIR = `${FIXTURE}/mod`;
const ABS_MOD_DIR = `${FIXTURE}/absmod`;
const TERRAN = `${DATA_DIR}/ships/terran/terran.rules`;

const gameRootDocument = () => parseText(readFileSync(GAME_ROOT, { encoding: 'utf-8' }), GAME_ROOT);

beforeEach(() => clearBaseFileCache());

describe('the ship registry', () => {
    it('reads one entry per reference of the game root Ships list, resolved against the data root', async () => {
        const entries = await collectShipClasses(gameRootDocument(), GAME_ROOT, [], CancellationToken.None);
        expect(entries.map((entry) => entry.groupName)).toEqual(['Terran', 'Inherited']);
        expect(entries[0].fsPath.toLowerCase()).toBe(TERRAN.toLowerCase());
        expect(entries[0].via).toBe('gameRoot');
    });

    it('passes over a Ships element that is an inline group rather than throwing on it', async () => {
        // The fixture registry ends with `{ ID = inline.ship }`, a ship with no file to point at.
        const document = gameRootDocument();
        const ships = document.elements.find((element) => isListNode(element) && element.identifier?.name === 'Ships');
        expect(isListNode(ships) && ships.elements.length).toBe(3);
        const entries = await collectShipClasses(document, GAME_ROOT, [], CancellationToken.None);
        expect(entries).toHaveLength(2);
    });

    it('finds the registry however the game root spells the member, list form or assignment', async () => {
        const assignment = parseText('Ships = [ &<ships/terran/terran.rules>/Terran ]', GAME_ROOT);
        const lowerCased = parseText('ships\n[\n\t&<ships/terran/terran.rules>/Terran\n]\n', GAME_ROOT);
        for (const document of [assignment, lowerCased]) {
            const entries = await collectShipClasses(document, GAME_ROOT, [], CancellationToken.None);
            expect(entries.map((entry) => entry.groupName)).toEqual(['Terran']);
        }
    });

    it('adds the ships a manifest action puts into the registry, resolved against the manifest', async () => {
        const entries = await collectShipClasses(undefined, undefined, [MOD_DIR], CancellationToken.None);
        expect(entries.map((entry) => entry.groupName)).toEqual(['ModShip', 'Broken']);
        expect(entries[0].fsPath.toLowerCase()).toBe(`${MOD_DIR}/ships/modship.rules`.toLowerCase());
        expect(entries[0].via).toBe('modAction');
        expect(entries[0].manifestFsPath?.toLowerCase()).toBe(`${MOD_DIR}/mod.rules`.toLowerCase());
    });

    it('recognizes the registry target however the manifest spells the path', async () => {
        // `<./Data/cosmoteer.rules>/Ships` and `<cosmoteer.rules>/Ships` name the same list.
        const entries = await collectShipClasses(undefined, undefined, [ABS_MOD_DIR], CancellationToken.None);
        expect(entries.map((entry) => entry.groupName)).toEqual(['AbsShip']);
    });

    it('reports a ship reached from both the game root and a manifest action exactly once', async () => {
        const document = parseText('Ships [ &<../mod/ships/modship.rules>/ModShip ]', GAME_ROOT);
        const entries = await collectShipClasses(document, GAME_ROOT, [MOD_DIR], CancellationToken.None);
        expect(entries.filter((entry) => entry.groupName === 'ModShip')).toHaveLength(1);
        // The game root wins the dedupe, being the first source read.
        expect(entries[0].via).toBe('gameRoot');
    });

    it('takes an empty Parts list as a real append target, not as an absent one', async () => {
        const ship = await shipPartsListOf(`${ABS_MOD_DIR}/ships/absship.rules`, 'AbsShip');
        expect(ship?.partsList).toBeDefined();
        expect(ship?.partsList?.elements).toHaveLength(0);
        expect(ship?.id).toBe('test.absship');
    });

    it('refuses a ship whose Parts list only comes from its base', async () => {
        const ship = await shipPartsListOf(`${DATA_DIR}/ships/inherited/inherited.rules`, 'Inherited');
        expect(ship?.partsList).toBeUndefined();
        expect(ship?.inherits).toBe(true);
    });

    it('spots a part already listed however the existing reference is spelled', async () => {
        const text = [
            'Terran',
            '{',
            '\tParts',
            '\t[',
            '\t\t&<CORRIDOR/Corridor.RULES>/part',
            '\t\t&<../terran/./corridor/corridor.rules>/Part',
            '\t]',
            '}',
            '',
        ].join('\n');
        const ship = shipPartsIn(text, parseText(text, TERRAN), 'Terran');
        expect(ship?.partsList).toBeDefined();
        const corridor = `${DATA_DIR}/ships/terran/corridor/corridor.rules`;
        expect(partsListRegisters(ship!.partsList!.elements, `${DATA_DIR}/ships/terran`, corridor, 'Part')).toBe(true);
        expect(
            partsListRegisters(ship!.partsList!.elements, `${DATA_DIR}/ships/terran`, corridor, 'Component')
        ).toBe(false);
    });

    it('gives two spellings of one group the same identity', () => {
        expect(shipEntryKey(`${DATA_DIR}/ships/../ships/terran/terran.rules`, 'terran')).toBe(
            shipEntryKey(TERRAN, 'Terran')
        );
    });

    it('finds every mod root below a folder, and every manifest in one', () => {
        const roots = modRootsUnder(FIXTURE).map((root) => root.toLowerCase());
        expect(roots).toContain(MOD_DIR.toLowerCase());
        expect(roots).toContain(`${FIXTURE}/twomanifest`.toLowerCase());
        // The stand-in game tree carries no manifest, so it is no mod.
        expect(roots).not.toContain(DATA_DIR.toLowerCase());
        expect(manifestsIn(`${FIXTURE}/twomanifest`).map((path) => path.split('/').pop())).toEqual([
            'mod_0.29.rules',
            'mod_0.30.rules',
        ]);
    });
});
