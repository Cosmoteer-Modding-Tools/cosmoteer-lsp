import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CancellationToken, Connection, TextEdit, WorkDoneProgressReporter } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { isListNode, isValueNode } from '../../../../src/core/ast/ast';
import { filePathToUri } from '../../../../src/features/navigation/navigation-strategy';
import { clearBaseFileCache } from '../../../../src/features/refactor/shared-base/base-index';
import {
    newContent,
    NewContentHost,
} from '../../../../src/features/refactor/new-content/new-content.command';
import {
    gameRootListTarget,
    manifestForRegistration,
} from '../../../../src/features/refactor/new-content/registration.emitter';
import {
    ContentKind,
    NewContentApplyResult,
    NewContentArgs,
    NewContentScanResult,
} from '../../../../src/features/refactor/new-content/new-content.types';
import { parseModActions } from '../../../../src/mod/action-parser';
import { clearModRootCache } from '../../../../src/mod/mod-root';
import { globalSettings } from '../../../../src/settings';
import { parseText } from '../../../../src/utils/ast.utils';
import { clearFsCaches } from '../../../../src/workspace/fs-cache';
import { CosmoteerWorkspaceData, FileWithPath } from '../../../../src/workspace/cosmoteer-workspace.service';
import { CosmoteerWorkspaceService } from '../../../../src/workspace/cosmoteer-workspace.service';
import { FIXTURES_DIR } from '../../../helpers';

// The command itself, against a stand-in install laid out the way Steam lays one out, so the game
// tree, the workshop tree and the mod being edited are all real directories the gate really sees.
// Everything is mirrored into a scratch copy first, because this command writes files.
const SOURCE = join(FIXTURES_DIR, 'new-content-mod').replace(/\\/g, '/');
const token = CancellationToken.None;

let ROOT = '';
let DATA_DIR = '';
let GAME_ROOT = '';
let MOD_DIR = '';
let TWO_MANIFEST = '';
let FRAGMENT_ACTIONS = '';
let NO_STRINGS = '';
let LOOSE = '';
let WORKSHOP_PART = '';

const read = (path: string): string => readFileSync(path, { encoding: 'utf-8' });

/** The parsed stand-in game root, in the shape the workspace service hands the command. */
const gameRootFile = (): FileWithPath => {
    const text = read(GAME_ROOT);
    const content: CosmoteerWorkspaceData = { name: 'cosmoteer.rules', parsedDocument: parseText(text, GAME_ROOT) };
    return { type: 'File', name: 'cosmoteer.rules', path: GAME_ROOT, content };
};

type TestHost = NewContentHost & { changes: Record<string, TextEdit[]>; announced: string[] };

/** A host whose client-side edits are captured rather than applied, so they can be read back. */
const makeHost = (
    options: {
        folders?: string[];
        open?: TextDocument[];
        applies?: boolean;
        ids?: Record<string, string[]>;
        noGameRoot?: boolean;
    } = {}
): TestHost => ({
    changes: {},
    announced: [],
    folderPaths: async () => options.folders ?? [MOD_DIR],
    openDocuments: () => options.open ?? [],
    gameRoot: async () => (options.noGameRoot ? undefined : gameRootFile()),
    dataRoot: () => (options.noGameRoot ? undefined : DATA_DIR),
    applyEdit(changes) {
        Object.assign(this.changes, changes);
        return Promise.resolve(options.applies ?? true);
    },
    filesChanged(paths) {
        this.announced.push(...paths);
    },
    ...(options.ids
        ? { existingIds: async (cls: string) => new Set(options.ids?.[cls] ?? []) }
        : {}),
});

/** The scan round, asserting it answered as one. */
const scan = async (uri: string, host: NewContentHost): Promise<NewContentScanResult> => {
    const result = await newContent({ uri }, host, token);
    if (result.kind !== 'scan') throw new Error('expected the scan round');
    return result;
};

/** The apply round, asserting it answered as one. */
const apply = async (args: NewContentArgs, host: NewContentHost): Promise<NewContentApplyResult> => {
    const result = await newContent(args, host, token);
    if (result.kind !== 'apply') throw new Error('expected the apply round');
    return result;
};

/** A file of the mod the command is invoked from, standing in for the active editor's document. */
const anchorUri = (): string => filePathToUri(`${MOD_DIR}/parts/taken_part/taken_part.rules`);

/** The `AddMany` actions a manifest text carries, as target and source reference pairs. */
const addManyEntries = (text: string, fsPath: string): Array<{ target: string; sources: string[] }> => {
    const entries: Array<{ target: string; sources: string[] }> = [];
    for (const action of parseModActions(parseText(text, fsPath))) {
        if (action.type !== 'AddMany') continue;
        const sources: string[] = [];
        for (const source of action.sources) {
            const elements = isListNode(source) ? source.elements : [source];
            for (const element of elements) {
                if (isValueNode(element)) sources.push(String(element.valueType.value));
            }
        }
        entries.push({ target: String(action.targets[0]?.valueType.value ?? ''), sources });
    }
    return entries;
};

/** The `Replace` actions a manifest text carries, as target and replacement path pairs. */
const replaceEntries = (text: string, fsPath: string): Array<{ target: string; with: string }> => {
    const entries: Array<{ target: string; with: string }> = [];
    for (const action of parseModActions(parseText(text, fsPath))) {
        if (action.type !== 'Replace') continue;
        const source = action.sources[0];
        entries.push({
            target: String(action.targets[0]?.valueType.value ?? ''),
            with: source && isValueNode(source) ? String(source.valueType.value) : '',
        });
    }
    return entries;
};

