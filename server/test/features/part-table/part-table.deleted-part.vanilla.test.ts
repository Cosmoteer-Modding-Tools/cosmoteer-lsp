import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { CancellationToken, Connection, WorkDoneProgressReporter } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { aliasRootIndex } from '../../../src/document/schema/alias-root';
import { ReverseIncludeIndex } from '../../../src/mod/reverse-include.index';
import { MemberInjectionIndex } from '../../../src/mod/member-injection.index';
import { AddBaseIndex } from '../../../src/mod/add-base.index';
import {
    buildPartTable,
    invalidatePartTable,
    onPartTableChange,
} from '../../../src/features/part-table/part-table.service';
import { PROJECT_INDEXES } from '../../../src/lsp/project-indexes';
import { invalidateFsPath } from '../../../src/workspace/fs-cache';
import { globalSettings } from '../../../src/settings';
import { CosmoteerWorkspaceService } from '../../../src/workspace/cosmoteer-workspace.service';

/**
 * What the table does when a part's file is deleted on disk, which a git checkout, a revert or a
 * delete in the file explorer all send as a watched-file change of its own kind. The walk is kept
 * between requests, so a deletion nothing marks leaves the part's row on the table with every
 * value it had and a link to a file that is no longer there.
 */

const DATA_DIR = process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const FIXTURE = resolve(__dirname, 'fixtures', 'values-mod');
const HAVE_DATA = existsSync(DATA_DIR);
const token = CancellationToken.None;

const parseReal = (abs: string) => parser(lexer(readFileSync(abs, 'utf8')), pathToFileURL(abs).href).value;

const resolveRef = async (fileRef: string, fromUri: string) => {
    const rel = fileRef.replace(/[<>]/g, '').trim();
    if (!rel) return undefined;
    const withExt = /\.[^/\\.]+$/.test(rel) ? rel : `${rel}.rules`;
    for (const abs of [
        join(dirname(fileURLToPath(fromUri)), withExt),
        join(DATA_DIR, withExt),
        join(dirname(DATA_DIR), withExt),
    ]) {
        if (!existsSync(abs)) continue;
        try {
            return parseReal(abs);
        } catch {
            return undefined;
        }
    }
    return undefined;
};

/** A copy of the fixture mod, since the test deletes one of its files. */
let modRoot = '';

/** Brings the workspace up against the game's data with the copied mod beside it. */
const initializeWorkspace = async (): Promise<void> => {
    globalSettings.cosmoteerPath = DATA_DIR;
    const noopProgress: WorkDoneProgressReporter = {
        begin: () => undefined,
        report: () => undefined,
        done: () => undefined,
    };
    const service = CosmoteerWorkspaceService.instance;
    service.setConnection({
        languages: { diagnostics: { refresh: () => undefined } },
        window: { showWarningMessage: () => undefined },
    } as unknown as Connection);
    await service.initialize(DATA_DIR, noopProgress);
    aliasRootIndex.invalidate();
    await aliasRootIndex.build(parseReal(join(DATA_DIR, 'cosmoteer.rules')), resolveRef);
    ReverseIncludeIndex.instance.reset();
    await ReverseIncludeIndex.instance.ensureBuilt([DATA_DIR, modRoot], token);
    MemberInjectionIndex.instance.reset();
    await MemberInjectionIndex.instance.ensureBuilt([DATA_DIR, modRoot], token);
    AddBaseIndex.instance.reset();
    await AddBaseIndex.instance.ensureBuilt([DATA_DIR, modRoot], token);
    invalidatePartTable();
};

const scope = () => ({
    context: {
        gameRootDocument: parseReal(join(DATA_DIR, 'cosmoteer.rules')),
        gameRootPath: join(DATA_DIR, 'cosmoteer.rules'),
        folderPaths: [modRoot],
    },
    modRoot,
});

/** The deletion as the watched-file notification runs it, which is the whole of that branch. */
const deleteOnDisk = (path: string): void => {
    unlinkSync(path);
    const uri = pathToFileURL(path).href;
    invalidateFsPath(path);
    for (const index of PROJECT_INDEXES) index.remove?.(uri);
};

describe.skipIf(!HAVE_DATA)('the part table when a part file is deleted', () => {
    beforeAll(async () => {
        modRoot = mkdtempSync(join(tmpdir(), 'part-table-deleted-'));
        cpSync(FIXTURE, modRoot, { recursive: true });
        await initializeWorkspace();
    }, 180_000);

    afterAll(() => {
        if (modRoot) rmSync(modRoot, { recursive: true, force: true });
    });

    it('drops the row of a part whose file is gone, and says the table moved', async () => {
        const before = await buildPartTable(scope(), ['MaxHealth'], undefined, token);
        expect(before.rows.map((row) => row.id)).toContain('test.twin_cannon');

        let told = false;
        onPartTableChange(() => {
            told = true;
        });
        deleteOnDisk(join(modRoot, 'parts', 'twin_cannon.rules'));
        const after = await buildPartTable(scope(), ['MaxHealth'], undefined, token);
        expect(after.rows.map((row) => row.id)).not.toContain('test.twin_cannon');
        // The part beside it in the same manifest is untouched, so the deletion took one row.
        expect(after.rows.map((row) => row.id)).toContain('test.ref_resource');
        await new Promise((done) => setTimeout(done, 600));
        expect(told).toBe(true);
    }, 180_000);
});
