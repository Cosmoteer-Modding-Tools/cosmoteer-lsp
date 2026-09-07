import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CancellationToken, Connection, TextEdit, WorkDoneProgressReporter } from 'vscode-languageserver';
import { filePathToUri } from '../../../src/features/navigation/navigation-strategy';
import { partStatsIndex } from '../../../src/features/part-table/part-table.service';
import { clearBaseFileCache } from '../../../src/features/refactor/shared-base/base-index';
import { newFaction } from '../../../src/features/ships/new-faction.command';
import { NewFactionApplyResult, NewFactionHost } from '../../../src/features/ships/new-faction.types';
import { newGalaxySize } from '../../../src/features/ships/new-galaxy-size.command';
import { NewGalaxySizeApplyResult } from '../../../src/features/ships/new-galaxy-size.types';
import { newNebula } from '../../../src/features/ships/new-nebula.command';
import { NewNebulaApplyResult } from '../../../src/features/ships/new-nebula.types';
import { decodePng } from '../../../src/utils/png';
import { registerShip, RegisterShipHost } from '../../../src/features/ships/register-ship.command';
import {
    RegisterShipApplyResult,
    RegisterShipArgs,
    RegisterShipScanResult,
} from '../../../src/features/ships/register-ship.types';
import { parseModActions } from '../../../src/mod/action-parser';
import { clearModRootCache } from '../../../src/mod/mod-root';
import { globalSettings } from '../../../src/settings';
import { parseText } from '../../../src/utils/ast.utils';
import { CosmoteerWorkspaceData, CosmoteerWorkspaceService, FileWithPath } from '../../../src/workspace/cosmoteer-workspace.service';
import { clearFsCaches } from '../../../src/workspace/fs-cache';
import { FIXTURES_DIR } from '../../helpers';
import { blueprintTree, shipPngBytes } from './blueprint.helper';

// The two commands against a stand-in install laid out the way Steam lays one out, with saved ships
// written by the test so every part they name has a known price. Everything is mirrored into a
// scratch copy first, because both commands write files.
const SOURCE = join(FIXTURES_DIR, 'register-ship-mod').replace(/\\/g, '/');
const token = CancellationToken.None;

let ROOT = '';
let DATA_DIR = '';
let GAME_ROOT = '';
let MOD_DIR = '';
let SAVED = '';

const read = (path: string): string => readFileSync(path, { encoding: 'utf-8' });

/** The parsed stand-in game root, in the shape the workspace service hands the commands. */
const gameRootFile = (): FileWithPath => {
    const text = read(GAME_ROOT);
    const content: CosmoteerWorkspaceData = { name: 'cosmoteer.rules', parsedDocument: parseText(text, GAME_ROOT) };
    return { type: 'File', name: 'cosmoteer.rules', path: GAME_ROOT, content };
};

type TestHost = RegisterShipHost & NewFactionHost & { changes: Record<string, TextEdit[]>; announced: string[] };

/** A host whose client-side edits are captured rather than applied, so they can be read back. */
const makeHost = (): TestHost => ({
    changes: {},
    announced: [],
    folderPaths: async () => [MOD_DIR],
    openDocuments: () => [],
    gameRoot: async () => gameRootFile(),
    dataRoot: () => DATA_DIR,
    applyEdit(changes) {
        Object.assign(this.changes, changes);
        return Promise.resolve(true);
    },
    filesChanged(paths) {
        this.announced.push(...paths);
    },
    layerContext: async () => ({
        gameRootDocument: gameRootFile().content.parsedDocument,
        gameRootPath: GAME_ROOT,
        folderPaths: [MOD_DIR],
    }),
    partStats: (context, modRoot, cancellationToken) => partStatsIndex({ context, modRoot }, cancellationToken),
    existingIds: async () => new Set<string>(),
    localizedName: async (key) => (key === 'Factions/Orion' ? 'Orion' : undefined),
});

/** A saved ship in the folder outside the mod, naming the given parts. */
const saveShip = (name: string, parts: readonly string[], doors = 0): string => {
    const path = `${SAVED}/${name}.ship.png`;
    writeFileSync(path, shipPngBytes(blueprintTree(name, parts, doors)));
    return path;
};

/** The scan round, asserting it answered as one. */
const scan = async (blueprints: string[], host: RegisterShipHost, uri = filePathToUri(MOD_DIR)): Promise<RegisterShipScanResult> => {
    const result = await registerShip({ uri, blueprints }, host, token);
    if (result.kind !== 'scan') throw new Error('expected the scan round');
    return result;
};

/** The apply round, asserting it answered as one. */
const apply = async (args: Omit<RegisterShipArgs, 'uri'>, host: RegisterShipHost): Promise<RegisterShipApplyResult> => {
    const result = await registerShip({ uri: filePathToUri(MOD_DIR), ...args }, host, token);
    if (result.kind !== 'apply') throw new Error('expected the apply round');
    return result;
};

/** The parts of a ship, `n` of each id. */
const times = (n: number, id: string): string[] => Array.from({ length: n }, () => id);

let WARSHIP = '';
let HAULER = '';
let BUS = '';
let OUTPOST = '';
let PLATFORM = '';

