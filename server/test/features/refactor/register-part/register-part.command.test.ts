import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CancellationToken, TextEdit } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { isGroupNode, isListNode } from '../../../../src/core/ast/ast';
import { filePathToUri } from '../../../../src/features/navigation/navigation-strategy';
import {
    RegisterPartApplyResult,
    RegisterPartArgs,
    RegisterPartHost,
    RegisterPartScanResult,
    registerPartInShip,
} from '../../../../src/features/refactor/register-part/register-part.command';
import { shipEntryKey } from '../../../../src/features/refactor/register-part/ship-registry';
import { clearBaseFileCache } from '../../../../src/features/refactor/shared-base/base-index';
import { parseModActions } from '../../../../src/mod/action-parser';
import { clearModRootCache } from '../../../../src/mod/mod-root';
import { globalSettings } from '../../../../src/settings';
import { parseText } from '../../../../src/utils/ast.utils';
import { CosmoteerWorkspaceData, FileWithPath } from '../../../../src/workspace/cosmoteer-workspace.service';
import { FIXTURES_DIR } from '../../../helpers';

// The command itself: the two rounds of the exchange against a stand-in game install, so both the
// "edit the ship" and the "patch it from the manifest" routes are exercised without a real game.
const FIXTURE = join(FIXTURES_DIR, 'register-part-mod').replace(/\\/g, '/');
const DATA_DIR = `${FIXTURE}/Data`;
const GAME_ROOT = `${DATA_DIR}/cosmoteer.rules`;
const MOD_DIR = `${FIXTURE}/mod`;
const TERRAN = `${DATA_DIR}/ships/terran/terran.rules`;
const MOD_SHIP = `${MOD_DIR}/ships/modship.rules`;
const BROKEN_SHIP = `${MOD_DIR}/ships/broken.rules`;
const NEW_PART = `${MOD_DIR}/parts/new_part.rules`;
const ANONYMOUS_PART = `${MOD_DIR}/parts/anonymous_part.rules`;
const NOT_A_PART = `${MOD_DIR}/parts/not_a_part.rules`;
const CORRIDOR = `${DATA_DIR}/ships/terran/corridor/corridor.rules`;
const REACTOR = `${DATA_DIR}/ships/terran/reactor/reactor.rules`;
const LISTED_PART = `${FIXTURE}/registered/parts/listed_part.rules`;
const SPLIT_PART = `${FIXTURE}/twomanifest/parts/split_part.rules`;

const read = (path: string): string => readFileSync(path, { encoding: 'utf-8' });

/** The parsed stand-in game root, in the shape the workspace service hands the command. */
const gameRootFile = (): FileWithPath => {
    const text = read(GAME_ROOT);
    const content: CosmoteerWorkspaceData = { name: 'cosmoteer.rules', parsedDocument: parseText(text, GAME_ROOT) };
    return { type: 'File', name: 'cosmoteer.rules', path: GAME_ROOT, content };
};

/** A host whose edits are captured instead of applied, so the fixture files are never written to. */
const makeHost = (
    options: { folders?: string[]; open?: TextDocument[]; applies?: boolean } = {}
): RegisterPartHost & { changes: Record<string, TextEdit[]>; announced: string[] } => ({
    changes: {},
    announced: [],
    folderPaths: async () => options.folders ?? [MOD_DIR],
    openDocuments: () => options.open ?? [],
    gameRoot: async () => gameRootFile(),
    dataRoot: () => DATA_DIR,
    applyEdit(changes) {
        Object.assign(this.changes, changes);
        return Promise.resolve(options.applies ?? true);
    },
    filesChanged(paths) {
        this.announced.push(...paths);
    },
});

/** The command's scan round for a part, asserting it answered with candidates. */
const scan = async (uri: string, offset: number, host: RegisterPartHost): Promise<RegisterPartScanResult> => {
    const result = await registerPartInShip({ uri, offset }, host, CancellationToken.None);
    if (result.kind !== 'scan') throw new Error('expected the scan round');
    return result;
};

/** The command's apply round, asserting it answered as an apply. */
const apply = async (args: RegisterPartArgs, host: RegisterPartHost): Promise<RegisterPartApplyResult> => {
    const result = await registerPartInShip(args, host, CancellationToken.None);
    if (result.kind !== 'apply') throw new Error('expected the apply round');
    return result;
};

/** The offset of a part group's name, which is what the code action anchors the offer on. */
const partOffset = (path: string): number => read(path).indexOf('Part\n');

let wasAllowed: boolean;

beforeEach(() => {
    clearBaseFileCache();
    clearModRootCache();
    wasAllowed = globalSettings.allowEditingVanillaFiles;
    globalSettings.allowEditingVanillaFiles = false;
});

afterEach(() => {
    globalSettings.allowEditingVanillaFiles = wasAllowed;
    clearModRootCache();
});

