import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
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

    it('reports all four kinds with the folder each goes in and how each one is wired in', async () => {
        const result = await scan(anchorUri(), makeHost());
        expect(result.kinds.map((info) => [info.kind, info.folder, info.registration])).toEqual([
            ['part', 'parts', 'ship'],
            ['resource', 'resources', 'manifest'],
            ['bullet', 'shots', 'none'],
            ['mediaEffect', 'effects', 'none'],
        ]);
    });

    it('says plainly, before anything is created, that nothing will reach a shot or an effect', async () => {
        const result = await scan(anchorUri(), makeHost());
        const byKind = new Map(result.kinds.map((info) => [info.kind, info]));
        expect(byKind.get('bullet')?.pointedAtBy).toContain('Nothing reaches this shot yet');
        expect(byKind.get('mediaEffect')?.pointedAtBy).toContain('Nothing reaches this effect yet');
        expect(byKind.get('part')?.pointedAtBy).toBeUndefined();
        expect(byKind.get('resource')?.pointedAtBy).toBeUndefined();
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