beforeAll(async () => {
    ROOT = mkdtempSync(join(tmpdir(), 'newcontent-')).replace(/\\/g, '/');
    cpSync(SOURCE, ROOT, { recursive: true });
    DATA_DIR = `${ROOT}/steamapps/common/Cosmoteer/Data`;
    GAME_ROOT = `${DATA_DIR}/cosmoteer.rules`;
    MOD_DIR = `${ROOT}/mod`;
    TWO_MANIFEST = `${ROOT}/twomanifest`;
    FRAGMENT_ACTIONS = `${ROOT}/fragmentactions`;
    NO_STRINGS = `${ROOT}/nostrings`;
    LOOSE = `${ROOT}/loose/loose.rules`;
    WORKSHOP_PART = `${ROOT}/steamapps/workshop/content/799600/900001/parts/installed/installed.rules`;

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

describe('the new-content scan round', () => {
    it('names the mod, its id and the prefix every new id carries', async () => {
        const result = await scan(anchorUri(), makeHost());
        expect(result.modRoot).toBe(MOD_DIR);
        expect(result.modId).toBe('test.newcontent');
        expect(result.idPrefix).toBe('test');
        expect(result.failure).toBeUndefined();
    });

    it('reports all eleven kinds with the folder each goes in and how each one is wired in', async () => {
        const result = await scan(anchorUri(), makeHost());
        expect(result.kinds.map((info) => [info.kind, info.folder, info.registration])).toEqual([
            ['part', 'parts', 'ship'],
            ['resource', 'resources', 'manifest'],
            ['bullet', 'shots', 'none'],
            ['mediaEffect', 'effects', 'none'],
            ['logoShip', 'gui', 'manifest'],
            ['decalFolder', 'roof_decals', 'manifest'],
            ['editorGroup', 'gui/editor_groups', 'manifest'],
            ['partStat', 'gui/stats', 'manifest'],
            ['partToggle', 'gui/toggles', 'manifest'],
            ['buff', 'buffs', 'manifest'],
            ['codexPage', 'codex', 'manifest'],
        ]);
    });

    it('says plainly, before anything is created, that nothing will reach a shot or an effect', async () => {
        const result = await scan(anchorUri(), makeHost());
        const byKind = new Map(result.kinds.map((info) => [info.kind, info]));
        expect(byKind.get('bullet')?.pointedAtBy).toContain('Nothing reaches this shot yet');
        expect(byKind.get('mediaEffect')?.pointedAtBy).toContain('Nothing reaches this effect yet');
        expect(byKind.get('part')?.pointedAtBy).toBeUndefined();
        expect(byKind.get('resource')?.pointedAtBy).toBeUndefined();
        expect(byKind.get('logoShip')?.pointedAtBy).toBeUndefined();
        expect(byKind.get('decalFolder')?.pointedAtBy).toBeUndefined();
        for (const kind of ['editorGroup', 'partStat', 'partToggle', 'buff', 'codexPage'] as ContentKind[]) {
            expect(byKind.get(kind)?.pointedAtBy, `${kind} claims nothing reaches it`).toBeUndefined();
        }
    });

    it('reports the game registry ships and the mod-added ones, each with its route', async () => {
        const result = await scan(anchorUri(), makeHost());
        const byName = new Map(result.ships.map((ship) => [ship.groupName, ship]));
        expect([...byName.keys()]).toEqual(['Terran', 'Inherited', 'ModShip']);
        expect(byName.get('Terran')).toMatchObject({ target: 'vanilla', via: 'modAction' });
        expect(byName.get('Terran')?.blocked).toBeUndefined();
        expect(byName.get('ModShip')).toMatchObject({ target: 'workspace', via: 'shipFile' });
        expect(byName.get('ModShip')?.id).toBe('test.modship');
    });

    it('refuses a ship that only inherits its Parts list', async () => {
        const result = await scan(anchorUri(), makeHost());
        expect(result.ships.find((ship) => ship.groupName === 'Inherited')?.blocked).toBe('partsInherited');
    });

    it('works from a folder, since the command has to be reachable with no rules file open', async () => {
        // Both clients fall back to a workspace folder when nothing is open, and a folder read as a
        // plain file path would be judged as a file beside itself rather than inside itself.
        const result = await scan(filePathToUri(MOD_DIR), makeHost());
        expect(result.modRoot).toBe(MOD_DIR);
        expect(result.idPrefix).toBe('test');
    });

    it('reports the manifest route as closed for a mod that ships only version variants', async () => {
        const result = await scan(filePathToUri(`${TWO_MANIFEST}/mod_0.29.rules`), makeHost({ folders: [TWO_MANIFEST] }));
        expect(result.kinds.find((info) => info.kind === 'resource')?.blocked).toBe('ambiguousManifest');
    });
});

describe('creating a part', () => {
    it('writes the file, derives its id from the manifest and registers it in a mod-owned ship', async () => {
        const host = makeHost();
        const result = await apply(
            { uri: anchorUri(), kind: 'part', name: 'Tri Armor 2x2', ship: shipKey(await scan(anchorUri(), host), 'ModShip') },
            host
        );
        expect(result.failure).toBeUndefined();
        expect(result.created).toBe(`${MOD_DIR}/parts/tri_armor_2x2/tri_armor_2x2.rules`);
        expect(existsSync(result.created)).toBe(true);
        expect(result.id).toBe('test.tri_armor_2x2');
        expect(result.route).toBe('ship');
        expect(result.registrationFailure).toBeUndefined();
        expect(result.registeredIn).toBe(`${MOD_DIR}/ships/modship.rules`);

        const edits = host.changes[filePathToUri(`${MOD_DIR}/ships/modship.rules`)];
        expect(edits?.length).toBe(1);
        expect(edits[0].newText).toContain('&<../parts/tri_armor_2x2/tri_armor_2x2.rules>/Part');
    });

    it('patches a vanilla ship from the manifest instead of editing the install', async () => {
        const host = makeHost();
        const result = await apply(
            { uri: anchorUri(), kind: 'part', name: 'vanilla_bound', ship: shipKey(await scan(anchorUri(), host), 'Terran') },
            host
        );
        expect(result.failure).toBeUndefined();
        expect(result.registeredIn).toBe(`${MOD_DIR}/mod.rules`);
        const edits = host.changes[filePathToUri(`${MOD_DIR}/mod.rules`)];
        const written = applyEdits(read(`${MOD_DIR}/mod.rules`), edits ?? []);
        const entries = addManyEntries(written, `${MOD_DIR}/mod.rules`);
        expect(entries).toContainEqual({
            target: '<ships/terran/terran.rules>/Terran/Parts',
            sources: ['&<parts/vanilla_bound/vanilla_bound.rules>/Part'],
        });
        // Nothing of the game install may be touched, whichever route was taken.
        expect(host.announced.every((path) => !path.startsWith(DATA_DIR))).toBe(true);
    });

    it('adds the name and description keys to every language file the mod ships', async () => {
        const host = makeHost();
        const result = await apply({ uri: anchorUri(), kind: 'part', name: 'keyed_part', skipRegistration: true }, host);
        expect(result.localizationKeys).toEqual(['Parts/KeyedPart', 'Parts/KeyedPartDesc']);
        expect(result.localizationFiles.sort()).toEqual([`${MOD_DIR}/strings/de.rules`, `${MOD_DIR}/strings/en.rules`]);
        for (const file of result.localizationFiles) {
            const text = read(file);
            expect(text).toContain('KeyedPart = "Keyed Part"');
            expect(text).toContain('KeyedPartDesc = ""');
            // The existing key has to survive, so the second insert was measured against the first.
            expect(text).toContain('Existing =');
        }
    });

    it('creates the file even when the mod ships no language file, and says none were written', async () => {
        const host = makeHost({ folders: [NO_STRINGS] });
        const result = await apply(
            { uri: filePathToUri(`${NO_STRINGS}/mod.rules`), kind: 'part', name: 'unkeyed', skipRegistration: true },
            host
        );
        expect(result.failure).toBeUndefined();
        expect(result.localizationKeys).toEqual(['Parts/Unkeyed', 'Parts/UnkeyedDesc']);
        expect(result.localizationFiles).toEqual([]);
    });

    it('creates the file but registers nothing when no ship was chosen', async () => {
        const host = makeHost();
        const result = await apply({ uri: anchorUri(), kind: 'part', name: 'unchosen' }, host);
        expect(existsSync(result.created)).toBe(true);
        expect(result.registrationFailure).toBe('noShipChosen');
    });

    it('reports the refusal when the client turns the registration edit down', async () => {
        const host = makeHost({ applies: false });
        const result = await apply(
            { uri: anchorUri(), kind: 'part', name: 'rejected', ship: shipKey(await scan(anchorUri(), host), 'ModShip') },
            host
        );
        expect(existsSync(result.created)).toBe(true);
        expect(result.registrationFailure).toBe('editRejected');
    });

    it('refuses a ship whose Parts list only comes from its base', async () => {
        const host = makeHost();
        const result = await apply(
            { uri: anchorUri(), kind: 'part', name: 'inherited_bound', ship: shipKey(await scan(anchorUri(), host), 'Inherited') },
            host
        );
        expect(result.registrationFailure).toBe('partsInherited');
    });

    it('refuses to write an action into a mod that ships only version variants', async () => {
        const host = makeHost({ folders: [TWO_MANIFEST, MOD_DIR] });
        const anchor = filePathToUri(`${TWO_MANIFEST}/mod_0.29.rules`);
        const result = await apply(
            { uri: anchor, kind: 'part', name: 'split_bound', ship: shipKey(await scan(anchor, host), 'Terran') },
            host
        );
        expect(result.registrationFailure).toBe('ambiguousManifest');
        expect(result.manifests?.sort()).toEqual(['mod_0.29.rules', 'mod_0.30.rules']);
    });
});

describe('creating a resource', () => {
    it('registers it with one AddMany into the list the game root names', async () => {
        const host = makeHost();
        const result = await apply({ uri: anchorUri(), kind: 'resource', name: 'Tri Steel' }, host);
        expect(result.failure).toBeUndefined();
        expect(result.created).toBe(`${MOD_DIR}/resources/tri_steel/tri_steel.rules`);
        // A resource is named by a bare word everywhere a part asks for it, never a dotted one.
        expect(result.id).toBe('tri_steel');
        expect(result.route).toBe('manifest');
        expect(result.registeredIn).toBe(`${MOD_DIR}/mod.rules`);

        const written = applyEdits(read(`${MOD_DIR}/mod.rules`), host.changes[filePathToUri(`${MOD_DIR}/mod.rules`)] ?? []);
        const entries = addManyEntries(written, `${MOD_DIR}/mod.rules`);
        expect(entries).toContainEqual({
            target: '<resources/resources.rules>/Resources',
            sources: ['&<resources/tri_steel/tri_steel.rules>'],
        });
        expect(result.localizationKeys).toEqual([
            'Resource/TriSteel',
            'Resource/TriSteelPlural',
            'Resource/TriSteelDesc',
        ]);
    });

    it('does not add a second entry when the manifest already registers the file', async () => {
        const manifest = `${MOD_DIR}/mod.rules`;
        const original = read(manifest);
        writeFileSync(
            manifest,
            original.replace(
                '\nActions\n[\n',
                '\nActions\n[\n\t{\n\t\tAction = AddMany\n\t\tAddTo = "<resources/resources.rules>/Resources"\n\t\tManyToAdd [ &<resources/twice/twice.rules> ]\n\t}\n'
            ),
            'utf-8'
        );
        try {
            clearBaseFileCache();
            const host = makeHost();
            const result = await apply({ uri: anchorUri(), kind: 'resource', name: 'twice' }, host);
            expect(existsSync(result.created)).toBe(true);
            expect(result.registrationFailure).toBe('alreadyRegistered');
            expect(host.changes[filePathToUri(manifest)]).toBeUndefined();
        } finally {
            writeFileSync(manifest, original, 'utf-8');
            clearBaseFileCache();
        }
    });

    it('refuses a manifest whose Actions are an included fragment rather than writing a second one', async () => {
        const host = makeHost({ folders: [FRAGMENT_ACTIONS, MOD_DIR] });
        const result = await apply(
            { uri: filePathToUri(`${FRAGMENT_ACTIONS}/mod.rules`), kind: 'resource', name: 'fragment_bound' },
            host
        );
        expect(existsSync(result.created)).toBe(true);
        expect(result.registrationFailure).toBe('manifestUnusable');
        expect(host.changes[filePathToUri(`${FRAGMENT_ACTIONS}/mod.rules`)]).toBeUndefined();
    });

    it('refuses the registration when the game path is unset, since the target cannot be known', async () => {
        const host = makeHost({ noGameRoot: true });
        const result = await apply({ uri: anchorUri(), kind: 'resource', name: 'rootless' }, host);
        expect(existsSync(result.created)).toBe(true);
        expect(result.registrationFailure).toBe('noGameRoot');
    });
});

describe('creating a shot or a media effect', () => {
    for (const kind of ['bullet', 'mediaEffect'] as ContentKind[]) {
        it(`creates a ${kind} without inventing a registration for it`, async () => {
            const host = makeHost();
            const result = await apply({ uri: anchorUri(), kind, name: 'lonely' }, host);
            expect(result.failure).toBeUndefined();
            expect(existsSync(result.created)).toBe(true);
            expect(result.route).toBe('none');
            expect(result.registrationFailure).toBeUndefined();
            expect(result.registeredIn).toBe('');
            expect(result.pointedAtBy).toBeTruthy();
            // Nothing was written into the manifest, which is the whole point of saying so instead.
            expect(host.changes[filePathToUri(`${MOD_DIR}/mod.rules`)]).toBeUndefined();
        });
    }

    it('hands back the reference a part has to carry, written from the file the author is looking at', async () => {
        const host = makeHost();
        const result = await apply({ uri: anchorUri(), kind: 'bullet', name: 'tri_shot' }, host);
        expect(result.reference).toBe('&<../../shots/tri_shot/tri_shot.rules>');
    });

    it('writes the reference from a folder as the folder, not as a file beside it', async () => {
        const host = makeHost();
        const result = await apply({ uri: filePathToUri(MOD_DIR), kind: 'mediaEffect', name: 'folder_anchored' }, host);
        expect(result.reference).toBe('&<effects/folder_anchored.rules>');
    });
});

describe('creating a logo ship', () => {
    /** A saved ship to copy from, written outside the mod the way a ship from the game's saves is. */
    const savedShip = (name: string): string => {
        const fsPath = `${ROOT}/saves/${name}.ship.png`;
        mkdirSync(dirname(fsPath), { recursive: true });
        writeFileSync(fsPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        return fsPath;
    };

    it('refuses to create one without a saved ship to copy, since there is none to invent', async () => {
        const host = makeHost();
        expect((await apply({ uri: anchorUri(), kind: 'logoShip', name: 'no_source' }, host)).failure).toBe('noSource');
        expect(
            (await apply({ uri: anchorUri(), kind: 'logoShip', name: 'no_source', source: `${ROOT}/nowhere.ship.png` }, host))
                .failure
        ).toBe('noSource');
        // A rules file is not a ship, whatever the client sent it as.
        expect(
            (await apply({ uri: anchorUri(), kind: 'logoShip', name: 'no_source', source: `${MOD_DIR}/mod.rules` }, host))
                .failure
        ).toBe('noSource');
        expect(existsSync(`${MOD_DIR}/gui/no_source.ship.png`)).toBe(false);
    });

    it('copies the ship into gui and points the menu rules at the copy from the manifest', async () => {
        const host = makeHost();
        const source = savedShip('flagship');
        const result = await apply({ uri: anchorUri(), kind: 'logoShip', name: 'My Flagship', source }, host);
        expect(result.failure).toBeUndefined();
        expect(result.created).toBe(`${MOD_DIR}/gui/my_flagship.ship.png`);
        expect(read(result.created)).toEqual(read(source));
        expect(result.id).toBe('');
        expect(result.route).toBe('manifest');
        expect(result.registrationFailure).toBeUndefined();
        expect(result.registeredIn).toBe(`${MOD_DIR}/mod.rules`);
        expect(result.reference).toBe('gui/my_flagship.ship.png');
        expect(result.localizationKeys).toEqual([]);
        expect(result.placeholderAssets).toEqual([]);

        const written = applyEdits(read(`${MOD_DIR}/mod.rules`), host.changes[filePathToUri(`${MOD_DIR}/mod.rules`)] ?? []);
        expect(replaceEntries(written, `${MOD_DIR}/mod.rules`)).toContainEqual({
            target: '<gui/menus.rules>/LogoShip',
            with: 'gui/my_flagship.ship.png',
        });
    });

    it('refuses a second copy under the same name rather than overwriting the first', async () => {
        const host = makeHost();
        const source = savedShip('twice_flagship');
        const first = await apply({ uri: anchorUri(), kind: 'logoShip', name: 'twice', source }, host);
        expect(first.failure).toBeUndefined();
        const second = await apply({ uri: anchorUri(), kind: 'logoShip', name: 'twice', source }, host);
        expect(second.failure).toBe('pathTaken');
    });

    it('points an existing Replace at the new copy rather than adding a second one', async () => {
        const manifest = `${MOD_DIR}/mod.rules`;
        const original = read(manifest);
        writeFileSync(
            manifest,
            original.replace(
                '\nActions\n[\n',
                '\nActions\n[\n\t{\n\t\tAction = Replace\n\t\tReplace = "<gui/menus.rules>/LogoShip"\n\t\tWith = "gui/old_logo.ship.png"\n\t}\n'
            ),
            'utf-8'
        );
        try {
            clearBaseFileCache();
            const host = makeHost();
            const result = await apply(
                { uri: anchorUri(), kind: 'logoShip', name: 'newer', source: savedShip('newer') },
                host
            );
            expect(result.failure).toBeUndefined();
            expect(result.registrationFailure).toBeUndefined();
            expect(result.previousLogo).toBe('gui/old_logo.ship.png');
            expect(result.changedFiles).toEqual([manifest]);
            const written = applyEdits(read(manifest), host.changes[filePathToUri(manifest)] ?? []);
            const logos = replaceEntries(written, manifest).filter((entry) => entry.target === '<gui/menus.rules>/LogoShip');
            expect(logos).toEqual([{ target: '<gui/menus.rules>/LogoShip', with: 'gui/newer.ship.png' }]);
        } finally {
            writeFileSync(manifest, original, 'utf-8');
            clearBaseFileCache();
        }
    });

    it('does not write a second Replace when the manifest already points at the copy', async () => {
        const manifest = `${MOD_DIR}/mod.rules`;
        const original = read(manifest);
        writeFileSync(
            manifest,
            original.replace(
                '\nActions\n[\n',
                '\nActions\n[\n\t{\n\t\tAction = Replace\n\t\tReplace = "<gui/menus.rules>/LogoShip"\n\t\tWith = "gui/prewired.ship.png"\n\t}\n'
            ),
            'utf-8'
        );
        try {
            clearBaseFileCache();
            const host = makeHost();
            const result = await apply(
                { uri: anchorUri(), kind: 'logoShip', name: 'prewired', source: savedShip('prewired') },
                host
            );
            expect(existsSync(result.created)).toBe(true);
            expect(result.registrationFailure).toBe('alreadyRegistered');
            expect(host.changes[filePathToUri(manifest)]).toBeUndefined();
        } finally {
            writeFileSync(manifest, original, 'utf-8');
            clearBaseFileCache();
        }
    });

    it('falls back to the literal menu path when the game root does not name its menus', async () => {
        const host = makeHost();
        const bare = parseText('Resources = &<resources/resources.rules>/Resources\n', GAME_ROOT);
        host.gameRoot = async () => ({
            type: 'File',
            name: 'cosmoteer.rules',
            path: GAME_ROOT,
            content: { name: 'cosmoteer.rules', parsedDocument: bare },
        });
        const result = await apply(
            { uri: anchorUri(), kind: 'logoShip', name: 'fallback', source: savedShip('fallback') },
            host
        );
        expect(result.registrationFailure).toBeUndefined();
        const written = applyEdits(read(`${MOD_DIR}/mod.rules`), host.changes[filePathToUri(`${MOD_DIR}/mod.rules`)] ?? []);
        expect(replaceEntries(written, `${MOD_DIR}/mod.rules`).map((entry) => entry.target)).toContain(
            '<gui/menus.rules>/LogoShip'
        );
    });
});

describe('creating a decal folder', () => {
    it('writes the group file in its own folder and adds the group to the game decal groups', async () => {
        const host = makeHost();
        const result = await apply({ uri: anchorUri(), kind: 'decalFolder', name: 'Tri Shapes' }, host);
        expect(result.failure).toBeUndefined();
        expect(result.created).toBe(`${MOD_DIR}/roof_decals/tri_shapes/decal_group_tri_shapes.rules`);
        expect(existsSync(result.created)).toBe(true);
        expect(result.id).toBe('');
        expect(result.route).toBe('manifest');
        expect(result.registrationFailure).toBeUndefined();
        expect(result.registeredIn).toBe(`${MOD_DIR}/mod.rules`);
        expect(result.reference).toBe('&<../../roof_decals/tri_shapes/decal_group_tri_shapes.rules>/Group');
        expect(result.placeholderAssets).toEqual(['./Data/roof_decals/shapes.png']);

        const text = read(result.created);
        expect(text).toContain('Folders = ["."]');
        expect(text).toContain('NameKey = "DecalGroups/TriShapes"');

        const written = applyEdits(read(`${MOD_DIR}/mod.rules`), host.changes[filePathToUri(`${MOD_DIR}/mod.rules`)] ?? []);
        expect(addManyEntries(written, `${MOD_DIR}/mod.rules`)).toContainEqual({
            target: '<roof_decals/roof_decals.rules>/Groups',
            sources: ['&<roof_decals/tri_shapes/decal_group_tri_shapes.rules>/Group'],
        });
    });

    it('names the group in every language file the mod ships', async () => {
        const host = makeHost();
        const result = await apply({ uri: anchorUri(), kind: 'decalFolder', name: 'keyed_decals' }, host);
        expect(result.localizationKeys).toEqual(['DecalGroups/KeyedDecals']);
        expect(result.localizationFiles.sort()).toEqual([`${MOD_DIR}/strings/de.rules`, `${MOD_DIR}/strings/en.rules`]);
        for (const file of result.localizationFiles) {
            expect(read(file)).toContain('KeyedDecals = "Keyed Decals"');
        }
    });

    it('refuses the registration when the game path is unset, since the decal file cannot be known', async () => {
        const host = makeHost({ noGameRoot: true });
        const result = await apply({ uri: anchorUri(), kind: 'decalFolder', name: 'rootless_decals' }, host);
        expect(existsSync(result.created)).toBe(true);
        expect(result.registrationFailure).toBe('noGameRoot');
    });
});

/** The manifest as the client would have written it after the command's edit. */
const writtenManifest = (host: TestHost): string =>
    applyEdits(read(`${MOD_DIR}/mod.rules`), host.changes[filePathToUri(`${MOD_DIR}/mod.rules`)] ?? []);

/** The named `Add` actions a manifest text carries, as target, name and source reference triples. */
const namedAddEntries = (text: string, fsPath: string): Array<{ target: string; name: string; source: string }> => {
    const entries: Array<{ target: string; name: string; source: string }> = [];
    for (const action of parseModActions(parseText(text, fsPath))) {
        if (action.type !== 'Add' || !action.nameNode) continue;
        const source = action.sources[0];
        entries.push({
            target: String(action.targets[0]?.valueType.value ?? ''),
            name: String(action.nameNode.valueType.value),
            source: source && isValueNode(source) ? String(source.valueType.value) : '',
        });
    }
    return entries;
};

/** Runs the command with an extra action written into the manifest first, and puts the manifest back. */
const withManifestAction = async <T>(entry: string, run: () => Promise<T>): Promise<T> => {
    const manifest = `${MOD_DIR}/mod.rules`;
    const original = read(manifest);
    writeFileSync(manifest, original.replace('\nActions\n[\n', `\nActions\n[\n${entry}`), 'utf-8');
    try {
        clearBaseFileCache();
        return await run();
    } finally {
        writeFileSync(manifest, original, 'utf-8');
        clearBaseFileCache();
    }
};

/** The sprite lines a toggle choice carries, at the depth the template writes them. */
const toggleSprite = (file: string): string =>
    [
        '\t\t\tButtonSprite',
        '\t\t\t{',
        '\t\t\t\tTexture',
        '\t\t\t\t{',
        `\t\t\t\t\tFile = "./Data/gui/game/parts/${file}"`,
        '\t\t\t\t\tMipLevels = 2',
        '\t\t\t\t\tSampleMode = Linear',
        '\t\t\t\t}',
        '\t\t\t}',
    ].join('\n');

describe('creating a toolbar category', () => {
    it('writes the named member, adds it with a named Add and says how a part uses it', async () => {
        const host = makeHost();
        const result = await apply({ uri: anchorUri(), kind: 'editorGroup', name: 'Experimental Weapons' }, host);
        expect(result.failure).toBeUndefined();
        expect(result.created).toBe(`${MOD_DIR}/gui/editor_groups/experimental_weapons.rules`);
        expect(result.id).toBe('ExperimentalWeapons');
        expect(result.route).toBe('manifest');
        expect(result.registrationFailure).toBeUndefined();
        expect(result.registeredIn).toBe(`${MOD_DIR}/mod.rules`);
        // A part writes the id, never a reference to the file, so the id is the reference.
        expect(result.reference).toBe('ExperimentalWeapons');
        expect(result.usage).toBe('Write EditorGroup = "ExperimentalWeapons" in a part to put it in this group.');
        expect(result.placeholderAssets).toEqual(['./Data/gui/game/designer/group_utilities.png']);

        expect(read(result.created)).toBe(
            [
                '// The member name, ExperimentalWeapons, is the id a part writes as its EditorGroup to show up in this',
                '// category of the build toolbar. The sort order puts it between Utilities and Structure.',
                'ExperimentalWeapons',
                '{',
                '\tNameKey = "EditorGroups/ExperimentalWeapons"',
                '\tIcon',
                '\t{',
                '\t\tTexture',
                '\t\t{',
                '\t\t\tFile = "./Data/gui/game/designer/group_utilities.png"',
                '\t\t\tMipLevels = 2',
                '\t\t\tSampleMode = Linear',
                '\t\t}',
                '\t}',
                '\tSortOrder = 950',
                '}',
                '',
            ].join('\n')
        );
        expect(namedAddEntries(writtenManifest(host), `${MOD_DIR}/mod.rules`)).toContainEqual({
            target: '<gui/game/designer/editor_groups.rules>',
            name: 'ExperimentalWeapons',
            source: '&<gui/editor_groups/experimental_weapons.rules>/ExperimentalWeapons',
        });
        expect(result.localizationKeys).toEqual(['EditorGroups/ExperimentalWeapons']);
        for (const file of result.localizationFiles) {
            expect(read(file)).toContain('ExperimentalWeapons = "Experimental Weapons"');
        }
    });

    it('refuses a name the game or the manifest already uses as a group id, whatever its case', async () => {
        expect((await apply({ uri: anchorUri(), kind: 'editorGroup', name: 'structure' }, makeHost())).failure).toBe('idTaken');
        expect(existsSync(`${MOD_DIR}/gui/editor_groups/structure.rules`)).toBe(false);
        const fromManifest = await withManifestAction(
            '\t{\n\t\tAction = Add\n\t\tAddTo = "<gui/game/designer/build_gui.rules>/EditorGroups"\n\t\tName = "Silver"\n\t\tToAdd { NameKey = "EditorGroups/Silver" }\n\t}\n',
            () => apply({ uri: anchorUri(), kind: 'editorGroup', name: 'Silver' }, makeHost())
        );
        expect(fromManifest.failure).toBe('idTaken');
        expect(existsSync(`${MOD_DIR}/gui/editor_groups/silver.rules`)).toBe(false);
    });

    it('refuses a file that is already there and a second creation of the same name', async () => {
        const first = await apply({ uri: anchorUri(), kind: 'editorGroup', name: 'twice group' }, makeHost());
        expect(first.failure).toBeUndefined();
        const second = await apply({ uri: anchorUri(), kind: 'editorGroup', name: 'Twice Group' }, makeHost());
        expect(second.failure).toBe('pathTaken');
    });

    it('refuses the registration when the game path is unset', async () => {
        const result = await apply({ uri: anchorUri(), kind: 'editorGroup', name: 'rootless group' }, makeHost({ noGameRoot: true }));
        expect(existsSync(result.created)).toBe(true);
        expect(result.registrationFailure).toBe('noGameRoot');
    });
});

describe('creating a stat line', () => {
    it('writes the entry, adds it to the game stat list and names its format key', async () => {
        const host = makeHost();
        const result = await apply({ uri: anchorUri(), kind: 'partStat', name: 'Bullet Volley' }, host);
        expect(result.failure).toBeUndefined();
        expect(result.created).toBe(`${MOD_DIR}/gui/stats/bullet_volley.rules`);
        expect(result.id).toBe('BulletVolley');
        expect(result.reference).toBe('BulletVolley');
        expect(result.usage).toBe(
            "Write BulletVolley = <value> inside a part's Stats group, or inside a StatsByCategory entry, and the line appears in its tooltip."
        );
        expect(result.placeholderAssets).toEqual([]);
        expect(read(result.created)).toBe(
            [
                '// A part shows this line in its tooltip once its Stats group writes a value under BulletVolley.',
                'Stat',
                '{',
                '\tID = BulletVolley',
                '\tFormatKey = "Stats/BulletVolleyFmt"',
                '}',
                '',
            ].join('\n')
        );
        expect(addManyEntries(writtenManifest(host), `${MOD_DIR}/mod.rules`)).toContainEqual({
            target: '<gui/game/parts/part_stats.rules>/PartStats',
            sources: ['&<gui/stats/bullet_volley.rules>/Stat'],
        });
        expect(result.localizationKeys).toEqual(['Stats/BulletVolleyFmt']);
        expect(result.localizationFiles.sort()).toEqual([`${MOD_DIR}/strings/de.rules`, `${MOD_DIR}/strings/en.rules`]);
        for (const file of result.localizationFiles) {
            expect(read(file)).toContain('BulletVolleyFmt = "<white>Bullet Volley:</white> <good>{0:0.##}</good>"');
        }
    });

    it('refuses an id the game or the manifest already registers', async () => {
        expect((await apply({ uri: anchorUri(), kind: 'partStat', name: 'crew required' }, makeHost())).failure).toBe('idTaken');
        const fromManifest = await withManifestAction(
            '\t{\n\t\tAction = AddMany\n\t\tAddTo = "<gui/game/parts/part_stats.rules>/PartStats"\n\t\tManyToAdd [ { ID = Prewired; FormatKey = "Stats/PrewiredFmt" } ]\n\t}\n',
            () => apply({ uri: anchorUri(), kind: 'partStat', name: 'prewired' }, makeHost())
        );
        expect(fromManifest.failure).toBe('idTaken');
        expect(existsSync(`${MOD_DIR}/gui/stats/prewired.rules`)).toBe(false);
    });

    it('does not add a second entry when the manifest already adds the file', async () => {
        const result = await withManifestAction(
            '\t{\n\t\tAction = AddMany\n\t\tAddTo = "<gui/game/parts/part_stats.rules>/PartStats"\n\t\tManyToAdd [ &<gui/stats/twice_stat.rules>/Stat ]\n\t}\n',
            async () => {
                const host = makeHost();
                const answer = await apply({ uri: anchorUri(), kind: 'partStat', name: 'twice stat' }, host);
                expect(host.changes[filePathToUri(`${MOD_DIR}/mod.rules`)]).toBeUndefined();
                return answer;
            }
        );
        expect(existsSync(result.created)).toBe(true);
        expect(result.registrationFailure).toBe('alreadyRegistered');
        expect((await apply({ uri: anchorUri(), kind: 'partStat', name: 'twice stat' }, makeHost())).failure).toBe('pathTaken');
    });
});

describe('creating a part toggle', () => {
    it('writes a two-choice switch carrying the author prefix and adds it to the game toggle list', async () => {
        const host = makeHost();
        const result = await apply({ uri: anchorUri(), kind: 'partToggle', name: 'Combat Mode' }, host);
        expect(result.failure).toBeUndefined();
        expect(result.created).toBe(`${MOD_DIR}/gui/toggles/combat_mode.rules`);
        expect(result.id).toBe('test_combat_mode');
        expect(result.reference).toBe('test_combat_mode');
        expect(result.usage).toContain('Type = UIToggle  ToggleID = "test_combat_mode"');
        expect(result.usage).toContain('OperationalToggle');
        expect(result.placeholderAssets).toEqual([
            './Data/gui/game/parts/toggle_power_off.png',
            './Data/gui/game/parts/toggle_power_on.png',
        ]);
        expect(read(result.created)).toBe(
            [
                '// A part carries this toggle through a UIToggle component naming "test_combat_mode", and another',
                '// component of the part has to reference that component to be switched by it.',
                'Toggle',
                '{',
                '\tToggleID = "test_combat_mode"',
                '\tStyle = Switch',
                '\tShowInEditor = true',
                '\tChoices',
                '\t[',
                '\t\t{',
                '\t\t\tChoiceID = "test_combat_mode_off"',
                '\t\t\tButtonToolTipKey = "PartToggles/CombatMode_Off"',
                toggleSprite('toggle_power_off.png'),
                '\t\t}',
                '\t\t{',
                '\t\t\tChoiceID = "test_combat_mode_on"',
                '\t\t\tButtonToolTipKey = "PartToggles/CombatMode_On"',
                toggleSprite('toggle_power_on.png'),
                '\t\t}',
                '\t]',
                '}',
                '',
            ].join('\n')
        );
        expect(addManyEntries(writtenManifest(host), `${MOD_DIR}/mod.rules`)).toContainEqual({
            target: '<gui/game/parts/part_toggles.rules>/PartToggles',
            sources: ['&<gui/toggles/combat_mode.rules>/Toggle'],
        });
        expect(result.localizationKeys).toEqual(['PartToggles/CombatMode_Off', 'PartToggles/CombatMode_On']);
        for (const file of result.localizationFiles) {
            const text = read(file);
            expect(text).toContain(
                'CombatMode_Off = "<b>Combat Mode: <bad>Off</bad></b>\\n\\nHotkey: <btn id=\'PartToggles.test_combat_mode_off\'/>"'
            );
            expect(text).toContain(
                'CombatMode_On = "<b>Combat Mode: <good>On</good></b>\\n\\nHotkey: <btn id=\'PartToggles.test_combat_mode_on\'/>"'
            );
        }
    });

    it('refuses a toggle id or a choice id the game already uses, when the mod has no author prefix', async () => {
        // A manifest with no dotted id gives the toggle the bare name, which is where a clash with
        // the game's own `on_off` and its choice `on_off_on` becomes possible.
        const plain = `${ROOT}/plainmod`;
        mkdirSync(plain, { recursive: true });
        writeFileSync(`${plain}/mod.rules`, 'ID = plainmod\nName = "Plain"\nVersion = 1.0.0\n', 'utf-8');
        const host = makeHost({ folders: [plain, MOD_DIR] });
        const anchor = filePathToUri(`${plain}/mod.rules`);
        expect((await apply({ uri: anchor, kind: 'partToggle', name: 'On Off' }, host)).failure).toBe('idTaken');
        expect((await apply({ uri: anchor, kind: 'partToggle', name: 'on off on' }, host)).failure).toBe('idTaken');
        expect(existsSync(`${plain}/gui`)).toBe(false);
        const free = await apply({ uri: anchor, kind: 'partToggle', name: 'thrust mode' }, host);
        expect(free.failure).toBeUndefined();
        expect(free.id).toBe('thrust_mode');
    });

    it('refuses an id the manifest already registers inline', async () => {
        const result = await withManifestAction(
            '\t{\n\t\tAction = Add\n\t\tAddTo = "<gui/game/parts/part_toggles.rules>/PartToggles"\n\t\tToAdd { ToggleID = "test_inline"; Style = Switch; Choices [ { ChoiceID = "test_inline_choice" } ] }\n\t}\n',
            async () => {
                expect((await apply({ uri: anchorUri(), kind: 'partToggle', name: 'inline choice' }, makeHost())).failure).toBe('idTaken');
                return await apply({ uri: anchorUri(), kind: 'partToggle', name: 'Inline' }, makeHost());
            }
        );
        expect(result.failure).toBe('idTaken');
        expect(existsSync(`${MOD_DIR}/gui/toggles/inline.rules`)).toBe(false);
    });

    it('does not add a second entry when the manifest already adds the file', async () => {
        const result = await withManifestAction(
            '\t{\n\t\tAction = AddMany\n\t\tAddTo = "<gui/game/parts/part_toggles.rules>/PartToggles"\n\t\tManyToAdd [ &<gui/toggles/twice_toggle.rules>/Toggle ]\n\t}\n',
            () => apply({ uri: anchorUri(), kind: 'partToggle', name: 'twice toggle' }, makeHost())
        );
        expect(existsSync(result.created)).toBe(true);
        expect(result.registrationFailure).toBe('alreadyRegistered');
    });
});

/** The `Overrides` actions a manifest text carries, as target and source pairs. */
const overridesEntries = (text: string, fsPath: string): Array<{ target: string; source: string }> => {
    const entries: Array<{ target: string; source: string }> = [];
    for (const action of parseModActions(parseText(text, fsPath))) {
        if (action.type !== 'Overrides') continue;
        const source = action.sources[0];
        entries.push({
            target: String(action.targets[0]?.valueType.value ?? ''),
            source: source && isValueNode(source) ? String(source.valueType.value) : '',
        });
    }
    return entries;
};

describe('creating a buff', () => {
    it('writes the map with the id as its one member, merges it in with an Overrides and says how a part uses it', async () => {
        const host = makeHost();
        const result = await apply({ uri: anchorUri(), kind: 'buff', name: 'Engine Boost' }, host);
        expect(result.failure).toBeUndefined();
        expect(result.created).toBe(`${MOD_DIR}/buffs/engine_boost.rules`);
        // A buff id is the Pascal-case member name the game and the mods write, with no author segment.
        expect(result.id).toBe('EngineBoost');
        expect(result.route).toBe('manifest');
        expect(result.registrationFailure).toBeUndefined();
        expect(result.registeredIn).toBe(`${MOD_DIR}/mod.rules`);
        // A part writes the id as a BuffType, never a reference to the file, so the id is the reference.
        expect(result.reference).toBe('EngineBoost');
        expect(result.usage).toBe(
            "Name it in a part's ReceivableBuffs, provide it with a *BuffProvider component (BuffType = EngineBoost) and read it through a { Type = Buff; BuffType = EngineBoost } modifier."
        );
        expect(result.localizationKeys).toEqual([]);
        expect(result.localizationFiles).toEqual([]);
        expect(result.placeholderAssets).toEqual([]);
        expect(read(result.created)).toBe(
            [
                '// A buff other parts can provide and receive. Parts name it in ReceivableBuffs, provide it with a',
                '// *BuffProvider component and read it with a { Type = Buff; BuffType = EngineBoost } modifier.',
                'EngineBoost',
                '{',
                '\tCombineMode = Add',
                '\tBaseValue = 100%',
                '\tIconTextFormatKey = "BuildBox/BuffPercentageFmt"',
                '\tIconTextMultiply = 100',
                '\tIconTextAdd = -100',
                '\tShowIconTextForZeroValue = false',
                '\tRectBorderColor = [10, 212, 98, 160]',
                '\tRectFillColor = [10, 212, 98, 64]',
                '}',
                '',
            ].join('\n')
        );
        expect(overridesEntries(writtenManifest(host), `${MOD_DIR}/mod.rules`)).toContainEqual({
            target: '<buffs/buffs.rules>',
            source: '&<buffs/engine_boost.rules>',
        });
    });

    it('refuses a name the game already declares as a buff, whatever its case', async () => {
        expect((await apply({ uri: anchorUri(), kind: 'buff', name: 'engine' }, makeHost())).failure).toBe('idTaken');
        expect((await apply({ uri: anchorUri(), kind: 'buff', name: 'Overclock' }, makeHost())).failure).toBe('idTaken');
        expect(existsSync(`${MOD_DIR}/buffs/engine.rules`)).toBe(false);
        expect(existsSync(`${MOD_DIR}/buffs/overclock.rules`)).toBe(false);
    });

    it('refuses a name a manifest Overrides already merges in, written inline or in a referenced file', async () => {
        const inline = await withManifestAction(
            '\t{\n\t\tAction = Overrides\n\t\tOverrideIn = "<./Data/buffs/buffs.rules>"\n\t\tOverrides { Prewired { CombineMode = Add } }\n\t}\n',
            () => apply({ uri: anchorUri(), kind: 'buff', name: 'prewired' }, makeHost())
        );
        expect(inline.failure).toBe('idTaken');
        expect(existsSync(`${MOD_DIR}/buffs/prewired.rules`)).toBe(false);

        const extra = `${MOD_DIR}/buffs/extra_buffs.rules`;
        mkdirSync(dirname(extra), { recursive: true });
        writeFileSync(extra, 'FromFile { CombineMode = Add }\nAnotherOne {}\n', 'utf-8');
        try {
            const fromFile = await withManifestAction(
                '\t{\n\t\tAction = Overrides\n\t\tOverrideIn = "<buffs/buffs.rules>"\n\t\tOverrides = &<buffs/extra_buffs.rules>\n\t}\n',
                () => apply({ uri: anchorUri(), kind: 'buff', name: 'From File' }, makeHost())
            );
            expect(fromFile.failure).toBe('idTaken');
            expect(existsSync(`${MOD_DIR}/buffs/from_file.rules`)).toBe(false);
        } finally {
            rmSync(extra, { force: true });
        }
    });

    it('refuses a file that is already there and a second creation of the same name', async () => {
        const first = await apply({ uri: anchorUri(), kind: 'buff', name: 'twice buff' }, makeHost());
        expect(first.failure).toBeUndefined();
        const second = await apply({ uri: anchorUri(), kind: 'buff', name: 'Twice Buff' }, makeHost());
        expect(second.failure).toBe('pathTaken');
    });

    it('does not add a second Overrides when the manifest already merges the file', async () => {
        const result = await withManifestAction(
            '\t{\n\t\tAction = Overrides\n\t\tOverrideIn = "<buffs/buffs.rules>"\n\t\tOverrides = &<buffs/merged_buff.rules>\n\t}\n',
            async () => {
                const host = makeHost();
                const answer = await apply({ uri: anchorUri(), kind: 'buff', name: 'merged buff' }, host);
                expect(host.changes[filePathToUri(`${MOD_DIR}/mod.rules`)]).toBeUndefined();
                return answer;
            }
        );
        expect(existsSync(result.created)).toBe(true);
        expect(result.registrationFailure).toBe('alreadyRegistered');
    });

    it('refuses the registration when the game path is unset', async () => {
        const result = await apply({ uri: anchorUri(), kind: 'buff', name: 'rootless buff' }, makeHost({ noGameRoot: true }));
        expect(existsSync(result.created)).toBe(true);
        expect(result.registrationFailure).toBe('noGameRoot');
    });
});

describe('creating a codex page', () => {
    it('writes the page in its own folder, appends it to the game tutorials and names its keys', async () => {
        const host = makeHost();
        const result = await apply({ uri: anchorUri(), kind: 'codexPage', name: 'Mining Guide' }, host);
        expect(result.failure).toBeUndefined();
        expect(result.created).toBe(`${MOD_DIR}/codex/mining_guide/mining_guide.rules`);
        // A page id is the plain name, the spelling the game's own pages and the mods' use.
        expect(result.id).toBe('mining_guide');
        expect(result.route).toBe('manifest');
        expect(result.registrationFailure).toBeUndefined();
        expect(result.registeredIn).toBe(`${MOD_DIR}/mod.rules`);
        expect(result.reference).toBe('&<../../codex/mining_guide/mining_guide.rules>');
        expect(result.usage).toBe(
            'Give it a ShowCondition or TempShowCondition, such as "? game.HasPartCategoryInHand(\'<category>\')", to have the HUD offer it, since without one it is listed in the codex only.'
        );
        expect(result.placeholderAssets).toEqual([]);
        expect(read(result.created)).toBe(
            [
                '// A help page for the mod, listed under the Tutorials tab of the codex. The texts are keys in the',
                '// language files. Give it a ShowCondition or TempShowCondition to have the HUD offer it, such as',
                '// TempShowCondition = "? game.HasPartCategoryInHand(\'<category>\')"',
                'ID = mining_guide',
                'TitleKey = "Tutorials/MiningGuide/Title"',
                'TabNameKey = "Codex/Tutorials"',
                'Entries',
                '[',
                '\t{ TextKey = "Tutorials/MiningGuide/Text1" }',
                '\t{ TextKey = "Tutorials/MiningGuide/Text2" }',
                ']',
                '',
            ].join('\n')
        );
        expect(addManyEntries(writtenManifest(host), `${MOD_DIR}/mod.rules`)).toContainEqual({
            target: '<codex/tutorials/tutorials.rules>/CodexPages',
            sources: ['&<codex/mining_guide/mining_guide.rules>'],
        });
        expect(result.localizationKeys).toEqual([
            'Tutorials/MiningGuide/Title',
            'Tutorials/MiningGuide/Text1',
            'Tutorials/MiningGuide/Text2',
        ]);
        expect(result.localizationFiles.sort()).toEqual([`${MOD_DIR}/strings/de.rules`, `${MOD_DIR}/strings/en.rules`]);
        for (const file of result.localizationFiles) {
            const text = read(file);
            expect(text).toContain('Title = "Mining Guide"');
            expect(text).toContain('Text1 = "Write this part of the help here."');
            expect(text).toContain('Text2 = "Write this part of the help here."');
        }
    });

    it('refuses a folder that is already there and a second creation of the same name', async () => {
        const first = await apply({ uri: anchorUri(), kind: 'codexPage', name: 'twice page' }, makeHost());
        expect(first.failure).toBeUndefined();
        const second = await apply({ uri: anchorUri(), kind: 'codexPage', name: 'Twice Page' }, makeHost());
        expect(second.failure).toBe('pathTaken');
    });

    it('does not add a second entry when the manifest already adds the page', async () => {
        const result = await withManifestAction(
            '\t{\n\t\tAction = AddMany\n\t\tAddTo = "<./Data/codex/tutorials/tutorials.rules>/CodexPages"\n\t\tManyToAdd [ &<codex/listed_page/listed_page.rules> ]\n\t}\n',
            async () => {
                const host = makeHost();
                const answer = await apply({ uri: anchorUri(), kind: 'codexPage', name: 'listed page' }, host);
                expect(host.changes[filePathToUri(`${MOD_DIR}/mod.rules`)]).toBeUndefined();
                return answer;
            }
        );
        expect(existsSync(result.created)).toBe(true);
        expect(result.registrationFailure).toBe('alreadyRegistered');
    });

    it('refuses the registration when the game path is unset', async () => {
        const result = await apply({ uri: anchorUri(), kind: 'codexPage', name: 'rootless page' }, makeHost({ noGameRoot: true }));
        expect(existsSync(result.created)).toBe(true);
        expect(result.registrationFailure).toBe('noGameRoot');
    });
});

describe('what the command refuses to create', () => {
    it('refuses a file that belongs to no mod', async () => {
        const result = await apply({ uri: filePathToUri(LOOSE), kind: 'part', name: 'orphan' }, makeHost());
        expect(result.failure).toBe('noModRoot');
        expect(result.created).toBe('');
    });

    it('refuses somebody else installed workshop mod', async () => {
        for (const allowed of [false, true]) {
            globalSettings.allowEditingVanillaFiles = allowed;
            const result = await apply(
                { uri: filePathToUri(WORKSHOP_PART), kind: 'part', name: 'intruder' },
                makeHost()
            );
            expect(result.failure, `the workshop tree was writable with the setting ${allowed}`).toBe('notEditable');
        }
    });

    it('refuses the game data by default, and lets the setting open it', async () => {
        const vanilla = filePathToUri(`${DATA_DIR}/ships/terran/corridor/corridor.rules`);
        globalSettings.allowEditingVanillaFiles = false;
        expect((await scan(vanilla, makeHost())).failure).toBe('notEditable');
        globalSettings.allowEditingVanillaFiles = true;
        clearModRootCache();
        expect((await scan(vanilla, makeHost())).failure).toBeUndefined();
    });

    it('refuses a name that leaves nothing usable behind', async () => {
        for (const name of ['   ', '***', '2x2']) {
            const result = await apply({ uri: anchorUri(), kind: 'part', name }, makeHost());
            expect(result.failure, `"${name}" was accepted`).toBe('invalidName');
        }
    });

    it('refuses a folder that is already there rather than writing into it', async () => {
        const result = await apply({ uri: anchorUri(), kind: 'part', name: 'taken part' }, makeHost());
        expect(result.failure).toBe('pathTaken');
        // The existing part is untouched.
        expect(read(`${MOD_DIR}/parts/taken_part/taken_part.rules`)).toContain('ID = test.taken_part');
    });

    it('refuses an id the mod already declares, even from a differently named folder', async () => {
        const result = await apply({ uri: anchorUri(), kind: 'part', name: 'colliding' }, makeHost());
        expect(result.failure).toBe('idTaken');
        expect(existsSync(`${MOD_DIR}/parts/colliding`)).toBe(false);
    });

    it('refuses an id the wider project declares, when the host can answer for the whole project', async () => {
        const host = makeHost({ ids: { 'Cosmoteer.Ships.Parts.PartRules': ['test.from_vanilla'] } });
        const result = await apply({ uri: anchorUri(), kind: 'part', name: 'from_vanilla' }, host);
        expect(result.failure).toBe('idTaken');
    });

    it('refuses a kind it does not know', async () => {
        const result = await apply(
            { uri: anchorUri(), kind: 'starship' as ContentKind, name: 'whatever' },
            makeHost()
        );
        expect(result.failure).toBe('unknownKind');
    });
});

describe('how a created file matches the mod around it', () => {
    it('writes the line ending the mod already uses', async () => {
        const manifest = `${MOD_DIR}/mod.rules`;
        const original = read(manifest);
        writeFileSync(manifest, original.replace(/\r?\n/g, '\r\n'), 'utf-8');
        try {
            clearBaseFileCache();
            const result = await apply(
                { uri: anchorUri(), kind: 'part', name: 'crlf_part', skipRegistration: true },
                makeHost()
            );
            const text = read(result.created);
            expect(text).toContain('\r\n');
            expect(text.replace(/\r\n/g, '')).not.toContain('\n');
        } finally {
            writeFileSync(manifest, original, 'utf-8');
            clearBaseFileCache();
        }
    });

    it('announces the created file so the indexes pick it up without waiting for a watcher', async () => {
        const host = makeHost();
        const result = await apply(
            { uri: anchorUri(), kind: 'mediaEffect', name: 'announced', skipRegistration: true },
            host
        );
        expect(host.announced).toContain(result.created);
    });
});

describe('the registration target the game root names', () => {
    it('reads a registry the game root reaches by reference, and one it holds itself', () => {
        const document = parseText(read(GAME_ROOT), GAME_ROOT);
        expect(gameRootListTarget(document, GAME_ROOT, DATA_DIR, 'Resources')).toBe(
            '<resources/resources.rules>/Resources'
        );
        expect(gameRootListTarget(document, GAME_ROOT, DATA_DIR, 'Ships')).toBe('<cosmoteer.rules>/Ships');
        expect(gameRootListTarget(document, GAME_ROOT, DATA_DIR, 'NothingLikeThis')).toBeUndefined();
    });

    it('picks the plain manifest, refuses a version split and reports a mod with none', () => {
        expect(manifestForRegistration(MOD_DIR)).toEqual({ kind: 'manifest', fsPath: `${MOD_DIR}/mod.rules` });
        expect(manifestForRegistration(TWO_MANIFEST)).toEqual({
            kind: 'ambiguous',
            manifests: ['mod_0.29.rules', 'mod_0.30.rules'],
        });
        expect(manifestForRegistration(`${ROOT}/loose`)).toEqual({ kind: 'none' });
    });
});

/** The scan round's key for a ship, so the apply round names the very same one. */
function shipKey(result: NewContentScanResult, groupName: string): string {
    const ship = result.ships.find((candidate) => candidate.groupName === groupName);
    if (!ship) throw new Error(`the scan reported no ship named ${groupName}`);
    return ship.key;
}

/** Apply captured edits to a text, so what the client would have written can be read back. */
function applyEdits(text: string, edits: readonly TextEdit[]): string {
    const document = TextDocument.create('file:///x', 'rules', 0, text);
    return TextDocument.applyEdits(document, [...edits]);
}