beforeAll(async () => {
    ROOT = mkdtempSync(join(tmpdir(), 'registership-')).replace(/\\/g, '/');
    cpSync(SOURCE, ROOT, { recursive: true });
    DATA_DIR = `${ROOT}/steamapps/common/Cosmoteer/Data`;
    GAME_ROOT = `${DATA_DIR}/cosmoteer.rules`;
    MOD_DIR = `${ROOT}/mod`;
    SAVED = `${ROOT}/saved`;
    mkdirSync(SAVED, { recursive: true });

    WARSHIP = saveShip(
        'Warship',
        [...times(4, 'cosmoteer.laser'), ...times(4, 'cosmoteer.thruster'), ...times(2, 'cosmoteer.armor'), 'cosmoteer.crew_quarters', ...times(2, 'cosmoteer.corridor')],
        2
    );
    // The storage is named by its alias half the time, the way an older blueprint names a renamed part.
    HAULER = saveShip('Hauler', [...times(3, 'cosmoteer.storage'), ...times(3, 'crate'), ...times(4, 'cosmoteer.thruster'), 'cosmoteer.crew_quarters']);
    BUS = saveShip('Bus', [...times(6, 'cosmoteer.crew_quarters'), ...times(3, 'cosmoteer.thruster')]);
    OUTPOST = saveShip('Outpost Station', [...times(8, 'cosmoteer.storage'), 'cosmoteer.crew_quarters']);
    PLATFORM = saveShip('Small Laser Platform', [...times(2, 'cosmoteer.laser'), 'cosmoteer.thruster']);

    globalSettings.cosmoteerPath = DATA_DIR;
    const noop: WorkDoneProgressReporter = { begin: () => undefined, report: () => undefined, done: () => undefined };
    const service = CosmoteerWorkspaceService.instance;
    service.setConnection({
        languages: { diagnostics: { refresh: () => undefined } },
        window: { showWarningMessage: () => undefined },
    } as unknown as Connection);
    await service.initialize(DATA_DIR, noop);
});

afterAll(() => {
    if (ROOT) rmSync(ROOT, { recursive: true, force: true });
});

beforeEach(() => {
    clearBaseFileCache();
    clearModRootCache();
    clearFsCaches();
    globalSettings.allowEditingVanillaFiles = false;
});

describe('judging saved ships', () => {
    it('rates the tier the way the game does, over parts, doors and crew', async () => {
        const result = await scan([WARSHIP], makeHost());
        expect(result.failure).toBeUndefined();
        expect(result.modId).toBe('test.shipmod');
        expect(result.balanceFallback).toBe(false);
        const [ship] = result.ships;
        expect(ship.name).toBe('Warship');
        expect(ship.blocked).toBeUndefined();
        // Four lasers at 1000, four thrusters at 200, two armor at 150, one crew quarters at 400 and
        // two corridors at 100 make 5700 in parts, two doors at 50 add 100, and four crew at 50 add 200.
        expect(ship.value).toEqual({ parts: 5700, doors: 100, crew: 200, total: 6000, doorsUnpriced: false });
        // 6000 fits under the fixture's fourth cutoff of 8000.
        expect(ship.valueTier).toBe(4);
        expect(ship.tierByRole.combat).toBe(4);
        expect(ship.signals.weapons).toBe(4);
        expect(ship.signals.crew).toBe(4);
        expect(ship.signals.unknownParts).toEqual([]);
    });

    it('reads a part by its alias, and reports one nothing declares', async () => {
        const stray = saveShip('Stray', ['cosmoteer.corridor', 'nobody.knows', 'crate']);
        const result = await scan([stray, HAULER], makeHost());
        expect(result.ships[0].signals.unknownParts).toEqual(['nobody.knows']);
        expect(result.ships[0].signals.storage).toBe(1);
        expect(result.ships[1].signals.storage).toBe(6);
    });

    it('offers the role the parts say, with the others behind it', async () => {
        const result = await scan([WARSHIP, HAULER, BUS, OUTPOST, PLATFORM], makeHost());
        const first = Object.fromEntries(result.ships.map((ship) => [ship.name, ship.roles[0]]));
        expect(first).toEqual({
            Warship: 'combat',
            Hauler: 'trade',
            Bus: 'crew_transport',
            'Outpost Station': 'trade_station',
            'Small Laser Platform': 'defense',
        });
        for (const ship of result.ships) expect(new Set(ship.roles).size).toBe(9);
    });

    it('rates a ship that spends far more on guns than the game does as the hardest band, and says why', async () => {
        const result = await scan([WARSHIP, HAULER], makeHost());
        const warship = result.ships[0];
        expect(warship.difficulty).toBe(3);
        expect(warship.strength.weaponShare).toBeCloseTo(4000 / 6000, 3);
        expect(warship.strength.typicalWeaponShare).toBeGreaterThan(0);
        expect(result.ships[1].difficulty).toBe(1);
    });

    it('authors a station under its value tier, the way the game files do', async () => {
        const result = await scan([OUTPOST], makeHost());
        const outpost = result.ships[0];
        expect(outpost.tierByRole.trade_station).toBeLessThan(outpost.valueTier);
        expect(outpost.tierByRole.military_station).toBe(Math.max(1, outpost.valueTier - 3));
    });

    it('reads every saved ship of a folder', async () => {
        const result = await scan([SAVED], makeHost());
        expect(result.ships.map((ship) => ship.name)).toContain('Warship');
        expect(result.ships.length).toBeGreaterThanOrEqual(5);
    });

    it('lists the factions of the game, and refuses a place it may not write to', async () => {
        const result = await scan([WARSHIP], makeHost());
        expect(result.factions.map((faction) => faction.id)).toEqual(['fringe', 'cabal']);
        expect(result.factions.every((faction) => faction.source === 'game' && !faction.own)).toBe(true);

        const inGame = await registerShip({ uri: filePathToUri(`${DATA_DIR}/ships`), blueprints: [WARSHIP] }, makeHost(), token);
        expect(inGame.failure).toBe('notEditable');
        const nothing = await registerShip({ uri: filePathToUri(MOD_DIR), blueprints: [`${ROOT}/steamapps`] }, makeHost(), token);
        expect(nothing.failure).toBe('noBlueprints');
    });
});