describe('the register-part scan round', () => {
    it('reports the game registry ships and the mod-added ones, each with its route', async () => {
        const result = await scan(NEW_PART, partOffset(NEW_PART), makeHost());
        expect(result.partGroupName).toBe('Part');
        expect(result.partId).toBe('test.new_part');
        const byName = new Map(result.candidates.map((candidate) => [candidate.groupName, candidate]));
        expect([...byName.keys()]).toEqual(['Terran', 'Inherited', 'ModShip', 'Broken']);
        expect(byName.get('Terran')).toMatchObject({ target: 'vanilla', via: 'modAction', alreadyRegistered: false });
        expect(byName.get('Terran')?.blocked).toBeUndefined();
        expect(byName.get('Terran')?.id).toBe('cosmoteer.terran');
        expect(byName.get('ModShip')).toMatchObject({ target: 'workspace', via: 'shipFile' });
    });

    it('refuses a ship that only inherits its Parts list', async () => {
        const result = await scan(NEW_PART, partOffset(NEW_PART), makeHost());
        expect(result.candidates.find((candidate) => candidate.groupName === 'Inherited')?.blocked).toBe(
            'partsInherited'
        );
    });

    it('reports a part the ship already lists, so the client can say so before asking', async () => {
        globalSettings.allowEditingVanillaFiles = true;
        const result = await scan(CORRIDOR, partOffset(CORRIDOR), makeHost());
        expect(result.candidates.find((candidate) => candidate.groupName === 'Terran')?.alreadyRegistered).toBe(true);
    });

    it('reports a part an existing manifest action already adds to that ship', async () => {
        const result = await scan(LISTED_PART, partOffset(LISTED_PART), makeHost());
        const terran = result.candidates.find((candidate) => candidate.groupName === 'Terran');
        expect(terran?.via).toBe('modAction');
        expect(terran?.alreadyRegistered).toBe(true);
    });

    it('answers stale when the offset no longer names a part group', async () => {
        const result = await scan(NOT_A_PART, 0, makeHost());
        expect(result.failure).toBe('stale');
        expect(result.candidates).toEqual([]);
    });
});

describe('the register-part apply round, ship file route', () => {
    it('appends the part to a workspace ship own Parts list', async () => {
        const host = makeHost();
        const key = shipEntryKey(MOD_SHIP, 'ModShip');
        const result = await apply({ uri: NEW_PART, offset: partOffset(NEW_PART), ship: key }, host);
        expect(result.failure).toBeUndefined();
        expect(result.via).toBe('shipFile');
        expect(result.reference).toBe('&<../parts/new_part.rules>/Part');
        expect(result.changedFiles.map((path) => path.toLowerCase())).toEqual([MOD_SHIP.toLowerCase()]);
        expect(host.announced.map((path) => path.toLowerCase())).toEqual([MOD_SHIP.toLowerCase()]);

        const before = read(MOD_SHIP);
        const document = TextDocument.create(filePathToUri(MOD_SHIP), 'rules', 0, before);
        const after = TextDocument.applyEdits(document, host.changes[document.uri]);
        const ship = parseText(after, MOD_SHIP).elements[0];
        const parts = isGroupNode(ship)
            ? ship.elements.find((element) => isListNode(element) && element.identifier?.name === 'Parts')
            : undefined;
        expect(isListNode(parts) && parts.elements).toHaveLength(1);
        expect(after).toContain('&<../parts/new_part.rules>/Part');
    });

    it('computes the insertion against the open buffer, never the bytes on disk', async () => {
        const buffer = TextDocument.create(
            filePathToUri(MOD_SHIP),
            'rules',
            1,
            ['ModShip', '{', '\tID = test.modship', '', '\tParts', '\t[', '\t\t&<../parts/anonymous_part.rules>/Part', '\t]', '}', ''].join(
                '\n'
            )
        );
        const host = makeHost({ open: [buffer] });
        const result = await apply(
            { uri: NEW_PART, offset: partOffset(NEW_PART), ship: shipEntryKey(MOD_SHIP, 'ModShip') },
            host
        );
        expect(result.failure).toBeUndefined();
        const after = TextDocument.applyEdits(buffer, host.changes[buffer.uri]);
        expect(after).toContain('\t\t&<../parts/anonymous_part.rules>/Part\n\t\t&<../parts/new_part.rules>/Part');
    });

    it('registers a part that declares no ID, and says so', async () => {
        const host = makeHost();
        const result = await apply(
            { uri: ANONYMOUS_PART, offset: partOffset(ANONYMOUS_PART), ship: shipEntryKey(MOD_SHIP, 'ModShip') },
            host
        );
        expect(result.failure).toBeUndefined();
        expect(result.warning).toBe('noPartId');
    });

    it('refuses a Parts list whose brackets are not where the parse says, rather than editing past them', async () => {
        const host = makeHost();
        const result = await apply(
            { uri: NEW_PART, offset: partOffset(NEW_PART), ship: shipEntryKey(BROKEN_SHIP, 'Broken') },
            host
        );
        expect(result.failure).toBe('notEditable');
        expect(host.changes).toEqual({});
    });

    it('edits the game own ship file once the vanilla-editing switch says so', async () => {
        globalSettings.allowEditingVanillaFiles = true;
        const host = makeHost();
        const result = await apply(
            { uri: REACTOR, offset: partOffset(REACTOR), ship: shipEntryKey(TERRAN, 'Terran') },
            host
        );
        expect(result.failure).toBeUndefined();
        expect(result.via).toBe('shipFile');
        expect(result.reference).toBe('&<reactor/reactor.rules>/Part');
        expect(result.changedFiles.map((path) => path.toLowerCase())).toEqual([TERRAN.toLowerCase()]);
    });

    it('refuses a part the ship already lists', async () => {
        globalSettings.allowEditingVanillaFiles = true;
        const host = makeHost();
        const result = await apply(
            { uri: CORRIDOR, offset: partOffset(CORRIDOR), ship: shipEntryKey(TERRAN, 'Terran') },
            host
        );
        expect(result.failure).toBe('alreadyRegistered');
        expect(host.changes).toEqual({});
    });
});

