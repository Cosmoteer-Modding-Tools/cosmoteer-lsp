import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CancellationToken, TextEdit } from 'vscode-languageserver';
import { filePathToUri } from '../../../../src/features/navigation/navigation-strategy';
import { declaredIdsIn, ID_CLASS_OF_KIND } from '../../../../src/features/refactor/new-content/content-id';
import { newContent, NewContentHost } from '../../../../src/features/refactor/new-content/new-content.command';
import { NewContentApplyResult } from '../../../../src/features/refactor/new-content/new-content.types';
import { clearBaseFileCache } from '../../../../src/features/refactor/shared-base/base-index';
import { clearModRootCache } from '../../../../src/mod/mod-root';
import { globalSettings } from '../../../../src/settings';
import { clearFsCaches } from '../../../../src/workspace/fs-cache';

// A mod whose only declaration of an id sits in a `.txt` file, which is the shape the id sweep used
// to be blind to. The game's loader ignores the extension, so that id is as taken as any other and
// handing it to a created file would drop one of the two the moment the mod loads.
const PART_RULES = ID_CLASS_OF_KIND.part!;
const token = CancellationToken.None;

let ROOT = '';
let MOD_DIR = '';

/** The part text a declaring file carries, in either extension. */
const partText = (id: string): string => `Part\n{\n\tID = ${id}\n\tSize = [1, 1]\n}\n`;

/** A host that captures the client-side edits, with no game install behind it. */
const makeHost = (): NewContentHost & { changes: Record<string, TextEdit[]> } => ({
    changes: {},
    folderPaths: async () => [MOD_DIR],
    openDocuments: () => [],
    gameRoot: async () => undefined,
    dataRoot: () => undefined,
    applyEdit(changes) {
        Object.assign(this.changes, changes);
        return Promise.resolve(true);
    },
    filesChanged: () => undefined,
});

/** The apply round, asserting it answered as one. */
const apply = async (name: string): Promise<NewContentApplyResult> => {
    const result = await newContent(
        { uri: filePathToUri(`${MOD_DIR}/mod.rules`), kind: 'part', name, skipRegistration: true },
        makeHost(),
        token
    );
    if (result.kind !== 'apply') throw new Error('expected the apply round');
    return result;
};

beforeAll(() => {
    ROOT = mkdtempSync(join(tmpdir(), 'contentid-')).replace(/\\/g, '/');
    MOD_DIR = `${ROOT}/mod`;
    mkdirSync(`${MOD_DIR}/parts/other_folder`, { recursive: true });
    writeFileSync(`${MOD_DIR}/mod.rules`, 'ID = test.txtsweep\nName = "Txt Sweep"\n', { encoding: 'utf-8' });
    // The declaring file is deliberately in a folder of another name, so the path gate cannot answer
    // first and the id itself has to be the thing that refuses the creation.
    writeFileSync(`${MOD_DIR}/parts/other_folder/txt_part.txt`, partText('test.txt_only'), { encoding: 'utf-8' });
    writeFileSync(`${MOD_DIR}/parts/other_folder/readme.txt`, partText('test.readme_only'), { encoding: 'utf-8' });
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

describe('the mod-local id sweep', () => {
    it('finds an id a mod declares only in a .txt file', async () => {
        const ids = await declaredIdsIn(MOD_DIR, PART_RULES, token);
        expect(ids.has('test.txt_only')).toBe(true);
    });

    it('leaves a readme out, whatever it happens to hold', async () => {
        const ids = await declaredIdsIn(MOD_DIR, PART_RULES, token);
        expect(ids.has('test.readme_only')).toBe(false);
    });

    it('refuses to create a part whose id is already declared in a .txt file', async () => {
        const result = await apply('txt only');
        expect(result.failure).toBe('idTaken');
        expect(result.created).toBe('');
        expect(existsSync(`${MOD_DIR}/parts/txt_only`)).toBe(false);
    });

    it('still creates a part whose id nothing declares', async () => {
        const result = await apply('free name');
        expect(result.failure).toBeUndefined();
        expect(result.id).toBe('test.free_name');
    });
});