describe('registering ships in a faction', () => {
    it('writes the role files, the aggregator, the trade route and the manifest actions', async () => {
        const host = makeHost();
        const result = await apply(
            {
                blueprints: [],
                faction: 'cabal',
                ships: [
                    { fsPath: WARSHIP, role: 'combat', tier: 4, difficulty: 3 },
                    { fsPath: HAULER, role: 'trade', tier: 4, difficulty: 1 },
                ],
            },
            host
        );
        expect(result.failure).toBeUndefined();
        expect(result.ships.map((ship) => ship.failure)).toEqual([undefined, undefined]);

        const combat = `${MOD_DIR}/builtin_ships/cabal/Combat/builtins_cabal_combat.rules`;
        const civilian = `${MOD_DIR}/builtin_ships/cabal/Civilian/builtins_cabal_civilian.rules`;
        const routes = `${MOD_DIR}/builtin_ships/cabal/Civilian/trade_ships_cabal.rules`;
        const aggregator = `${MOD_DIR}/builtin_ships/cabal/builtins_cabal.rules`;
        expect(result.ships[0].registeredIn).toBe(combat);
        expect(result.ships[1].registeredIn).toBe(civilian);
        expect(result.ships[1].tradeRouteIn).toBe(routes);
        expect(existsSync(`${MOD_DIR}/builtin_ships/cabal/Combat/Warship.ship.png`)).toBe(true);
        expect(existsSync(`${MOD_DIR}/builtin_ships/cabal/Civilian/Hauler.ship.png`)).toBe(true);

        const combatText = read(combat);
        expect(combatText).toContain('Faction = cabal');
        expect(combatText).toContain('Tags = [combat]');
        expect(combatText).toContain(':~{ File="Warship.ship.png"; Tier=4; Difficulty=3; }');
        expect(combatText).not.toContain('IDPrefix');

        const civilianText = read(civilian);
        expect(civilianText).toContain('Tags = [civilian]');
        expect(civilianText).toContain(':~{ File="Hauler.ship.png"; Tier=4; Tags : ~/Tags [trade, empty_storage]; }');

        const routesText = read(routes);
        expect(routesText).toContain(
            'cabal_hauler : <./Data/modes/career/career.rules>/BaseTradeShip { ShipID="Hauler"; Faction=cabal; TierRange=[3, 12]; StasisSpeed=60; StasisTradeTime=60; }'
        );

        const aggregatorText = read(aggregator);
        expect(aggregatorText).toContain('<Combat/builtins_cabal_combat.rules>/Ships');
        expect(aggregatorText).toContain('<Civilian/builtins_cabal_civilian.rules>/Ships');

        const actions = parseModActions(parseText(read(`${MOD_DIR}/mod.rules`), `${MOD_DIR}/mod.rules`));
        const summary = actions.map((action) => `${action.type} ${String(action.targets[0]?.valueType.value)}`);
        expect(summary).toEqual([
            'AddMany <builtin_ships/builtins.rules>/Ships',
            'AddBase <modes/career/career.rules>/TradeShips',
        ]);
        expect(read(`${MOD_DIR}/mod.rules`)).toContain('&<builtin_ships/cabal/builtins_cabal.rules>/Ships');
        expect(read(`${MOD_DIR}/mod.rules`)).toContain('BaseToAdd = &<builtin_ships/cabal/Civilian/trade_ships_cabal.rules>/TradeShips');
        expect(result.createdFiles).toContain(combat);
        expect(result.changedFiles).toContain(`${MOD_DIR}/mod.rules`);
        expect(host.announced).toContain(`${MOD_DIR}/mod.rules`);
    });

    it('registers nothing twice, and adds a second ship to the file the first one made', async () => {
        const again = await apply(
            { blueprints: [], faction: 'cabal', ships: [{ fsPath: WARSHIP, role: 'combat', tier: 4, difficulty: 3 }] },
            makeHost()
        );
        expect(again.ships[0].failure).toBe('alreadyRegistered');

        const more = await apply(
            { blueprints: [], faction: 'cabal', ships: [{ fsPath: BUS, role: 'crew_transport', tier: 3, difficulty: 1 }] },
            makeHost()
        );
        expect(more.ships[0].failure).toBeUndefined();
        const civilianText = read(`${MOD_DIR}/builtin_ships/cabal/Civilian/builtins_cabal_civilian.rules`);
        expect(civilianText).toContain('File="Hauler.ship.png"');
        expect(civilianText).toContain(':~{ File="Bus.ship.png"; Tier=3; Tags : ~/Tags [crew_transport]; }');
        expect(read(`${MOD_DIR}/builtin_ships/cabal/Civilian/trade_ships_cabal.rules`)).toContain(
            'cabal_bus : <./Data/modes/career/career.rules>/BaseTradeShip { ShipID="Bus"; Faction=cabal; TierRange=[1, 12]; StasisSpeed=60; StasisTradeTime=20; }'
        );

        const actions = parseModActions(parseText(read(`${MOD_DIR}/mod.rules`), `${MOD_DIR}/mod.rules`));
        expect(actions.length).toBe(2);
        const aggregatorText = read(`${MOD_DIR}/builtin_ships/cabal/builtins_cabal.rules`);
        expect(aggregatorText.match(/builtins_cabal_civilian/g)?.length).toBe(1);
    });

    it('prefixes a platform the way the game files do, and writes a station with its spawn tier', async () => {
        const result = await apply(
            {
                blueprints: [],
                faction: 'cabal',
                ships: [
                    { fsPath: PLATFORM, role: 'defense', tier: 2, difficulty: 2 },
                    { fsPath: OUTPOST, role: 'military_station', tier: 6, difficulty: 2 },
                ],
            },
            makeHost()
        );
        expect(result.ships.map((ship) => ship.failure)).toEqual([undefined, undefined]);
        const defense = read(`${MOD_DIR}/builtin_ships/cabal/Defense/builtins_cabal_defense.rules`);
        expect(defense).toContain('IDPrefix = "Cabal"');
        expect(defense).toContain(':~{ File="Small Laser Platform.ship.png"; Tier=2; Difficulty=2; }');
        const stations = read(`${MOD_DIR}/builtin_ships/cabal/Stations/builtins_cabal_stations.rules`);
        expect(stations).toContain(
            ':~{ File="Outpost Station.ship.png"; Tier=6; SpawnTier=4; Tags : ~/Tags [military_station, empty_storage]; StasisIcon="Outpost Station.png"; }'
        );
        const aggregatorText = read(`${MOD_DIR}/builtin_ships/cabal/builtins_cabal.rules`);
        for (const role of ['combat', 'civilian', 'defense', 'stations']) expect(aggregatorText).toContain(`builtins_cabal_${role}.rules`);
    });

    it('prefixes a platform with the name the language files give the faction, and checks the id it really gets', async () => {
        const host = makeHost();
        host.localizedName = async (key) => (key === 'Factions/Fringe' ? 'Fringe Alliance' : undefined);
        host.existingIds = async () => new Set(['Fringe Alliance Watchpost']);
        const watchpost = saveShip('Watchpost', [...times(2, 'cosmoteer.laser'), 'cosmoteer.thruster']);
        const choice = { blueprints: [], faction: 'fringe', ships: [{ fsPath: watchpost, role: 'defense' as const, tier: 2, difficulty: 2 as const }] };
        expect((await apply(choice, host)).ships[0].failure).toBe('idTaken');
        host.existingIds = async () => new Set<string>();
        const result = await apply(choice, host);
        expect(result.ships[0].failure).toBeUndefined();
        expect(read(`${MOD_DIR}/builtin_ships/fringe/Defense/builtins_fringe_defense.rules`)).toContain('IDPrefix = "Fringe Alliance"');
    });

    it('marks a ship whose name a built-in ship already has as blocked in the scan, before any faction is picked', async () => {
        const host = makeHost();
        host.existingIds = async () => new Set(['Warship']);
        const taken = saveShip('Warship', ['cosmoteer.laser', 'cosmoteer.thruster']);
        const fresh = saveShip('Warship Two', ['cosmoteer.laser', 'cosmoteer.thruster']);
        const result = await scan([taken, fresh], host);
        expect(result.ships.map((ship) => [ship.name, ship.blocked])).toEqual([
            ['Warship', 'idTaken'],
            ['Warship Two', undefined],
        ]);
    });

    it('refuses a ship whose name the game already gives a built-in ship', async () => {
        const host = makeHost();
        host.existingIds = async () => new Set(['Warship']);
        const fresh = saveShip('Warship Two', ['cosmoteer.laser', 'cosmoteer.thruster']);
        const taken = saveShip('Taken', ['cosmoteer.laser', 'cosmoteer.thruster']);
        host.existingIds = async () => new Set(['taken']);
        const result = await apply(
            {
                blueprints: [],
                faction: 'fringe',
                ships: [
                    { fsPath: taken, role: 'combat', tier: 1, difficulty: 1 },
                    { fsPath: fresh, role: 'combat', tier: 1, difficulty: 1 },
                ],
            },
            host
        );
        expect(result.ships[0].failure).toBe('idTaken');
        expect(result.ships[1].failure).toBeUndefined();
        expect(existsSync(`${MOD_DIR}/builtin_ships/fringe/Combat/Taken.ship.png`)).toBe(false);
    });

    it('registers a wreck with no faction and the Wreckage prefix, and a starter ship the career mode offers', async () => {
        const host = makeHost();
        const wreck = saveShip('Hulk', ['cosmoteer.armor', 'cosmoteer.corridor']);
        const starter = saveShip('First Light', ['cosmoteer.laser', 'cosmoteer.thruster']);
        const result = await apply(
            {
                blueprints: [],
                faction: 'fringe',
                ships: [
                    { fsPath: wreck, role: 'wreckage', tier: 1, difficulty: 1 },
                    { fsPath: starter, role: 'starter', tier: 1, difficulty: 1 },
                ],
            },
            host
        );
        expect(result.ships.map((ship) => ship.failure)).toEqual([undefined, undefined]);
        const wreckage = read(`${MOD_DIR}/builtin_ships/fringe/Wreckage/builtins_fringe_wreckage.rules`);
        expect(wreckage).not.toContain('Faction =');
        expect(wreckage).toContain('IDPrefix = "Wreckage"');
        expect(wreckage).toContain('Tags = [wreckage]');
        expect(wreckage).toContain(':~{ File="Hulk.ship.png"; }');
        const starters = read(`${MOD_DIR}/builtin_ships/fringe/Starter/builtins_fringe_starter.rules`);
        expect(starters).not.toContain('Faction =');
        expect(starters).toContain(':~{ File="First Light.ship.png"; }');
        expect(result.ships[1].starterDescriptionKey).toBe('StarterShips/FirstLight');
        const manifest = read(`${MOD_DIR}/mod.rules`);
        expect(manifest).toContain('AddTo = "<modes/career/career.rules>/StarterShips"');
        expect(manifest).toContain('{ Ship = "builtin_ships/fringe/Starter/First Light.ship.png"; DescriptionKey = "StarterShips/FirstLight" }');
        expect(read(`${MOD_DIR}/strings/en.rules`)).toContain('FirstLight = "First Light"');
        const again = await apply(
            { blueprints: [], faction: 'fringe', ships: [{ fsPath: starter, role: 'starter', tier: 1, difficulty: 1 }] },
            host
        );
        expect(again.ships[0].failure).toBe('alreadyRegistered');
        expect(read(`${MOD_DIR}/mod.rules`).split('StarterShips/FirstLight').length).toBe(2);
    });

    it('registers a storage pod under Misc with its own tags and no faction, the way the game files do', async () => {
        const host = makeHost();
        const pod = saveShip('Small Crate Pod', ['cosmoteer.storage']);
        const result = await apply(
            { blueprints: [], faction: 'fringe', ships: [{ fsPath: pod, role: 'storage_pod', tier: 1, difficulty: 1 }] },
            host
        );
        expect(result.ships[0].failure).toBeUndefined();
        const misc = read(`${MOD_DIR}/builtin_ships/fringe/Misc/builtins_fringe_misc.rules`);
        expect(misc).not.toContain('Faction =');
        expect(misc).not.toContain('Tags = [');
        expect(misc).toContain(':~{ File="Small Crate Pod.ship.png"; Tags=[storage_pod]; }');
    });

    it('draws a stasis icon beside a station and names it in the entry', async () => {
        const host = makeHost();
        const station = saveShip('Waystation', ['cosmoteer.storage', 'cosmoteer.corridor', 'cosmoteer.armor']);
        const result = await apply(
            { blueprints: [], faction: 'fringe', ships: [{ fsPath: station, role: 'trade_station', tier: 3, difficulty: 1 }] },
            host
        );
        expect(result.ships[0].failure).toBeUndefined();
        expect(result.ships[0].stasisIcon).toBe(`${MOD_DIR}/builtin_ships/fringe/Stations/Waystation.png`);
        const entry = read(`${MOD_DIR}/builtin_ships/fringe/Stations/builtins_fringe_stations.rules`);
        expect(entry).toContain('StasisIcon="Waystation.png"');
        const icon = decodePng(readFileSync(`${MOD_DIR}/builtin_ships/fringe/Stations/Waystation.png`));
        expect(icon?.width).toBe(208);
        expect(icon?.height).toBe(208);
    });

    it('names a ship after its file, the way the game does, and refuses the taken one before touching the mod', async () => {
        const host = makeHost();
        host.existingIds = async () => new Set(['skiff mk2']);
        const path = `${SAVED}/Skiff Mk2.ship.png`;
        writeFileSync(path, shipPngBytes(blueprintTree('A Name Saved Inside', ['cosmoteer.laser', 'cosmoteer.thruster'])));
        const result = await apply(
            { blueprints: [], faction: 'fringe', ships: [{ fsPath: path, role: 'combat', tier: 1, difficulty: 1 }] },
            host
        );
        expect(result.ships[0].failure).toBe('idTaken');
        expect(existsSync(`${MOD_DIR}/builtin_ships/fringe/Combat/Skiff Mk2.ship.png`)).toBe(false);
        expect(result.createdFiles).toEqual([]);
        expect(result.changedFiles).toEqual([]);
    });

    it('references a ship already inside the mod where it is rather than copying it', async () => {
        const inside = `${MOD_DIR}/my_ships`;
        mkdirSync(inside, { recursive: true });
        const path = `${inside}/Insider.ship.png`;
        writeFileSync(path, shipPngBytes(blueprintTree('Insider', ['cosmoteer.laser', 'cosmoteer.thruster'])));
        const scanned = await scan([path], makeHost());
        expect(scanned.ships[0].insideMod).toBe(true);
        const result = await apply(
            { blueprints: [], faction: 'fringe', ships: [{ fsPath: path, role: 'combat', tier: 1, difficulty: 1 }] },
            makeHost()
        );
        expect(result.ships[0].failure).toBeUndefined();
        expect(result.ships[0].shipFile).toBe(path);
        expect(existsSync(`${MOD_DIR}/builtin_ships/fringe/Combat/Insider.ship.png`)).toBe(false);
        expect(read(`${MOD_DIR}/builtin_ships/fringe/Combat/builtins_fringe_combat.rules`)).toContain(
            'File="../../../my_ships/Insider.ship.png"'
        );
    });

    // The game reads StasisIcon from the role file, the same way it reads File, so an icon drawn
    // beside a ship that stays where it is has to be named with the same walk up.
    it('names the stasis icon of a station left in place by the same relative path as the ship', async () => {
        const inside = `${MOD_DIR}/my_ships`;
        mkdirSync(inside, { recursive: true });
        const path = `${inside}/Outpost.ship.png`;
        writeFileSync(path, shipPngBytes(blueprintTree('Outpost', ['cosmoteer.storage', 'cosmoteer.corridor', 'cosmoteer.armor'])));
        const result = await apply(
            { blueprints: [], faction: 'fringe', ships: [{ fsPath: path, role: 'trade_station', tier: 3, difficulty: 1 }] },
            makeHost()
        );
        expect(result.ships[0].failure).toBeUndefined();
        expect(result.ships[0].stasisIcon).toBe(`${inside}/Outpost.png`);
        expect(existsSync(`${inside}/Outpost.png`)).toBe(true);
        expect(existsSync(`${MOD_DIR}/builtin_ships/fringe/Stations/Outpost.png`)).toBe(false);
        const entry = read(`${MOD_DIR}/builtin_ships/fringe/Stations/builtins_fringe_stations.rules`);
        expect(entry).toContain('File="../../../my_ships/Outpost.ship.png"');
        expect(entry).toContain('StasisIcon="../../../my_ships/Outpost.png"');
    });
});

