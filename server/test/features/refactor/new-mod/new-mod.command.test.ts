import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CancellationToken, Connection, WorkDoneProgressReporter } from 'vscode-languageserver';
import { lexer } from '../../../../src/core/lexer/lexer';
import { parser } from '../../../../src/core/parser/parser';
import { isValidModId } from '../../../../src/mod/mod-manifest';
import { newMod } from '../../../../src/features/refactor/new-mod/new-mod.command';
import { NewModApplyResult } from '../../../../src/features/refactor/new-mod/new-mod.types';
import { validateModManifest } from '../../../../src/features/diagnostics/validator.mod-manifest';
import { clearGameVersionsCache } from '../../../../src/features/diagnostics/validator.manifest-version';
import { globalSettings } from '../../../../src/settings';
import { CosmoteerWorkspaceService } from '../../../../src/workspace/cosmoteer-workspace.service';
import { validateModActions } from '../../../../src/features/diagnostics/validator.mod-action';
import { parseModActions } from '../../../../src/mod/action-parser';
import { validateMissingSeparators, validateUnbracketedValueList } from '../../../../src/features/diagnostics/validator.separator';
import {
    validateOrphanCommentTerminators,
    validateUnterminatedComments,
} from '../../../../src/features/diagnostics/validator.comment';
import { BlockCommentSpan } from '../../../../src/core/lexer/lexer';

// The command writes a mod into a folder of the author's choosing, so every case here runs against a
// real scratch directory rather than a fixture: what is being pinned is what lands on disk.
const token = CancellationToken.None;
let root = '';

/** Creates a mod under the scratch directory with the arguments a client would send. */
const create = async (name: string, author: string, folderName?: string): Promise<NewModApplyResult> =>
    (await newMod({ destination: root, name, author, folderName }, token)) as NewModApplyResult;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'newmod-')).replace(/\\/g, '/');
});

afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
});

describe('newMod', () => {
    it('writes a manifest and a language file into a folder named after the mod', async () => {
        const result = await create('Heavy Cannons', 'Jane Doe');
        expect(result.failure).toBeUndefined();
        expect(result.modRoot).toBe(join(root, 'heavy_cannons'));
        expect(result.id).toBe('jane_doe.heavy_cannons');
        expect(isValidModId(result.id)).toBe(true);
        expect(result.createdFiles.map((file) => file.replace(/\\/g, '/'))).toEqual([
            `${root}/heavy_cannons/mod.rules`,
            `${root}/heavy_cannons/strings/en.rules`,
        ]);
        const manifest = readFileSync(result.manifest, 'utf8');
        expect(manifest).toContain('ID = jane_doe.heavy_cannons');
        expect(manifest).toContain('Name = "Heavy Cannons"');
        expect(manifest).toContain('Author = "Jane Doe"');
        expect(manifest).toContain('StringsFolder = "strings"');
        expect(manifest).toContain('Actions');
    });

    it('takes a folder name of the author\'s own over the one the mod name gives', async () => {
        const result = await create('Heavy Cannons', 'Jane Doe', 'JD Cannons');
        expect(result.modRoot).toBe(join(root, 'jd_cannons'));
        expect(result.id).toBe('jane_doe.jd_cannons');
    });

    it('escapes a name that carries a quote rather than writing a broken manifest', async () => {
        const result = await create('The "Big" Mod', 'Jane');
        const manifest = readFileSync(result.manifest, 'utf8');
        expect(manifest).toContain('Name = "The \\"Big\\" Mod"');
        expect(parser(lexer(manifest), pathToFileURL(result.manifest).href).parserErrors).toEqual([]);
    });

    it('refuses a folder that already exists rather than writing into somebody\'s mod', async () => {
        mkdirSync(join(root, 'heavy_cannons'));
        const result = await create('Heavy Cannons', 'Jane');
        expect(result.failure).toBe('pathTaken');
        expect(existsSync(join(root, 'heavy_cannons', 'mod.rules'))).toBe(false);
    });

    it('refuses a name and an author nothing usable is left of', async () => {
        expect((await create('***', 'Jane')).failure).toBe('invalidName');
        expect((await create('Heavy Cannons', '***')).failure).toBe('invalidAuthor');
        expect(((await newMod({ destination: root }, token)) as { kind: string }).kind).toBe('scan');
    });

    it('refuses a destination that is not there', async () => {
        const result = (await newMod(
            { destination: join(root, 'nowhere'), name: 'Mod', author: 'Jane' },
            token
        )) as NewModApplyResult;
        expect(result.failure).toBe('noDestination');
    });
});

describe('what the created mod reads as', () => {
    it('reports nothing the editor would flag on the files it writes', async () => {
        const result = await create('Quiet Mod', 'Jane Doe');
        for (const file of result.createdFiles) {
            const text = readFileSync(file, 'utf8');
            const uri = pathToFileURL(file).href;
            const blockComments: BlockCommentSpan[] = [];
            const tokens = lexer(text, blockComments);
            const parsed = parser(tokens, uri);
            expect(parsed.parserErrors, `${file} parses cleanly`).toEqual([]);
            expect(await validateModManifest(parsed.value, token)).toEqual([]);
            expect(await validateModActions(parseModActions(parsed.value), token)).toEqual([]);
            expect(validateMissingSeparators(tokens)).toEqual([]);
            expect(validateUnbracketedValueList(tokens)).toEqual([]);
            expect(validateOrphanCommentTerminators(tokens)).toEqual([]);
            expect(validateUnterminatedComments(text, blockComments)).toEqual([]);
        }
    });
});

// The manifest should name the versions the installed build is at, which is the field a mod is
// turned off over after a game update. Self-skipped without an install, like the other checks that
// read the real game.
const DATA_DIR = process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';

describe.skipIf(!existsSync(DATA_DIR))('against the installed game', () => {
    it('names the game versions the install is at', async () => {
        const previous = globalSettings.cosmoteerPath;
        globalSettings.cosmoteerPath = DATA_DIR;
        clearGameVersionsCache();
        const noop: WorkDoneProgressReporter = { begin: () => undefined, report: () => undefined, done: () => undefined };
        const service = CosmoteerWorkspaceService.instance;
        service.setConnection({
            languages: { diagnostics: { refresh: () => undefined } },
            window: { showWarningMessage: () => undefined },
        } as unknown as Connection);
        await service.initialize(DATA_DIR, noop);
        try {
            const result = await create('Version Mod', 'Jane');
            expect(readFileSync(result.manifest, 'utf8')).toMatch(/CompatibleGameVersions = \["\d+\.\d+/);
        } finally {
            globalSettings.cosmoteerPath = previous;
            clearGameVersionsCache();
        }
    }, 60_000);
});
