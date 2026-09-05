import { createHash } from 'crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CancellationToken, Connection, TextEdit, WorkDoneProgressReporter } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { filePathToUri } from '../../../src/features/navigation/navigation-strategy';
import { uriToFsPath } from '../../../src/features/navigation/workspace-files';
import { clearBaseFileCache } from '../../../src/features/refactor/shared-base/base-index';
import { newAsteroidType } from '../../../src/features/ships/new-asteroid-type.command';
import {
    NewAsteroidTypeApplyResult,
    NewAsteroidTypeHost,
    NewAsteroidTypeScanResult,
} from '../../../src/features/ships/new-asteroid-type.types';
import { clearModRootCache } from '../../../src/mod/mod-root';
import { globalSettings } from '../../../src/settings';
import { parseText } from '../../../src/utils/ast.utils';
import {
    CosmoteerWorkspaceData,
    CosmoteerWorkspaceService,
    FileWithPath,
} from '../../../src/workspace/cosmoteer-workspace.service';
import { clearFsCaches } from '../../../src/workspace/fs-cache';
import { FIXTURES_DIR } from '../../helpers';

// The command against the stand-in install the ship commands share, mirrored into a scratch copy
// first because the command writes files. The manifest edits the host is handed are applied to disk
// so a later run reads the manifest the way the editor would have saved it.
const SOURCE = join(FIXTURES_DIR, 'register-ship-mod').replace(/\\/g, '/');
const token = CancellationToken.None;

let ROOT = '';
let DATA_DIR = '';
let GAME_ROOT = '';
let MOD_DIR = '';

const read = (path: string): string => readFileSync(path, { encoding: 'utf-8' });

/** The parsed stand-in game root, in the shape the workspace service hands the commands. */
const gameRootFile = (): FileWithPath => {
    const text = read(GAME_ROOT);
    const content: CosmoteerWorkspaceData = { name: 'cosmoteer.rules', parsedDocument: parseText(text, GAME_ROOT) };
    return { type: 'File', name: 'cosmoteer.rules', path: GAME_ROOT, content };
};

type TestHost = NewAsteroidTypeHost & { changes: Record<string, TextEdit[]>; announced: string[] };

/** The ids the workspace mods are said to declare, one of each class the command asks about. */
const DECLARED: Record<string, string[]> = {
    'Cosmoteer.Simulation.Doodads.DoodadRules': ['test.asteroid_dust_m', 'other.asteroid_dust_s'],
    'Cosmoteer.Ships.Parts.PartRules': ['test.deposit_ore_2x_hard', 'cosmoteer.laser'],
    'Cosmoteer.Resources.ResourceRules': ['modium', 'steel'],
};

/** A host whose edits are written to disk and kept, so they can be read back either way. */
const makeHost = (): TestHost => ({
    changes: {},
    announced: [],
    folderPaths: async () => [MOD_DIR],
    openDocuments: () => [],
    gameRoot: async () => gameRootFile(),
    dataRoot: () => DATA_DIR,
    applyEdit(changes) {
        Object.assign(this.changes, changes);
        for (const [uri, edits] of Object.entries(changes)) {
            const fsPath = uriToFsPath(uri);
            const document = TextDocument.create(uri, 'rules', 0, read(fsPath));
            writeFileSync(fsPath, TextDocument.applyEdits(document, edits));
        }
        return Promise.resolve(true);
    },
    filesChanged(paths) {
        this.announced.push(...paths);
    },
    existingIds: async (cls) => new Set(DECLARED[cls] ?? []),
    localizedName: async (key) => (key === 'Resource/Iron' ? 'Iron' : undefined),
});

/** The scan round, asserting it answered as one. */
const scan = async (host: TestHost = makeHost(), uri = filePathToUri(MOD_DIR)): Promise<NewAsteroidTypeScanResult> => {
    const result = await newAsteroidType({ uri }, host, token);
    if (result.kind !== 'scan') throw new Error('expected the scan round');
    return result;
};