describe('creating a faction', () => {
    it('reports what is taken and offers the first free index block', async () => {
        const result = await newFaction({ uri: filePathToUri(MOD_DIR) }, makeHost(), token);
        if (result.kind !== 'scan') throw new Error('expected the scan round');
        expect(result.failure).toBeUndefined();
        expect(result.takenIds).toEqual(['fringe', 'cabal']);
        expect(result.takenPlayerIndexes).toEqual([200, 201, 400, 401]);
        expect(result.suggestedPlayerIndex).toBe(1000);
    });

    it('writes the faction, its galaxy entries, its beacon, its name and the manifest actions', async () => {
        const host = makeHost();
        const result = (await newFaction(
            { uri: filePathToUri(MOD_DIR), id: 'nova_union', name: 'Nova Union', color: [10, 20, 30] },
            host,
            token
        )) as NewFactionApplyResult;
        expect(result.failure).toBeUndefined();
        expect(result.militaryPlayerIndex).toBe(1000);
        expect(result.civilianPlayerIndex).toBe(1001);
        expect(result.nameKey).toBe('Factions/NovaUnion');

        const faction = read(result.factionFile);
        expect(faction).toContain('ID = nova_union');
        expect(faction).toContain('NameKey = "Factions/NovaUnion"');
        expect(faction).toContain('BorderColor = [10, 20, 30]');
        expect(faction).toContain('MilitaryPlayerIndex = 1000');

        // The fixture galaxy tops out at 12 with a spread of 3, so the ranges follow those figures.
        const galaxy = read(result.galaxyFile);
        expect(galaxy).toContain('FactionID = nova_union');
        expect(galaxy).toContain('TierRangeLow = [1, 9]');
        expect(galaxy).toContain('TierRangeHigh = [4, 12]');
        expect(galaxy).toContain('{ Type=test.ftl_beacon_nova_union; Faction=nova_union; }');
        expect(read(result.beaconFile)).toContain('ID = test.ftl_beacon_nova_union');

        expect(result.wiring).toEqual({ registry: 'written', territory: 'written', tiers: 'written', beacon: 'written', beaconSpawner: 'written', lore: 'skipped' });
        const manifestEdit = host.changes[filePathToUri(`${MOD_DIR}/mod.rules`)];
        expect(manifestEdit).toHaveLength(1);
        const written = manifestEdit[0].newText;
        expect(written).toContain('AddTo = "<factions/factions.rules>/Factions"');
        expect(written).toContain('ManyToAdd = &<factions/nova_union/faction_nova_union.rules>/Factions');
        expect(written).toContain('AddTo = "<galaxy_map/map_generators/base_galaxy.rules>/Factions/Factions"');
        expect(written).toContain('ManyToAdd = &<factions/nova_union/galaxy_nova_union.rules>/Territory');
        expect(written).toContain('AddTo = "<galaxy_map/map_generators/base_galaxy.rules>/FactionTiers/Factions"');
        expect(written).toContain('ManyToAdd = &<factions/nova_union/galaxy_nova_union.rules>/Tiers');
        expect(written).toContain('AddTo = "<doodads/doodads.rules>/Doodads"');
        expect(written).toContain('ManyToAdd [ &<factions/nova_union/ftl_beacon_nova_union.rules> ]');
        expect(written).toContain('AddTo = "<modes/career/sectors/sysgen_ftl_beacons.rules>/SubSpawners/0/DoodadTypes"');
        expect(written).toContain('ManyToAdd = &<factions/nova_union/galaxy_nova_union.rules>/Beacons');

        expect(result.localizationFiles.map((file) => file.split('/').pop())).toEqual(['de.rules', 'en.rules']);
        expect(read(`${MOD_DIR}/strings/en.rules`)).toContain('NovaUnion = "Nova Union"');
    });

    it('falls back to the default border colour when the client sends a colour that is not three channels', async () => {
        const result = (await newFaction(
            { uri: filePathToUri(MOD_DIR), id: 'garbled', name: 'Garbled', color: [1, 999, 'x'] as unknown as [number, number, number] },
            makeHost(),
            token
        )) as NewFactionApplyResult;
        expect(result.failure).toBeUndefined();
        expect(read(result.factionFile)).toContain('BorderColor = [143, 48, 220]');
    });

    it('copies a picked icon and beacon ship in and writes a lore page with its keys', async () => {
        const icon = `${SAVED}/emblem.png`;
        writeFileSync(icon, shipPngBytes(Buffer.from([0])));
        const beacon = saveShip('Lighthouse', ['cosmoteer.armor']);
        const host = makeHost();
        const result = (await newFaction(
            { uri: filePathToUri(MOD_DIR), id: 'red_hand', name: 'Red Hand', icon, beaconShip: beacon, lore: true },
            host,
            token
        )) as NewFactionApplyResult;
        expect(result.failure).toBeUndefined();
        expect(result.iconFile).toBe(`${MOD_DIR}/factions/red_hand/red_hand.png`);
        expect(result.beaconShipFile).toBe(`${MOD_DIR}/factions/red_hand/ftl_beacon_red_hand.ship.png`);
        expect(existsSync(result.iconFile as string)).toBe(true);
        expect(existsSync(result.beaconShipFile as string)).toBe(true);
        expect(result.placeholderAssets).toEqual([]);
        expect(read(result.factionFile)).toContain('File = "red_hand.png"');
        expect(read(result.beaconFile)).toContain('Ship = "ftl_beacon_red_hand.ship.png"');
        expect(result.loreFile).toBe(`${MOD_DIR}/factions/red_hand/lore_red_hand.rules`);
        const lore = read(result.loreFile as string);
        expect(lore).toContain('ID = red_hand');
        expect(lore).toContain('TitleKey = "Lore/RedHand/Title"');
        expect(lore).toContain('TabNameKey = "Codex/Lore"');
        expect(lore).toContain('File = "red_hand.png"');
        expect(lore).toContain('{ TextKey = "Lore/RedHand/Lore3" }');
        expect(result.loreKeys).toEqual(['Lore/RedHand/Title', 'Lore/RedHand/Lore1', 'Lore/RedHand/Lore2', 'Lore/RedHand/Lore3']);
        expect(result.wiring.lore).toBe('written');
        const manifest = host.changes[filePathToUri(`${MOD_DIR}/mod.rules`)][0].newText;
        expect(manifest).toContain('AddTo = "<codex/lore/lore.rules>/CodexPages"');
        expect(manifest).toContain('ManyToAdd [ &<factions/red_hand/lore_red_hand.rules> ]');
        const strings = read(`${MOD_DIR}/strings/en.rules`);
        expect(strings).toContain('Title = "Red Hand"');
        expect(strings).toContain('Lore2 = "Write this part of the story here."');
    });

    it('leaves the lore page out and the wiring skipped when none was asked for', async () => {
        const result = (await newFaction({ uri: filePathToUri(MOD_DIR), id: 'quiet', name: 'Quiet' }, makeHost(), token)) as NewFactionApplyResult;
        expect(result.failure).toBeUndefined();
        expect(result.loreFile).toBeUndefined();
        expect(result.wiring.lore).toBe('skipped');
        expect(result.placeholderAssets).toHaveLength(2);
    });

    it('refuses an id the game already uses, and one that is not a bare word', async () => {
        const taken = await newFaction({ uri: filePathToUri(MOD_DIR), id: 'Cabal', name: 'x' }, makeHost(), token);
        expect(taken.failure).toBe('idTaken');
        const odd = await newFaction({ uri: filePathToUri(MOD_DIR), id: 'my faction', name: 'x' }, makeHost(), token);
        expect(odd.failure).toBe('invalidId');
    });

    it('lets ships join the new faction once its manifest action is in place', async () => {
        // The faction command hands its manifest edit to the editor, which the test host only records,
        // so the recorded text is written the way an editor would have.
        const host = makeHost();
        const manifestUri = filePathToUri(`${MOD_DIR}/mod.rules`);
        const before = read(`${MOD_DIR}/mod.rules`);
        expect(host.changes[manifestUri]).toBeUndefined();
        const earlier = makeHost();
        await newFaction({ uri: filePathToUri(MOD_DIR), id: 'orion', name: 'Orion' }, earlier, token);
        const edit = earlier.changes[manifestUri][0];
        const lines = before.split('\n');
        const offset = lines.slice(0, edit.range.start.line).join('\n').length + (edit.range.start.line > 0 ? 1 : 0) + edit.range.start.character;
        writeFileSync(`${MOD_DIR}/mod.rules`, before.slice(0, offset) + edit.newText + before.slice(offset));
        clearBaseFileCache();
        clearFsCaches();

        const scanned = await scan([WARSHIP], host);
        const orion = scanned.factions.find((faction) => faction.id === 'orion');
        expect(orion).toEqual({ id: 'orion', name: 'Orion', source: 'mod', own: true });
        expect(scanned.factions[0].id).toBe('orion');
    });
});

