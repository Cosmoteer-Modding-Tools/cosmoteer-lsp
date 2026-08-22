import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CancellationToken, TextEdit } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { LocalizationText } from '../../../../src/features/completion/localization-key.index';
import {
    CloneApplyResult,
    CloneDeclarationArgs,
    CloneHost,
    ClonePreviewResult,
    CloneScanResult,
    cloneDeclaration,
    proposeCloneId,
} from '../../../../src/features/refactor/clone-declaration/clone.command';
import { filePathToUri } from '../../../../src/features/navigation/navigation-strategy';
import { clearModRootCache } from '../../../../src/mod/mod-root';
import { globalSettings } from '../../../../src/settings';
import { FIXTURES_DIR } from '../../../helpers';

// The command end to end, against a throwaway copy of the fixture so the checked-in files are never
// written to. Preview must leave the disk exactly as it found it, apply must write the whole copy or
// none of it, and every refusal must reach the client as a reason rather than as a half-done copy.
let ROOT = '';
let DATA = '';
let MOD = '';
let CANNON = '';

const read = (path: string): string => readFileSync(path, { encoding: 'utf-8' });

const TEXTS: Record<string, LocalizationText[]> = {
    'Parts/Cannon': [
        { language: 'English', text: 'Medium Cannon' },
        { language: 'Deutsch', text: 'Mittlere Kanone' },
    ],
};

/** A host whose edits are captured rather than applied, so nothing depends on a real client. */
const makeHost = (
    options: { open?: TextDocument[]; applies?: boolean; declared?: string[] } = {}
): CloneHost & { changes: Record<string, TextEdit[]>; announced: string[] } => ({
    changes: {},
    announced: [],
    folderPaths: async () => [MOD],
    openDocuments: () => options.open ?? [],
    applyEdit(changes) {
        Object.assign(this.changes, changes);
        return Promise.resolve(options.applies ?? true);
    },
    declaredIds: async () => new Set(options.declared ?? []),
    declaredKeys: async () => new Set<string>(),
    localizationTexts: async (key) => TEXTS[key] ?? [],
    dataRoot: () => DATA,
    filesChanged(paths) {
        this.announced.push(...paths);
    },
});

/** The command's report round, asserting it answered as one. */
const scan = async (args: CloneDeclarationArgs, host: CloneHost): Promise<CloneScanResult> => {
    const result = await cloneDeclaration(args, host, CancellationToken.None);
    if (result.kind !== 'scan') throw new Error('expected the report round');
    return result;
};

/** The command's preview round. */
const preview = async (args: CloneDeclarationArgs, host: CloneHost): Promise<ClonePreviewResult> => {
    const result = await cloneDeclaration({ ...args, preview: true }, host, CancellationToken.None);
    if (result.kind !== 'preview') throw new Error('expected the preview round');
    return result;
};

/** The command's apply round. */
const apply = async (args: CloneDeclarationArgs, host: CloneHost): Promise<CloneApplyResult> => {
    const result = await cloneDeclaration(args, host, CancellationToken.None);
    if (result.kind !== 'apply') throw new Error('expected the apply round');
    return result;
};

/** The arguments naming the cannon's own `ID`, which is what the lightbulb would carry. */
const atCannonId = (): CloneDeclarationArgs => ({
    uri: filePathToUri(CANNON),
    offset: read(CANNON).indexOf('cosmoteer.cannon'),
});

let wasAllowed: boolean;

beforeAll(() => {
    ROOT = mkdtempSync(join(tmpdir(), 'cosmoteer-clone-')).replace(/\\/g, '/');
    cpSync(join(FIXTURES_DIR, 'clone-declaration-mod'), ROOT, { recursive: true });
    DATA = `${ROOT}/Data`;
    MOD = `${ROOT}/mod`;
    CANNON = `${DATA}/ships/terran/cannon/cannon.rules`;
});

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

beforeEach(() => {
    clearModRootCache();
    wasAllowed = globalSettings.allowEditingVanillaFiles;
    globalSettings.allowEditingVanillaFiles = false;
});

afterEach(() => {
    globalSettings.allowEditingVanillaFiles = wasAllowed;
    clearModRootCache();
});

describe('the report round', () => {
    it('says how much would be copied, where it would land and what to call it', async () => {
        const result = await scan(atCannonId(), makeHost());
        expect(result).toMatchObject({ id: 'cosmoteer.cannon', identityKey: 'ID', unit: 'directory', files: 4 });
        expect(result.modRoots).toEqual([MOD]);
        expect(result.proposedId).toBe('cannon_copy');
    });

    it('drops the game s own author prefix from the proposed id, which its files ask mods not to use', () => {
        expect(proposeCloneId('cosmoteer.cannon_med', new Set())).toBe('cannon_med_copy');
        expect(proposeCloneId('me.cannon', new Set())).toBe('me.cannon_copy');
        expect(proposeCloneId('me.cannon', new Set(['ME.CANNON_COPY']))).toBe('me.cannon_copy2');
    });

    it('reports the refusal rather than a report when the caret anchors nothing', async () => {
        const smoke = `${DATA}/ships/terran/cannon/particles/smoke.rules`;
        const result = await scan({ uri: filePathToUri(smoke), offset: 0 }, makeHost());
        expect(result.failure).toBe('noDeclaration');
    });
});

