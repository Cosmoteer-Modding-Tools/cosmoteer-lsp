import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CancellationToken, Connection, TextEdit, WorkDoneProgressReporter } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { filePathToUri } from '../../../src/features/navigation/navigation-strategy';
import { clearBaseFileCache } from '../../../src/features/refactor/shared-base/base-index';
import { newPlanet } from '../../../src/features/ships/new-planet.command';
import {
    NewPlanetApplyResult,
    NewPlanetArgs,
    NewPlanetHost,
    NewPlanetScanResult,
} from '../../../src/features/ships/new-planet.types';
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

// The planet wizard against the stand-in install the ship commands share, whose doodad registry
// lists a rocky and a gas planet and whose career spawner has the four lists a placement names.
// Everything is mirrored into a scratch copy first, because the command writes files.
const SOURCE = join(FIXTURES_DIR, 'register-ship-mod').replace(/\\/g, '/');
const token = CancellationToken.None;

let ROOT = '';
let DATA_DIR = '';
let GAME_ROOT = '';
let MOD_DIR = '';
let PLAIN_MOD_DIR = '';

const read = (path: string): string => readFileSync(path, { encoding: 'utf-8' });

/** The parsed stand-in game root, in the shape the workspace service hands the commands. */
const gameRootFile = (): FileWithPath => {
    const text = read(GAME_ROOT);
    const content: CosmoteerWorkspaceData = { name: 'cosmoteer.rules', parsedDocument: parseText(text, GAME_ROOT) };
    return { type: 'File', name: 'cosmoteer.rules', path: GAME_ROOT, content };
};

type TestHost = NewPlanetHost & { changes: Record<string, TextEdit[]>; announced: string[] };

/** A host whose client-side edits are captured rather than applied, so they can be read back. */
const makeHost = (taken: string[] = []): TestHost => ({
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
    existingIds: async () => new Set<string>(taken),
    localizedName: async (key) => ({ 'Doodads/PlanetRocky': 'Rocky', 'Doodads/PlanetGas': 'Gas Giant' })[key],
});

/** The scan round, asserting it answered as one. */
const scan = async (host: NewPlanetHost, uri = filePathToUri(MOD_DIR)): Promise<NewPlanetScanResult> => {
    const result = await newPlanet({ uri }, host, token);
    if (result.kind !== 'scan') throw new Error('expected the scan round');
    return result;
};

/** The apply round, asserting it answered as one. */
const apply = async (
    args: Omit<NewPlanetArgs, 'uri'>,
    host: NewPlanetHost,
    uri = filePathToUri(MOD_DIR)
): Promise<NewPlanetApplyResult> => {
    const result = await newPlanet({ uri, ...args }, host, token);
    if (result.kind !== 'apply') throw new Error('expected the apply round');
    return result;
};

/** The one edit the host captured for the manifest. */
const manifestEdit = (host: TestHost): string => {
    const edits = host.changes[filePathToUri(`${MOD_DIR}/mod.rules`)];
    expect(edits).toHaveLength(1);
    return edits[0].newText;
};

/** Writes the captured manifest edit to disk, the way the editor would have. */
const commitManifest = (host: TestHost): void => {
    const path = `${MOD_DIR}/mod.rules`;
    const edits = host.changes[filePathToUri(path)];
    const document = TextDocument.create(filePathToUri(path), 'cosmoteer', 1, read(path));
    writeFileSync(path, TextDocument.applyEdits(document, edits));
};

/** Asserts a written rules file parses cleanly. */
const expectParses = (path: string): void => {
    const result = parser(lexer(read(path)), filePathToUri(path));
    expect(result.parserErrors).toEqual([]);
};