describe('the register-part apply round, mod manifest route', () => {
    it('writes an AddMany into the mod manifest and leaves the game file untouched', async () => {
        const host = makeHost();
        const manifest = `${MOD_DIR}/mod.rules`;
        const result = await apply(
            { uri: NEW_PART, offset: partOffset(NEW_PART), ship: shipEntryKey(TERRAN, 'Terran') },
            host
        );
        expect(result.failure).toBeUndefined();
        expect(result.via).toBe('modAction');
        expect(result.reference).toBe('&<parts/new_part.rules>/Part');
        expect(result.changedFiles.map((path) => path.toLowerCase())).toEqual([manifest.toLowerCase()]);
        // Only the manifest is edited: the game install is never written to on this route.
        expect(Object.keys(host.changes)).toEqual([filePathToUri(manifest)]);

        const before = read(manifest);
        const document = TextDocument.create(filePathToUri(manifest), 'rules', 0, before);
        const after = TextDocument.applyEdits(document, host.changes[document.uri]);
        const actions = parseModActions(parseText(after, manifest));
        expect(actions).toHaveLength(2);
        expect(actions[1].type).toBe('AddMany');
        expect(actions[1].targets.map((node) => String(node.valueType.value))).toEqual([
            '<ships/terran/terran.rules>/Terran/Parts',
        ]);
        expect(after).toContain('&<parts/new_part.rules>/Part');
    });

    it('refuses a part an existing manifest action already adds to that ship', async () => {
        const host = makeHost({ folders: [`${FIXTURE}/registered`] });
        const result = await apply(
            { uri: LISTED_PART, offset: partOffset(LISTED_PART), ship: shipEntryKey(TERRAN, 'Terran') },
            host
        );
        expect(result.failure).toBe('alreadyRegistered');
        expect(host.changes).toEqual({});
    });

    it('refuses a mod with several manifests and none of them named mod.rules', async () => {
        const host = makeHost();
        const result = await apply(
            { uri: SPLIT_PART, offset: partOffset(SPLIT_PART), ship: shipEntryKey(TERRAN, 'Terran') },
            host
        );
        expect(result.failure).toBe('ambiguousManifest');
        expect(result.manifests).toEqual(['mod_0.29.rules', 'mod_0.30.rules']);
        expect(host.changes).toEqual({});
    });

    it('refuses a part in no mod at all while the vanilla-editing switch is off', async () => {
        const host = makeHost();
        const result = await apply(
            { uri: REACTOR, offset: partOffset(REACTOR), ship: shipEntryKey(TERRAN, 'Terran') },
            host
        );
        expect(result.failure).toBe('noModRoot');
        expect(host.changes).toEqual({});
    });

    it('answers stale rather than registering whatever now sits at the offset', async () => {
        const host = makeHost();
        const result = await apply({ uri: NOT_A_PART, offset: 0, ship: shipEntryKey(TERRAN, 'Terran') }, host);
        expect(result.failure).toBe('stale');
        expect(host.changes).toEqual({});
    });

    it('answers unknownShip when the picked ship is no longer registered', async () => {
        const host = makeHost();
        const result = await apply(
            { uri: NEW_PART, offset: partOffset(NEW_PART), ship: shipEntryKey(`${MOD_DIR}/ships/gone.rules`, 'Gone') },
            host
        );
        expect(result.failure).toBe('unknownShip');
    });

    it('reports the editor turning the edit down', async () => {
        const host = makeHost({ applies: false });
        const result = await apply(
            { uri: NEW_PART, offset: partOffset(NEW_PART), ship: shipEntryKey(MOD_SHIP, 'ModShip') },
            host
        );
        expect(result.failure).toBe('editRejected');
        expect(host.announced).toEqual([]);
    });
});