describe('creating a nebula', () => {
    it('offers the game\'s own nebulas with their colours and reports their ids as taken', async () => {
        const result = await newNebula({ uri: filePathToUri(MOD_DIR) }, makeHost(), token);
        if (result.kind !== 'scan') throw new Error('expected the scan round');
        expect(result.failure).toBeUndefined();
        expect(result.modId).toBe('test.shipmod');
        expect(result.bases).toEqual([{ id: 'cloudy', colors: [[98, 150, 214], [160, 233, 209], [216, 140, 155]] }]);
        expect(result.takenIds).toEqual(['cloudy']);
    });

    it('writes the derived nebula, its spawner, its doodad, its texts and the manifest actions', async () => {
        const host = makeHost();
        const result = (await newNebula(
            {
                uri: filePathToUri(MOD_DIR),
                id: 'violet_haze',
                name: 'Violet Haze',
                base: 'cloudy',
                colors: [[1, 2, 3], [4, 5, 6], [7, 8, 9]],
                radius: 50000,
                count: [1, 3],
            },
            host,
            token
        )) as NewNebulaApplyResult;
        expect(result.failure).toBeUndefined();
        expect(result.nebulaFile).toBe(`${MOD_DIR}/nebulas/violet_haze/nebula_violet_haze.rules`);
        expect(result.spawnerFile).toBe(`${MOD_DIR}/nebulas/violet_haze/spawner_violet_haze.rules`);
        expect(result.doodadFile).toBe(`${MOD_DIR}/nebulas/violet_haze/doodad_nebula_violet_haze.rules`);

        // The base is inherited whole rather than copied, so its textures keep resolving beside it,
        // and every material carrying a colour is overridden, the derived one included.
        const nebula = read(result.nebulaFile);
        expect(nebula).toContain('Nebula : <./Data/nebulas/cloudy/nebula_cloudy.rules>');
        expect(nebula).toContain('\tID = violet_haze');
        expect(nebula).toContain('ToolTipKey = "Nebulas/VioletHaze"');
        expect(nebula).toContain('HudTextKey = "Nebulas/VioletHazeHudFmt"');
        const colours = '_color1 = [1, 2, 3, 255]; _color2 = [4, 5, 6, 255]; _color3 = [7, 8, 9, 255];';
        expect(nebula).toContain(`\tMaterialLow { ${colours} }`);
        expect(nebula).toContain(`\tSimpleMaterialLow { ${colours} }`);
        expect(nebula).toContain(`\tMaterialHigh { ${colours} }`);
        expect(nebula).not.toContain('MaterialMinimap');
        expect(nebula).not.toContain('HudIcon');

        const spawner = read(result.spawnerFile);
        expect(spawner).toContain('Conditions { IsInitNode=false }');
        expect(spawner).toContain('Type = Nebula');
        expect(spawner).not.toContain('SpawnChance');
        expect(spawner).toContain('Count = [1, 3]');
        expect(spawner).toContain('Distance = [10000, 25000]');
        expect(spawner).toContain('NebulaType = violet_haze');
        expect(spawner).toContain('NebulaRadius = 50000');
        expect(spawner).toContain('MaxDistanceFromWorldOrigin = &<./Data/modes/career/career.rules>/Exploration/UnexploredRadius');

        const doodad = read(result.doodadFile);
        expect(doodad).toContain('ID = test.nebula_violet_haze');
        expect(doodad).toContain('Type = Nebula');
        expect(doodad).toContain('NebulaID = violet_haze');
        expect(doodad).toContain('DescriptionKey = "Nebulas/VioletHaze"');
        expect(doodad).toContain('CategoryKey = "Doodads/Nebulas"');
        expect(doodad).toContain('File = "./Data/doodads/nebulas/nebula_cloudy.png"');

        expect(result.wiring).toEqual({ registry: 'written', spawner: 'written', doodad: 'written' });
        const manifestEdit = host.changes[filePathToUri(`${MOD_DIR}/mod.rules`)];
        expect(manifestEdit).toHaveLength(1);
        const written = manifestEdit[0].newText;
        expect(written).toContain('AddTo = "<nebulas/nebulas.rules>/NebulaTypes"');
        expect(written).toContain('ManyToAdd [ &<nebulas/violet_haze/nebula_violet_haze.rules>/Nebula ]');
        expect(written).toContain('AddTo = "<modes/career/sectors/sysgen_standard_nebulas.rules>/SubSpawners"');
        expect(written).toContain('ManyToAdd = &<nebulas/violet_haze/spawner_violet_haze.rules>/SubSpawners');
        expect(written).toContain('AddTo = "<doodads/doodads.rules>/Doodads"');
        expect(written).toContain('ManyToAdd [ &<nebulas/violet_haze/doodad_nebula_violet_haze.rules> ]');

        expect(result.localizationKeys).toEqual(['Nebulas/VioletHaze', 'Nebulas/VioletHazeHudFmt']);
        expect(result.localizationFiles.map((file) => file.split('/').pop())).toEqual(['de.rules', 'en.rules']);
        const strings = read(`${MOD_DIR}/strings/en.rules`);
        expect(strings).toContain('VioletHaze = "<b>Violet Haze</b>\\nDescribe what ships meet inside it."');
        expect(strings).toContain('VioletHazeHudFmt = "<s14>{0:0.}%</s14>\\n<s12><gray>violet haze</gray></s12>"');
    });

    it('falls back to the base\'s colours and writes the spawner figures the client chose', async () => {
        const result = (await newNebula(
            {
                uri: filePathToUri(MOD_DIR),
                id: 'dim',
                name: 'Dim',
                colors: [[1, 999, 'x'], [4, 5, 6], [7, 8]] as unknown as [[number, number, number], [number, number, number], [number, number, number]],
                spawnChance: 40,
                avoidStartingSector: false,
            },
            makeHost(),
            token
        )) as NewNebulaApplyResult;
        expect(result.failure).toBeUndefined();
        expect(read(result.nebulaFile)).toContain('MaterialLow { _color1 = [98, 150, 214, 255]; _color2 = [4, 5, 6, 255]; _color3 = [216, 140, 155, 255]; }');
        const spawner = read(result.spawnerFile);
        expect(spawner).toContain('SpawnChance = 40%');
        expect(spawner).not.toContain('IsInitNode');
        expect(spawner).toContain('NebulaRadius = 100000');
        expect(spawner).toContain('Count = [0, 2]');
    });

    it('refuses a folder already written, an id the game uses, and one that is not a bare word', async () => {
        const again = await newNebula({ uri: filePathToUri(MOD_DIR), id: 'violet_haze', name: 'x' }, makeHost(), token);
        expect(again.failure).toBe('pathTaken');
        const taken = await newNebula({ uri: filePathToUri(MOD_DIR), id: 'Cloudy', name: 'x' }, makeHost(), token);
        expect(taken.failure).toBe('idTaken');
        const odd = await newNebula({ uri: filePathToUri(MOD_DIR), id: 'my nebula', name: 'x' }, makeHost(), token);
        expect(odd.failure).toBe('invalidId');
    });
});

