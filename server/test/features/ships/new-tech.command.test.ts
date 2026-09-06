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
import { newTech } from '../../../src/features/ships/new-tech.command';
import {
    NewTechApplyResult,
    NewTechArgs,
    NewTechHost,
    NewTechScanResult,
} from '../../../src/features/ships/new-tech.types';
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

// The tech command against the ship fixture's stand-in install, whose mod declares three parts, one
// per group field a part can have, and whose career mode names a tech list of two vanilla-shaped
// techs. Everything is mirrored into a scratch copy first, because the command writes files.
const SOURCE = join(FIXTURES_DIR, 'register-ship-mod').replace(/\\/g, '/');
const token = CancellationToken.None;

let ROOT = '';
let DATA_DIR = '';
let GAME_ROOT = '';
let MOD_DIR = '';
let EMPTY_MOD = '';

const read = (path: string): string => readFileSync(path, { encoding: 'utf-8' });

/** The parsed stand-in game root, in the shape the workspace service hands the command. */
const gameRootFile = (): FileWithPath => {
    const text = read(GAME_ROOT);
    const content: CosmoteerWorkspaceData = { name: 'cosmoteer.rules', parsedDocument: parseText(text, GAME_ROOT) };
    return { type: 'File', name: 'cosmoteer.rules', path: GAME_ROOT, content };
};

/** The names the fixture's language files would give the keys the parts and techs carry. */
const NAMES: Record<string, string> = {
    'Parts/Laser': 'Laser',
    'Parts/Armor': 'Armor',
    'Parts/LaserGun': 'Laser Gun',
    'Parts/FlakGun': 'Flak Gun',
    'Parts/BarePlate': 'Bare Plate',
};

type TestHost = NewTechHost & { changes: Record<string, TextEdit[]>; announced: string[] };

/** A host whose client-side edits are captured rather than applied, so they can be read back. */
const makeHost = (options: { noGameRoot?: boolean; bareRoot?: boolean } = {}): TestHost => ({
    changes: {},
    announced: [],
    folderPaths: async () => [MOD_DIR],
    openDocuments: () => [],
    gameRoot: async () => {
        if (options.noGameRoot) return undefined;
        if (!options.bareRoot) return gameRootFile();
        // A game root that names no career mode, so the tech list has to be found by its own path.
        const bare = parseText('Resources = &<resources/resources.rules>/Resources\n', GAME_ROOT);
        return {
            type: 'File',
            name: 'cosmoteer.rules',
            path: GAME_ROOT,
            content: { name: 'cosmoteer.rules', parsedDocument: bare },
        };
    },
    dataRoot: () => (options.noGameRoot ? undefined : DATA_DIR),
    applyEdit(changes) {
        Object.assign(this.changes, changes);
        return Promise.resolve(true);
    },
    filesChanged(paths) {
        this.announced.push(...paths);
    },
    localizedName: async (key) => NAMES[key],
});

/** The scan round, asserting it answered as one. */
const scan = async (host: NewTechHost, uri = filePathToUri(MOD_DIR)): Promise<NewTechScanResult> => {
    const result = await newTech({ uri }, host, token);
    if (result.kind !== 'scan') throw new Error('expected the scan round');
    return result;
};

/** The apply round, asserting it answered as one. */
const apply = async (args: Omit<NewTechArgs, 'uri'>, host: NewTechHost): Promise<NewTechApplyResult> => {
    const result = await newTech({ uri: filePathToUri(MOD_DIR), ...args }, host, token);
    if (result.kind !== 'apply') throw new Error('expected the apply round');
    return result;
};

/** Apply captured edits to a text, so what the client would have written can be read back. */
const applyEdits = (text: string, edits: readonly TextEdit[]): string =>
    TextDocument.applyEdits(TextDocument.create('file:///x', 'rules', 0, text), [...edits]);

/** The manifest as the client would have written it after the command's edit. */
const writtenManifest = (host: TestHost): string =>
    applyEdits(read(`${MOD_DIR}/mod.rules`), host.changes[filePathToUri(`${MOD_DIR}/mod.rules`)] ?? []);

/** Asserts a written file is one the real parser reads without complaint. */
const expectParses = (fsPath: string): void => {
    const parsed = parser(lexer(read(fsPath)), filePathToUri(fsPath));
    expect(parsed.parserErrors.map((error) => error.message)).toEqual([]);
};

/** The tech file the command writes for a part, with the given group line. */
const techText = (id: string, part: string, groupLine: string, cost: number, prerequisites?: string): string =>
    [
        '// A part is buildable from the start of a career until a tech names it in PartsUnlocked. This',
        `// tech puts ${id} behind a purchase at a station. Its name, description, icon and group`,
        "// are the part's own, read by reference, so the tech follows the part.",
        'Tech',
        '{',
        `\tID = ${id}`,
        `\tNameKey = &<../parts/${part}/${part}.rules>/Part/NameKey`,
        `\tDescriptionKey = &<../parts/${part}/${part}.rules>/Part/DescriptionKey`,
        `\tIcon = &<../parts/${part}/${part}.rules>/Part/EditorIcon`,
        `\t${groupLine}`,
        `\tPartsUnlocked = [&<../parts/${part}/${part}.rules>/Part/ID]`,
        `\tCost = ${cost}`,
        ...(prerequisites ? [`\tPrerequisites = [${prerequisites}]`] : []),
        '}',
        '',
    ].join('\n');