describe('the preview round', () => {
    it('shows every file the copy would write and changes nothing on disk', async () => {
        const before = read(CANNON);
        const result = await preview({ ...atCannonId(), newId: 'me.big_cannon' }, makeHost());
        expect(result.failure).toBeUndefined();
        expect(result.destinationDir).toBe(`${MOD}/ships/terran/big_cannon`);
        expect(result.writes.map((path) => path.slice(ROOT.length + 1)).sort()).toEqual([
            'mod/ships/terran/big_cannon/big_cannon.rules',
            'mod/ships/terran/big_cannon/icon.png',
            'mod/ships/terran/big_cannon/particles/smoke.rules',
            'mod/ships/terran/big_cannon/upgrade.rules',
            'mod/strings/deutsch.rules',
            'mod/strings/english.rules',
            'mod/strings/french.rules',
        ]);
        // The sprite has no text to diff, so it is named as a plain copy instead.
        expect(result.copied).toEqual([`${MOD}/ships/terran/big_cannon/icon.png`]);
        expect(result.diff).toContain('ID = me.big_cannon');
        expect(result.droppedOtherIds).toEqual(['[old_cannon]']);
        expect(result.keys).toEqual([
            { from: 'Parts/Cannon', to: 'Parts/BigCannon' },
            { from: 'Parts/CannonIcon', to: 'Parts/BigCannonIcon' },
            { from: 'Parts/CannonDesc', to: 'Parts/BigCannonDesc' },
        ]);
        expect(existsSync(`${MOD}/ships/terran/big_cannon`)).toBe(false);
        expect(read(CANNON)).toBe(before);
    });

    it('answers a refusal in the shape the client asked for', async () => {
        const result = await preview({ ...atCannonId(), newId: 'not a valid id' }, makeHost());
        expect(result.failure).toBe('invalidId');
        expect(result.writes).toEqual([]);
    });
});

describe('the apply round', () => {
    it('writes the whole copy, the sprites and the language files with it', async () => {
        const host = makeHost();
        const result = await apply({ ...atCannonId(), newId: 'me.applied_cannon' }, host);
        expect(result.failure).toBeUndefined();
        const dir = `${MOD}/ships/terran/applied_cannon`;
        expect(result.created).toBe(`${dir}/applied_cannon.rules`);
        expect(existsSync(`${dir}/icon.png`)).toBe(true);
        expect(read(`${dir}/applied_cannon.rules`)).toContain('ID = me.applied_cannon');
        expect(read(`${dir}/applied_cannon.rules`)).toContain('Part : <./Data/ships/terran/base_part.rules>/Part');
        expect(read(`${dir}/upgrade.rules`)).toContain('EditorParentParts = [me.applied_cannon]');
        expect(read(`${MOD}/strings/english.rules`)).toContain('AppliedCannon = "Medium Cannon"');
        expect(read(`${MOD}/strings/deutsch.rules`)).toContain('AppliedCannon = "Mittlere Kanone"');
        // Nothing the copy came from is touched.
        expect(read(CANNON)).toContain('ID = cosmoteer.cannon');
        expect(host.announced).toContain(`${dir}/applied_cannon.rules`);
        // Nothing went through the editor, because nothing the copy writes was open.
        expect(host.changes).toEqual({});
    });

    it('routes a file the user already has open through the editor instead of writing behind its back', async () => {
        const strings = `${MOD}/strings/english.rules`;
        const buffer = TextDocument.create(filePathToUri(strings), 'rules', 1, read(strings));
        const host = makeHost({ open: [buffer] });
        const result = await apply({ ...atCannonId(), newId: 'me.open_cannon' }, host);
        expect(result.failure).toBeUndefined();
        expect(result.changedFiles).toEqual([strings]);
        expect(Object.keys(host.changes)).toEqual([buffer.uri]);
        // The buffer is the client's to change, so the file on disk still says what it said.
        expect(read(strings)).not.toContain('OpenCannon');
    });

    it('takes the whole copy away again when the editor turns the edit down', async () => {
        const strings = `${MOD}/strings/english.rules`;
        const buffer = TextDocument.create(filePathToUri(strings), 'rules', 1, read(strings));
        const host = makeHost({ open: [buffer], applies: false });
        const result = await apply({ ...atCannonId(), newId: 'me.rejected_cannon' }, host);
        expect(result.failure).toBe('editRejected');
    });

    it('takes the created folder away again when a write fails part way through', async () => {
        const host = makeHost();
        // A destination whose parent is a file, not a folder, so the very first write throws.
        const blocked = `${MOD}/parts/taken/keep.rules/inside`;
        const result = await apply({ ...atCannonId(), newId: 'me.failed_cannon', destinationDir: blocked }, host);
        expect(result.failure).toBe('writeFailed');
        expect(existsSync(blocked)).toBe(false);
    });

    it('refuses a destination outside a mod, and never writes into the game s own tree', async () => {
        const target = `${DATA}/ships/terran/refused`;
        const result = await apply({ ...atCannonId(), newId: 'me.refused', destinationDir: target }, makeHost());
        expect(result.failure).toBe('notEditable');
        expect(existsSync(target)).toBe(false);
    });

    it('refuses an id another declaration already holds, however it is capitalized', async () => {
        const host = makeHost({ declared: ['ME.TAKEN_CANNON'] });
        const result = await apply({ ...atCannonId(), newId: 'me.taken_cannon' }, host);
        expect(result.failure).toBe('idTaken');
        expect(existsSync(`${MOD}/ships/terran/taken_cannon`)).toBe(false);
    });
});