/** The apply round, asserting it answered as one. */
const apply = async (
    args: Omit<Parameters<typeof newAsteroidType>[0], 'uri'>,
    host: TestHost = makeHost(),
    uri = filePathToUri(MOD_DIR)
): Promise<NewAsteroidTypeApplyResult> => {
    const result = await newAsteroidType({ uri, id: 'x', ...args }, host, token);
    if (result.kind !== 'apply') throw new Error('expected the apply round');
    return result;
};

/** A digest of every file under a folder, so a refusal can be shown to have written nothing. */
const digestOf = (folder: string): string => {
    const hash = createHash('sha256');
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) walk(path);
            else hash.update(path.slice(folder.length)).update(readFileSync(path));
        }
    };
    walk(folder);
    return hash.digest('hex');
};

/** Every parse error a written file would give the game. */
const parseErrorsOf = (path: string): unknown[] => parser(lexer(read(path)), filePathToUri(path)).parserErrors;

const manifest = (): string => read(`${MOD_DIR}/mod.rules`);

beforeAll(async () => {
    ROOT = mkdtempSync(join(tmpdir(), 'asteroidtype-')).replace(/\\/g, '/');
    cpSync(SOURCE, ROOT, { recursive: true });
    DATA_DIR = `${ROOT}/steamapps/common/Cosmoteer/Data`;
    GAME_ROOT = `${DATA_DIR}/cosmoteer.rules`;
    MOD_DIR = `${ROOT}/mod`;

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

describe('scanning for an asteroid type', () => {
    it('lists the resources with their names, the looks and the type ids already in use under the author prefix', async () => {
        const result = await scan();
        expect(result.failure).toBeUndefined();
        expect(result.modId).toBe('test.shipmod');
        expect(result.authorPrefix).toBe('test');
        // The game's own resources come first in registry order, named where a language file names
        // them, and the ones the workspace mods declare follow.
        expect(result.resources).toEqual(
            expect.arrayContaining([{ id: 'steel' }, { id: 'iron', name: 'Iron' }, { id: 'modium' }])
        );
        expect(result.resources.findIndex((resource) => resource.id === 'iron')).toBeLessThan(
            result.resources.findIndex((resource) => resource.id === 'modium')
        );
        expect(result.looks).toEqual([{ id: 'iron', label: 'Iron' }]);
        expect(result.takenIds).toEqual(['dust', 'ore']);
    });

    it('refuses the install and a folder outside any mod', async () => {
        const inGame = await newAsteroidType({ uri: filePathToUri(`${DATA_DIR}/ships`) }, makeHost(), token);
        expect(inGame.failure).toBe('notEditable');
        const nowhere = await newAsteroidType({ uri: filePathToUri(`${ROOT}/steamapps`) }, makeHost(), token);
        expect(nowhere.failure).toBe('noModRoot');
    });
});

describe('creating an asteroid type', () => {
    it('writes the tiles, the lists, the recipes, the texts and the four manifest actions', async () => {
        const host = makeHost();
        const result = await apply(
            {
                id: 'glow_ore',
                name: 'Glow Ore',
                resource: 'iron',
                look: 'iron',
                rarity: 'common',
                weight: 1,
                hard: true,
            },
            host
        );
        expect(result.failure).toBeUndefined();
        const folder = `${MOD_DIR}/asteroids/glow_ore`;
        expect(result.folder).toBe(folder);
        expect(result.files.map((file) => file.slice(folder.length + 1))).toEqual([
            'deposit_glow_ore_1x.rules',
            'deposit_glow_ore_1x_hard.rules',
            'deposit_glow_ore_2x.rules',
            'deposit_glow_ore_2x_hard.rules',
            'deposit_glow_ore_3x.rules',
            'deposit_glow_ore_3x_hard.rules',
            'parts_glow_ore.rules',
            'conversions_glow_ore.rules',
            'doodad_asteroid_glow_ore_s.rules',
            'doodad_asteroid_glow_ore_m.rules',
            'doodad_asteroid_glow_ore_l.rules',
            'doodad_asteroid_glow_ore_xl.rules',
            'doodad_asteroid_glow_ore_xxl.rules',
            'types_glow_ore.rules',
        ]);
        for (const file of result.files) expect(parseErrorsOf(file), file).toEqual([]);

        // The soft tile derives from the game's own base and borrows the iron textures, each one
        // re-expressed against the install, read off the game's own file rather than assumed.
        const soft = read(`${folder}/deposit_glow_ore_1x.rules`);
        expect(soft).toContain('Part : <./Data/ships/asteroid/base_small_part_asteroid.rules>/Part');
        expect(soft).toContain('NameKey = "Parts/GlowOreDeposit1x"');
        expect(soft).toContain('IconNameKey = "Parts/GlowOreDeposit1xIcon"');
        expect(soft).toContain('DescriptionKey = "Resource/IronDesc"');
        expect(soft).toContain('ID = test.deposit_glow_ore_1x');
        expect(soft).toContain('SelectionTypeID = "deposit_glow_ore"');
        // The toolbar group is the look's own, since the game has no group for a mod resource and a
        // group it does not know throws in the build toolbox.
        expect(soft).toContain('EditorGroup = "Iron"');
        expect(soft).toContain('\t\t[iron, 1]');
        expect(soft).toContain('Texture = "./Data/ships/asteroid/deposit_iron/deposit_iron_1x_icon.png"');
        expect(soft).toContain('File = "./Data/ships/asteroid/deposit_iron/deposit_iron_1x.png"');
        expect(soft).toContain('NormalsFile = "./Data/ships/asteroid/deposit_iron/deposit_iron_1x_normals_66.png"');
        expect(soft).toContain('File = "./Data/ships/asteroid/deposit_iron/deposit_iron_1x_blueprints.png"');
        expect(soft).toContain('Icon : <./Data/resources/iron/iron.rules>/Overlay');
        expect(soft).not.toContain('MaxHealth');

        const hard = read(`${folder}/deposit_glow_ore_3x_hard.rules`);
        expect(hard).toContain('NameKey = "Parts/GlowOreDeposit3xHard"');
        expect(hard).toContain('IconNameKey = "Parts/GlowOreDeposit3xHardIcon"');
        expect(hard).toContain('DescriptionKey = "Resource/IronHardDesc"');
        expect(hard).toContain('ID = test.deposit_glow_ore_3x_hard');
        expect(hard).toContain('MaxHealth = 20000');
        expect(hard).toContain('IsCrewSalvageable = false');
        expect(hard).toContain('\t\t[iron, 3]');
        expect(hard).toContain('File = "./Data/ships/asteroid/deposit_iron/deposit_iron_hard_3x_33.png"');

        const parts = read(`${folder}/parts_glow_ore.rules`);
        for (const n of [1, 2, 3]) {
            expect(parts).toContain(`&<deposit_glow_ore_${n}x.rules>/Part`);
            expect(parts).toContain(`&<deposit_glow_ore_${n}x_hard.rules>/Part`);
        }
        const conversions = read(`${folder}/conversions_glow_ore.rules`);
        expect(conversions).toContain('From = test.deposit_glow_ore_2x\n\t\tTo = test.deposit_glow_ore_2x_hard');

        const doodad = read(`${folder}/doodad_asteroid_glow_ore_xl.rules`);
        expect(doodad).toContain('ID = test.asteroid_glow_ore_xl');
        expect(doodad).toContain('Type = GeneratedShip');
        expect(doodad).toContain('DescriptionKey = "Doodads/GlowOre_XL"');
        expect(doodad).toContain('CategoryKey = "Doodads/Asteroids"');
        expect(doodad).toContain('File = "./Data/doodads/asteroids/iron/asteroid_iron_xl.png"');
        expect(doodad).toContain('ShipRulesID = "cosmoteer.asteroid"');
        expect(doodad).toContain('MinParts = 800');
        expect(doodad).toContain('MaxParts = 1600');
        expect(doodad).toContain(
            '\t\t\t\ttest.deposit_glow_ore_1x\n\t\t\t\ttest.deposit_glow_ore_2x\n\t\t\t\ttest.deposit_glow_ore_3x'
        );
        expect(doodad).toContain('MinPartsFraction = 0.125 * (&<./Data/resources/iron/iron.rules>/AsteroidDensity)');
        expect(doodad).toContain('MaxPartsFraction = 0.25 * (&<./Data/resources/iron/iron.rules>/AsteroidDensity)');
        expect(doodad).toContain('Conversions = &<./Data/doodads/asteroids/hard_conversions.rules>/Conversions');

        const types = read(`${folder}/types_glow_ore.rules`);
        expect(types).toContain('Type=test.asteroid_glow_ore_s;');
        expect(types).toContain('ChanceWeight=1 * (&<./Data/modes/career/sectors/sysgen_asteroids.rules>/SChance);');
        expect(types).toContain('ChanceWeight=1 * (&<./Data/modes/career/sectors/sysgen_asteroids.rules>/XXLChance);');

        expect(result.wiring).toEqual({
            parts: 'written',
            conversions: 'written',
            doodads: 'written',
            types: 'written',
        });
        expect(result.manifest).toBe(`${MOD_DIR}/mod.rules`);
        const written = manifest();
        expect(written).toContain('AddTo = "<ships/asteroid/asteroid.rules>/Asteroid/Parts"');
        expect(written).toContain('ManyToAdd = &<asteroids/glow_ore/parts_glow_ore.rules>/Parts');
        expect(written).toContain('AddTo = "<doodads/asteroids/hard_conversions.rules>/Conversions"');
        expect(written).toContain('ManyToAdd = &<asteroids/glow_ore/conversions_glow_ore.rules>/Conversions');
        expect(written).toContain('AddTo = "<doodads/doodads.rules>/Doodads"');
        for (const size of ['s', 'm', 'l', 'xl', 'xxl']) {
            expect(written).toContain(`\t\t\t&<asteroids/glow_ore/doodad_asteroid_glow_ore_${size}.rules>`);
        }
        expect(written).toContain('AddTo = "<modes/career/sectors/sysgen_asteroids.rules>/CommonAsteroidTypes"');
        expect(written).toContain('ManyToAdd = &<asteroids/glow_ore/types_glow_ore.rules>/Types');
        expect(parseErrorsOf(`${MOD_DIR}/mod.rules`)).toEqual([]);

        expect(result.localizationKeys).toEqual([
            'Doodads/GlowOre_S',
            'Doodads/GlowOre_M',
            'Doodads/GlowOre_L',
            'Doodads/GlowOre_XL',
            'Doodads/GlowOre_XXL',
            'Parts/GlowOreDeposit1x',
            'Parts/GlowOreDeposit1xIcon',
            'Parts/GlowOreDeposit1xHard',
            'Parts/GlowOreDeposit1xHardIcon',
            'Parts/GlowOreDeposit2x',
            'Parts/GlowOreDeposit2xIcon',
            'Parts/GlowOreDeposit2xHard',
            'Parts/GlowOreDeposit2xHardIcon',
            'Parts/GlowOreDeposit3x',
            'Parts/GlowOreDeposit3xIcon',
            'Parts/GlowOreDeposit3xHard',
            'Parts/GlowOreDeposit3xHardIcon',
        ]);
        expect(result.localizationFiles.map((file) => file.split('/').pop())).toEqual(['de.rules', 'en.rules']);
        for (const language of ['en', 'de']) {
            const strings = read(`${MOD_DIR}/strings/${language}.rules`);
            expect(strings).toContain('GlowOre_S = "Glow Ore Asteroid (S)"');
            expect(strings).toContain('GlowOreDeposit2x = "Glow Ore Deposit (2x Soft)"');
            expect(strings).toContain('GlowOreDeposit2xIcon = "Glow Ore (2x Soft)"');
            expect(strings).toContain('GlowOreDeposit2xHard = "Glow Ore Deposit (2x Hard)"');
            expect(strings).toContain('GlowOreDeposit2xHardIcon = "Glow Ore (2x Hard)"');
            expect(parseErrorsOf(`${MOD_DIR}/strings/${language}.rules`)).toEqual([]);
        }
        expect(result.changedFiles).toContain(`${MOD_DIR}/mod.rules`);
    });

    it('reports every wiring as already there when the manifest still carries the actions', async () => {
        rmSync(`${MOD_DIR}/asteroids/glow_ore`, { recursive: true, force: true });
        const before = manifest();
        const result = await apply({ id: 'glow_ore', name: 'Glow Ore', resource: 'iron', hard: true });
        expect(result.failure).toBeUndefined();
        expect(result.wiring).toEqual({
            parts: 'alreadyThere',
            conversions: 'alreadyThere',
            doodads: 'alreadyThere',
            types: 'alreadyThere',
        });
        expect(manifest()).toBe(before);
        expect(existsSync(`${MOD_DIR}/asteroids/glow_ore/doodad_asteroid_glow_ore_s.rules`)).toBe(true);
    });

    it('puts a rare type into the rare list with the large sizes only', async () => {
        const result = await apply({
            id: 'Rich_Vein',
            name: 'Rich Vein',
            resource: 'iron',
            rarity: 'rare',
            sizes: ['s', 'm', 'l', 'xl', 'xxl'],
        });
        expect(result.failure).toBeUndefined();
        expect(result.folder).toBe(`${MOD_DIR}/asteroids/rich_vein`);
        expect(result.files.filter((file) => file.includes('doodad_asteroid_'))).toHaveLength(5);
        const types = read(`${MOD_DIR}/asteroids/rich_vein/types_rich_vein.rules`);
        expect(types).not.toContain('rich_vein_s;');
        expect(types).not.toContain('rich_vein_m;');
        expect(types).toContain('Type=test.asteroid_rich_vein_l;    ChanceWeight=1; }');
        expect(types).toContain('Type=test.asteroid_rich_vein_xl;   ChanceWeight=1/2; }');
        expect(types).toContain('Type=test.asteroid_rich_vein_xxl;  ChanceWeight=1/4; }');
        expect(types).not.toContain('SChance');
        expect(manifest()).toContain('AddTo = "<modes/career/sectors/sysgen_asteroids.rules>/RareAsteroidTypes"');
        expect(manifest()).toContain('ManyToAdd = &<asteroids/rich_vein/types_rich_vein.rules>/Types');
        for (const file of result.files) expect(parseErrorsOf(file), file).toEqual([]);
    });

    it('puts a sun type into the sun list, sized to the large sizes when none are chosen', async () => {
        const result = await apply({
            id: 'corona',
            name: 'Corona',
            resource: 'iron',
            rarity: 'sun',
            weight: 2,
            sizes: [],
        });
        expect(result.failure).toBeUndefined();
        expect(
            result.files.filter((file) => file.includes('doodad_asteroid_')).map((file) => file.split('/').pop())
        ).toEqual([
            'doodad_asteroid_corona_l.rules',
            'doodad_asteroid_corona_xl.rules',
            'doodad_asteroid_corona_xxl.rules',
        ]);
        const types = read(`${MOD_DIR}/asteroids/corona/types_corona.rules`);
        expect(types).toContain('ChanceWeight=2; }');
        expect(types).toContain('ChanceWeight=2/2; }');
        expect(types).toContain('ChanceWeight=2/4; }');
        expect(manifest()).toContain('AddTo = "<modes/career/sectors/sysgen_suns.rules>/SunAsteroidTypes"');
        expect(manifest()).toContain('ManyToAdd = &<asteroids/corona/types_corona.rules>/Types');
        expect(result.localizationKeys.filter((key) => key.startsWith('Doodads/'))).toEqual([
            'Doodads/Corona_L',
            'Doodads/Corona_XL',
            'Doodads/Corona_XXL',
        ]);
    });

    it('writes no hard tiles and no conversions without hard, and takes a literal density and a mod resource', async () => {
        const result = await apply({
            id: 'soft',
            name: 'Soft',
            resource: 'modium',
            hard: false,
            density: 0.5,
            sizes: ['s', 'm'],
        });
        expect(result.failure).toBeUndefined();
        const folder = `${MOD_DIR}/asteroids/soft`;
        expect(result.files.map((file) => file.slice(folder.length + 1))).toEqual([
            'deposit_soft_1x.rules',
            'deposit_soft_2x.rules',
            'deposit_soft_3x.rules',
            'parts_soft.rules',
            'doodad_asteroid_soft_s.rules',
            'doodad_asteroid_soft_m.rules',
            'types_soft.rules',
        ]);
        expect(result.wiring).toEqual({
            parts: 'written',
            conversions: 'skipped',
            doodads: 'written',
            types: 'written',
        });
        expect(read(`${folder}/parts_soft.rules`)).not.toContain('_hard');
        expect(manifest()).not.toContain('conversions_soft');
        expect(result.localizationKeys.some((key) => key.includes('Hard'))).toBe(false);

        // A resource no game file declares has no density and no overlay of its own, so the recipe
        // takes the literal and the tile shows the look's own overlay.
        const soft = read(`${folder}/deposit_soft_2x.rules`);
        expect(soft).toContain('\t\t[modium, 2]');
        expect(soft).toContain('DescriptionKey = "Resource/ModiumDesc"');
        expect(soft).toContain('Icon : <./Data/resources/iron/iron.rules>/Overlay');
        const doodad = read(`${folder}/doodad_asteroid_soft_m.rules`);
        expect(doodad).toContain('MinPartsFraction = 0.125 * (0.5)');
        expect(doodad).toContain('MaxPartsFraction = 0.25 * (0.5)');
        for (const file of result.files) expect(parseErrorsOf(file), file).toEqual([]);
    });

    it('refuses an id in use, a folder already there and an odd id without writing anything', async () => {
        const before = digestOf(MOD_DIR);
        const takenDoodad = await apply({ id: 'dust', name: 'x' });
        expect(takenDoodad.failure).toBe('idTaken');
        const takenPart = await apply({ id: 'ORE', name: 'x' });
        expect(takenPart.failure).toBe('idTaken');
        const again = await apply({ id: 'Glow_Ore', name: 'x' });
        expect(again.failure).toBe('pathTaken');
        const odd = await apply({ id: 'my ore', name: 'x' });
        expect(odd.failure).toBe('invalidId');
        expect(digestOf(MOD_DIR)).toBe(before);
    });

    it('refuses a mod whose manifest id carries no author prefix', async () => {
        const plain = `${ROOT}/plainmod`;
        mkdirSync(plain, { recursive: true });
        writeFileSync(`${plain}/mod.rules`, 'ID = plainmod\nName = "Plain"\nVersion = 1.0.0\nActions\n[\n]\n');
        const host = makeHost();
        host.folderPaths = async () => [MOD_DIR, plain];
        const scanned = await scan(host, filePathToUri(plain));
        expect(scanned.authorPrefix).toBe('');
        expect(scanned.takenIds).toEqual([]);
        const before = digestOf(plain);
        const result = await apply({ id: 'rock', name: 'Rock' }, host, filePathToUri(plain));
        expect(result.failure).toBe('noAuthorPrefix');
        expect(digestOf(plain)).toBe(before);
    });
});