describe('creating a galaxy size', () => {
    it('reports the standard galaxy\'s system count and the size names in use', async () => {
        const result = await newGalaxySize({ uri: filePathToUri(MOD_DIR) }, makeHost(), token);
        if (result.kind !== 'scan') throw new Error('expected the scan round');
        expect(result.failure).toBeUndefined();
        expect(result.modId).toBe('test.shipmod');
        expect(result.standardSystems).toBe(75);
        expect(result.takenIds).toEqual(['none', 'standard']);
    });

    it('writes the cloned generator, the size entry, its texts and both manifest actions', async () => {
        const host = makeHost();
        const result = (await newGalaxySize({ uri: filePathToUri(MOD_DIR), id: 'huge', name: 'Huge', systems: 150 }, host, token)) as NewGalaxySizeApplyResult;
        expect(result.failure).toBeUndefined();
        expect(result.file).toBe(`${MOD_DIR}/galaxy_map/huge/galaxy_huge.rules`);

        // The standard generator's references are relative to its own folder, so the clone
        // re-expresses each against the install.
        const file = read(result.file);
        expect(file).toContain('\t\t: <./Data/galaxy_map/map_generators/base_galaxy.rules>/MapNodes');
        expect(file).toContain('\t\t\tCount = 150');
        expect(file).not.toContain('Count = 75');
        expect(file).toContain('\t\t&<./Data/galaxy_map/map_generators/base_galaxy.rules>/Factions');
        expect(file).toContain('\t\t&<./Data/galaxy_map/map_generators/base_galaxy.rules>/FactionTiers');
        expect(file).toContain('NameKey = "MapSizes/Huge"');
        expect(file).toContain('TipKey = "MapSizes/HugeTip"');
        expect(file).toContain('MapGenerator = &~/Generator');

        expect(result.wiring).toEqual({ career: 'written', creative: 'written' });
        const manifestEdit = host.changes[filePathToUri(`${MOD_DIR}/mod.rules`)];
        expect(manifestEdit).toHaveLength(1);
        const written = manifestEdit[0].newText;
        expect(written).toContain('AddTo = "<modes/career/career.rules>/MapSizes"');
        expect(written).toContain('AddTo = "<modes/creative/creative.rules>/MapSizes"');
        expect(written.split('ManyToAdd [ &<galaxy_map/huge/galaxy_huge.rules>/Size ]')).toHaveLength(3);

        expect(result.localizationKeys).toEqual(['MapSizes/Huge', 'MapSizes/HugeTip']);
        const strings = read(`${MOD_DIR}/strings/en.rules`);
        expect(strings).toContain('Huge = "Huge"');
        expect(strings).toContain('HugeTip = "150 solar systems."');
    });

    it('lists the size it wrote as taken, and refuses its folder, a game size and an odd id', async () => {
        const scanned = await newGalaxySize({ uri: filePathToUri(MOD_DIR) }, makeHost(), token);
        if (scanned.kind !== 'scan') throw new Error('expected the scan round');
        expect(scanned.takenIds).toContain('huge');
        const again = await newGalaxySize({ uri: filePathToUri(MOD_DIR), id: 'Huge', name: 'x' }, makeHost(), token);
        expect(again.failure).toBe('pathTaken');
        const taken = await newGalaxySize({ uri: filePathToUri(MOD_DIR), id: 'standard', name: 'x' }, makeHost(), token);
        expect(taken.failure).toBe('idTaken');
        const odd = await newGalaxySize({ uri: filePathToUri(MOD_DIR), id: 'my size', name: 'x' }, makeHost(), token);
        expect(odd.failure).toBe('invalidId');
        const wide = (await newGalaxySize({ uri: filePathToUri(MOD_DIR), id: 'vast', name: 'Vast', systems: 5000 }, makeHost(), token)) as NewGalaxySizeApplyResult;
        expect(wide.failure).toBeUndefined();
        expect(read(wide.file)).toContain('Count = 150');
    });
});