beforeAll(async () => {
    ROOT = mkdtempSync(join(tmpdir(), 'newtech-')).replace(/\\/g, '/');
    cpSync(SOURCE, ROOT, { recursive: true });
    DATA_DIR = `${ROOT}/steamapps/common/Cosmoteer/Data`;
    GAME_ROOT = `${DATA_DIR}/cosmoteer.rules`;
    MOD_DIR = `${ROOT}/mod`;
    EMPTY_MOD = `${ROOT}/emptymod`;
    mkdirSync(EMPTY_MOD, { recursive: true });
    writeFileSync(`${EMPTY_MOD}/mod.rules`, 'ID = test.empty\nName = "Empty"\nVersion = 1.0.0\n', 'utf-8');

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

describe('the tech scan round', () => {
    it('lists the mod parts with their names and the group field each declares', async () => {
        const result = await scan(makeHost());
        expect(result.failure).toBeUndefined();
        expect(result.modId).toBe('test.shipmod');
        expect(result.parts.map((part) => [part.id, part.name, part.groupField])).toEqual([
            ['test.bare_plate', 'Bare Plate', 'none'],
            ['test.flak_gun', 'Flak Gun', 'EditorGroups'],
            ['test.laser_gun', 'Laser Gun', 'EditorGroup'],
        ]);
        expect(result.parts[2].fsPath).toBe(`${MOD_DIR}/parts/laser_gun/laser_gun.rules`);
    });

    it('lists the game techs, naming one through the part key it references, and every id in use', async () => {
        const result = await scan(makeHost());
        expect(result.techs).toEqual([
            { id: 'cosmoteer.laser', name: 'Laser' },
            { id: 'cosmoteer.armor', name: 'Armor' },
        ]);
        // The alias is as taken as the id it stands beside, since the game registers both.
        expect(result.takenIds.sort()).toEqual(['cosmoteer.armor', 'cosmoteer.armor_plate', 'cosmoteer.laser']);
    });

    it('says there is nothing to unlock in a mod without a part', async () => {
        const result = await newTech(
            { uri: filePathToUri(EMPTY_MOD) },
            { ...makeHost(), folderPaths: async () => [EMPTY_MOD] },
            token
        );
        expect(result.kind).toBe('scan');
        expect(result.failure).toBe('noParts');
    });

    it('refuses without the game path, since the tech list cannot be known', async () => {
        const result = await scan(makeHost({ noGameRoot: true }));
        expect(result.failure).toBe('noGameRoot');
    });
});

describe('creating a tech', () => {
    it('writes the tech for a part with an EditorGroup and adds it to the game tech list', async () => {
        const host = makeHost();
        const result = await apply({ part: 'test.laser_gun', cost: 2500, prerequisites: ['cosmoteer.laser'] }, host);
        expect(result.failure).toBeUndefined();
        expect(result.id).toBe('test.laser_gun');
        expect(result.file).toBe(`${MOD_DIR}/techs/laser_gun.rules`);
        expect(read(result.file)).toBe(
            techText(
                'test.laser_gun',
                'laser_gun',
                'EditorGroup = &<../parts/laser_gun/laser_gun.rules>/Part/EditorGroup',
                2500,
                'cosmoteer.laser'
            )
        );
        expectParses(result.file);

        expect(result.wiring).toEqual({ techs: 'written' });
        expect(result.manifest).toBe(`${MOD_DIR}/mod.rules`);
        expect(result.createdFiles).toEqual([result.file]);
        expect(result.changedFiles).toEqual([result.file, `${MOD_DIR}/mod.rules`]);
        const written = writtenManifest(host);
        expect(written).toContain('AddTo = "<modes/career/techs.rules>/Techs"');
        expect(written).toContain('ManyToAdd [ &<techs/laser_gun.rules>/Tech ]');
        expect(host.announced).toContain(result.file);
    });

    it('mirrors EditorGroups for a part that declares the list form, with no prerequisite line', async () => {
        const host = makeHost();
        const result = await apply({ part: 'test.flak_gun', cost: 4000, prerequisites: [] }, host);
        expect(result.failure).toBeUndefined();
        expect(read(result.file)).toBe(
            techText(
                'test.flak_gun',
                'flak_gun',
                'EditorGroups = &<../parts/flak_gun/flak_gun.rules>/Part/EditorGroups',
                4000
            )
        );
        expectParses(result.file);
    });

    it('writes a literal group for a part that declares neither, since the tech has to carry one', async () => {
        const host = makeHost();
        const result = await apply({ part: 'test.bare_plate', cost: 1000 }, host);
        expect(result.failure).toBeUndefined();
        expect(read(result.file)).toBe(techText('test.bare_plate', 'bare_plate', 'EditorGroup = "Structure"', 1000));
        expectParses(result.file);
    });

    it('takes an id of its own, defaults an unreadable cost and drops a prerequisite that is no id', async () => {
        const host = makeHost();
        const result = await apply(
            {
                part: 'test.laser_gun',
                id: 'test.laser_gun_mk2',
                cost: -3,
                prerequisites: ['cosmoteer.laser', 'no such thing', 'cosmoteer.laser'],
            },
            host
        );
        expect(result.failure).toBeUndefined();
        expect(result.file).toBe(`${MOD_DIR}/techs/laser_gun_mk2.rules`);
        const text = read(result.file);
        expect(text).toContain('ID = test.laser_gun_mk2');
        expect(text).toContain('Cost = 3000');
        expect(text).toContain('Prerequisites = [cosmoteer.laser]');
        expectParses(result.file);
    });

    it('finds the tech list by its own path when the game root names no career mode', async () => {
        const host = makeHost({ bareRoot: true });
        const result = await apply({ part: 'test.laser_gun', id: 'test.rootless', cost: 500 }, host);
        expect(result.failure).toBeUndefined();
        expect(result.wiring).toEqual({ techs: 'written' });
        expect(writtenManifest(host)).toContain('AddTo = "<modes/career/techs.rules>/Techs"');
    });

    it('reports the wiring as present when the manifest already adds the file', async () => {
        const manifest = `${MOD_DIR}/mod.rules`;
        const original = read(manifest);
        writeFileSync(
            manifest,
            original.replace(
                '\nActions\n[\n',
                '\nActions\n[\n\t{\n\t\tAction = AddMany\n\t\tAddTo = "<modes/career/techs.rules>/Techs"\n\t\tManyToAdd [ &<techs/prewired.rules>/Tech ]\n\t}\n'
            ),
            'utf-8'
        );
        try {
            clearBaseFileCache();
            const host = makeHost();
            const result = await apply({ part: 'test.laser_gun', id: 'test.prewired', cost: 100 }, host);
            expect(result.failure).toBeUndefined();
            expect(existsSync(result.file)).toBe(true);
            expect(result.wiring).toEqual({ techs: 'present' });
            expect(host.changes[filePathToUri(manifest)]).toBeUndefined();
        } finally {
            writeFileSync(manifest, original, 'utf-8');
            clearBaseFileCache();
        }
    });

    it('lists a tech the mod wrote as taken on the next scan', async () => {
        const result = await scan(makeHost());
        expect(result.takenIds).toContain('test.laser_gun');
        expect(result.techs.map((entry) => entry.id)).toContain('test.laser_gun');
    });
});

describe('what the tech command refuses', () => {
    it('refuses a part the mod does not declare, writing nothing', async () => {
        const host = makeHost();
        const result = await apply({ part: 'test.nothing', cost: 100 }, host);
        expect(result.failure).toBe('unknownPart');
        expect(result.file).toBe('');
        expect(existsSync(`${MOD_DIR}/techs/nothing.rules`)).toBe(false);
        expect(host.changes[filePathToUri(`${MOD_DIR}/mod.rules`)]).toBeUndefined();
    });

    it('refuses an id the game already uses, its aliases included, writing nothing', async () => {
        const host = makeHost();
        expect((await apply({ part: 'test.laser_gun', id: 'Cosmoteer.Laser', cost: 100 }, host)).failure).toBe(
            'idTaken'
        );
        expect((await apply({ part: 'test.laser_gun', id: 'cosmoteer.armor_plate', cost: 100 }, host)).failure).toBe(
            'idTaken'
        );
        expect(existsSync(`${MOD_DIR}/techs/laser.rules`)).toBe(false);
        expect(existsSync(`${MOD_DIR}/techs/armor_plate.rules`)).toBe(false);
    });

    it('refuses a file that is already there rather than overwriting it', async () => {
        const host = makeHost();
        const before = read(`${MOD_DIR}/techs/laser_gun.rules`);
        const result = await apply({ part: 'test.laser_gun', cost: 999 }, host);
        expect(result.failure).toBe('pathTaken');
        expect(read(`${MOD_DIR}/techs/laser_gun.rules`)).toBe(before);
    });

    it('refuses an id that needs quoting', async () => {
        const result = await apply({ part: 'test.laser_gun', id: 'my tech', cost: 100 }, makeHost());
        expect(result.failure).toBe('invalidId');
    });

    it('refuses the game data and a folder in no mod', async () => {
        const vanilla = await newTech(
            { uri: filePathToUri(`${DATA_DIR}/ships/terran/laser/laser.rules`) },
            makeHost(),
            token
        );
        expect(vanilla.failure).toBe('notEditable');
        const loose = await newTech({ uri: filePathToUri(`${ROOT}/steamapps`) }, makeHost(), token);
        expect(loose.failure).toBe('noModRoot');
    });
});