beforeAll(async () => {
    ROOT = mkdtempSync(join(tmpdir(), 'newplanet-')).replace(/\\/g, '/');
    cpSync(SOURCE, ROOT, { recursive: true });
    DATA_DIR = `${ROOT}/steamapps/common/Cosmoteer/Data`;
    GAME_ROOT = `${DATA_DIR}/cosmoteer.rules`;
    MOD_DIR = `${ROOT}/mod`;
    // A mod whose id carries no author segment, which cannot declare a doodad at all.
    PLAIN_MOD_DIR = `${ROOT}/plainmod`;
    mkdirSync(PLAIN_MOD_DIR, { recursive: true });
    writeFileSync(`${PLAIN_MOD_DIR}/mod.rules`, 'ID = plainmod\nName = "Plain"\nVersion = 1.0.0\nActions\n[\n]\n');

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

describe('creating a planet', () => {
    it("offers the game's planets with their style, name and icon, and reports every doodad id as taken", async () => {
        const result = await scan(makeHost());
        expect(result.failure).toBeUndefined();
        expect(result.modId).toBe('test.shipmod');
        expect(result.authorPrefix).toBe('test');
        // The registry may list other doodad kinds beside the planets, which are taken ids but not bases.
        expect(result.bases.filter((base) => base.id.includes('planet_'))).toEqual([
            {
                id: 'cosmoteer.planet_rocky',
                style: 'rocky',
                label: 'Rocky',
                icon: `${DATA_DIR}/doodads/planets/planet_rocky.png`,
            },
            {
                id: 'cosmoteer.planet_gas',
                style: 'gas',
                label: 'Gas Giant',
                icon: `${DATA_DIR}/doodads/planets/planet_gas.png`,
            },
        ]);
        expect(result.bases.every((base) => base.id.includes('planet_'))).toBe(true);
        expect(result.takenIds).toEqual(expect.arrayContaining(['cosmoteer.planet_rocky', 'cosmoteer.planet_gas']));
        expect(result.takenIds.length).toBeGreaterThanOrEqual(result.bases.length);
        expect(result.placements).toEqual(['inner', 'outer', 'innerMoon', 'outerMoon', 'none']);
    });

    it('writes the derived doodad, its key and both manifest actions', async () => {
        const host = makeHost();
        const result = await apply(
            { id: 'dusty', name: 'Dusty World', base: 'cosmoteer.planet_gas', placement: 'outer', weight: 0.5 },
            host
        );
        expect(result.failure).toBeUndefined();
        expect(result.id).toBe('test.planet_dusty');
        expect(result.file).toBe(`${MOD_DIR}/doodads/planets/dusty/doodad_planet_dusty.rules`);
        expect(result.createdFiles).toEqual([result.file]);

        // The base is inherited whole by the named Planet member, so its style and orbit figures stay the
        // base's, and the icon is the base's own named against the install.
        expect(read(result.file)).toBe(
            [
                "// The planet, built on one of the game's own: the style it is drawn in and every size and orbit",
                "// figure not named here are the base's. The icon is the game's own until you draw one: put a",
                '// PNG beside this file and name it here.',
                'Planet : <./Data/doodads/planets/doodad_planet_gas.rules>',
                '{',
                '\tID = test.planet_dusty',
                '\tDescriptionKey = "Doodads/Dusty"',
                '\tIcon { Texture { File = "./Data/doodads/planets/planet_gas.png"; MipLevels = 2; SampleMode = Linear } }',
                "\t// The base's sizes, to override here: ScaleRange = [1000, 3000]  RandomScaleRange = [2000, 2500]  DefaultScale = 2000",
                '\t// MinimapColorScale = [255, 255, 255, 127]',
                '}',
                '',
            ].join('\n')
        );
        expectParses(result.file);

        expect(result.wiring).toEqual({ doodads: 'written', spawner: 'written' });
        expect(result.manifest).toBe(`${MOD_DIR}/mod.rules`);
        const written = manifestEdit(host);
        expect(written).toContain(
            [
                '\t{',
                '\t\tAction = AddMany',
                '\t\tAddTo = "<doodads/doodads.rules>/Doodads"',
                '\t\tManyToAdd [ &<doodads/planets/dusty/doodad_planet_dusty.rules>/Planet ]',
                '\t}',
            ].join('\n')
        );
        expect(written).toContain(
            [
                '\t{',
                '\t\tAction = AddMany',
                '\t\tAddTo = "<modes/career/sectors/sysgen_planets.rules>/OuterPlanet/DoodadTypes"',
                '\t\tManyToAdd',
                '\t\t[',
                '\t\t\t{ Type=test.planet_dusty; ChanceWeight=0.5; }',
                '\t\t]',
                '\t}',
            ].join('\n')
        );

        expect(result.localizationKeys).toEqual(['Doodads/Dusty']);
        expect(result.localizationFiles.map((file) => file.split('/').pop())).toEqual(['de.rules', 'en.rules']);
        expect(read(`${MOD_DIR}/strings/en.rules`)).toContain('Dusty = "Dusty World"');
        expect(read(`${MOD_DIR}/strings/de.rules`)).toContain('Dusty = "Dusty World"');
        expectParses(`${MOD_DIR}/strings/en.rules`);
        expect(result.changedFiles).toContain(`${MOD_DIR}/mod.rules`);
    });

    it('writes the sizes the client chose and targets the list each placement names', async () => {
        const cases: [NonNullable<NewPlanetArgs['placement']>, string][] = [
            ['inner', 'InnerPlanet/DoodadTypes'],
            ['innerMoon', 'InnerPlanet/SubSpawners/0/DoodadTypes'],
            ['outerMoon', 'OuterPlanet/SubSpawners/0/DoodadTypes'],
        ];
        for (const [placement, list] of cases) {
            const host = makeHost();
            const result = await apply(
                { id: `pebble_${placement}`, name: 'Pebble', placement, scale: [100, 200], defaultScale: 150 },
                host
            );
            expect(result.failure).toBeUndefined();
            const text = read(result.file);
            expect(text).toContain('Planet : <./Data/doodads/planets/doodad_planet_rocky.rules>');
            expect(text).toContain(
                '\tScaleRange = [100, 200]\n\tRandomScaleRange = [100, 200]\n\tDefaultScale = 150\n'
            );
            expect(text).not.toContain("The base's sizes");
            expect(text).toContain('\t// MinimapColorScale = [255, 255, 255, 127]');
            expectParses(result.file);
            expect(manifestEdit(host)).toContain(`AddTo = "<modes/career/sectors/sysgen_planets.rules>/${list}"`);
            expect(manifestEdit(host)).toContain(
                `{ Type=test.planet_pebble_${placement.toLowerCase()}; ChanceWeight=1; }`
            );
        }
    });

    it('replaces a default size the new range leaves out, and keeps the base default that fits', async () => {
        const wide = await apply(
            { id: 'wide', name: 'Wide', base: 'cosmoteer.planet_gas', scale: [1500, 2500] },
            makeHost()
        );
        expect(read(wide.file)).toContain('\tScaleRange = [1500, 2500]\n\tRandomScaleRange = [1500, 2500]\n');
        expect(read(wide.file)).toContain("\t// The base's sizes, to override here: DefaultScale = 2000\n");
        const small = await apply(
            { id: 'small', name: 'Small', base: 'cosmoteer.planet_gas', scale: [100, 300] },
            makeHost()
        );
        expect(read(small.file)).toContain('\tDefaultScale = 200\n');
        expect(read(small.file)).not.toContain("The base's sizes");
    });

    it('skips the spawner for a planet placed by hand only', async () => {
        const host = makeHost();
        const result = await apply({ id: 'shy', name: 'Shy', placement: 'none' }, host);
        expect(result.failure).toBeUndefined();
        expect(result.wiring).toEqual({ doodads: 'written', spawner: 'skipped' });
        expect(manifestEdit(host)).not.toContain('sysgen_planets');
    });

    it('refuses a taken id before a taken path, a taken path, a mod without an author prefix, and a bad word', async () => {
        const before = read(`${MOD_DIR}/mod.rules`);
        const taken = await apply({ id: 'Dusty', name: 'x' }, makeHost(['test.planet_dusty']));
        expect(taken.failure).toBe('idTaken');
        const path = await apply({ id: 'dusty', name: 'x' }, makeHost());
        expect(path.failure).toBe('pathTaken');
        const plainHost = makeHost();
        const plain = await apply({ id: 'lonely', name: 'x' }, plainHost, filePathToUri(PLAIN_MOD_DIR));
        expect(plain.failure).toBe('noAuthorPrefix');
        expect(existsSync(`${PLAIN_MOD_DIR}/doodads`)).toBe(false);
        const odd = await apply({ id: 'my planet', name: 'x' }, makeHost());
        expect(odd.failure).toBe('invalidId');
        for (const result of [taken, path, plain, odd]) expect(result.createdFiles).toEqual([]);
        expect(read(`${MOD_DIR}/mod.rules`)).toBe(before);
        expect(Object.keys(plainHost.changes)).toEqual([]);
    });

    it('reports both wirings as present once the manifest carries them', async () => {
        const first = makeHost();
        await apply({ id: 'twice', name: 'Twice', placement: 'inner' }, first);
        commitManifest(first);
        rmSync(`${MOD_DIR}/doodads/planets/twice`, { recursive: true, force: true });
        clearBaseFileCache();
        clearFsCaches();
        const again = makeHost();
        const result = await apply({ id: 'twice', name: 'Twice', placement: 'inner' }, again);
        expect(result.failure).toBeUndefined();
        expect(result.wiring).toEqual({ doodads: 'present', spawner: 'present' });
        expect(Object.keys(again.changes)).toEqual([]);
        expectParses(`${MOD_DIR}/mod.rules`);
    });
});
