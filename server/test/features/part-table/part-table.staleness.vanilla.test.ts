import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { CancellationToken, Connection, TextEdit, WorkDoneProgressReporter } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { aliasRootIndex } from '../../../src/document/schema/alias-root';
import { ReverseIncludeIndex } from '../../../src/mod/reverse-include.index';
import { MemberInjectionIndex } from '../../../src/mod/member-injection.index';
import { AddBaseIndex } from '../../../src/mod/add-base.index';
import {
    buildPartTable,
    fileKey,
    invalidatePartTable,
    invalidatePartTableFor,
    onPartTableChange,
    onPartTableProgress,
} from '../../../src/features/part-table/part-table.service';
import { buildPartTableEdit } from '../../../src/features/part-table/part-table.edit';
import { PartCatalogScope } from '../../../src/features/part-table/part-catalog';
import { globalSettings } from '../../../src/settings';
import { CosmoteerWorkspaceService } from '../../../src/workspace/cosmoteer-workspace.service';

/**
 * What the table answers and what it writes when the files have moved since it read them: an
 * unsaved buffer the reader is typing in, and a save that lands while the walk is still running.
 * Both are about the same thing, a walk that is older than the text, so both are driven through
 * one scope whose open buffers the test holds.
 */

const DATA_DIR = process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const MOD_DIR = resolve(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    '.claude',
    'skills',
    'run-cosmoteer-lsp',
    'fixtures',
    'scope-mod'
);
const BIG_SHIELD = join(MOD_DIR, 'parts', 'big_shield.rules');
const HAVE_DATA = existsSync(DATA_DIR) && existsSync(MOD_DIR);
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

/** Brings the workspace up against the game's data, the state the running server always has. */
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
    await ReverseIncludeIndex.instance.ensureBuilt([DATA_DIR, MOD_DIR], token);
    MemberInjectionIndex.instance.reset();
    await MemberInjectionIndex.instance.ensureBuilt([DATA_DIR, MOD_DIR], token);
    AddBaseIndex.instance.reset();
    await AddBaseIndex.instance.ensureBuilt([DATA_DIR, MOD_DIR], token);
};

/** The buffers the editor is holding, by folded path, which is what the scope reads them from. */
const buffers = new Map<string, string>();

/** The scope the table is built for: the game's data with the fixture mod beside it. */
const modScope = (): PartCatalogScope => ({
    context: {
        gameRootDocument: parseReal(join(DATA_DIR, 'cosmoteer.rules')),
        gameRootPath: join(DATA_DIR, 'cosmoteer.rules'),
        folderPaths: [MOD_DIR],
    },
    modRoot: MOD_DIR,
    openDocument: (fsPath) => {
        const text = buffers.get(fileKey(fsPath));
        return text === undefined ? undefined : parser(lexer(text), pathToFileURL(fsPath).href).value;
    },
});

/** The writer's hooks, reading the same buffers the scope reads. */
const hooks = {
    openText: (uri: string) => buffers.get(fileKey(uri)),
    dataRootPath: DATA_DIR,
};

/** The text after the edits land, the way the editor applies them. */
const applied = (text: string, edits: readonly TextEdit[]): string => {
    const lines = text.split('\n');
    const offsetOf = (position: { line: number; character: number }): number =>
        lines.slice(0, position.line).reduce((sum, line) => sum + line.length + 1, 0) + position.character;
    let result = text;
    for (const edit of [...edits].sort((a, b) => offsetOf(b.range.start) - offsetOf(a.range.start))) {
        result = result.slice(0, offsetOf(edit.range.start)) + edit.newText + result.slice(offsetOf(edit.range.end));
    }
    return result;
};

/** The buffer as the edit result leaves it, which is what the reader would be looking at. */
const writtenBuffer = (result: { edit?: { changes?: Record<string, TextEdit[]> } }): string => {
    const [uri, edits] = Object.entries(result.edit!.changes!)[0];
    return applied(buffers.get(fileKey(uri))!, edits);
};

const rowKeyOf = (table: { rows: readonly { key: string; id: string }[] }, id: string): string =>
    table.rows.find((row) => row.id === id)!.key;

describe.skipIf(!HAVE_DATA)('the part table against text that has moved on', () => {
    beforeAll(async () => {
        await initializeWorkspace();
    }, 120_000);

    it('writes into the line the reader sees rather than into the one the walk read', async () => {
        buffers.clear();
        invalidatePartTable();
        const table = await buildPartTable(modScope(), ['MaxHealth'], undefined, token);
        const key = rowKeyOf(table, 'test.big_shield');

        // The buffer gains a line above the one the cell was read from, and that line is written so
        // the span the walk recorded now covers a number that reads the same. Nothing about the
        // edit can tell the two apart except reading the part again.
        const disk = readFileSync(BIG_SHIELD, 'utf8').replace(/\r\n/g, '\n');
        const at = disk.indexOf('\tMaxHealth');
        const typed = `${disk.slice(0, at)}\tBaseValue = 9000\n${disk.slice(at)}`;
        buffers.set(fileKey(BIG_SHIELD), typed);

        const result = await buildPartTableEdit(key, 'MaxHealth', '9500', hooks);
        expect(result.status).toBe('ok');
        const text = writtenBuffer(result);
        expect(text).toContain('\tMaxHealth = 9500\n');
        expect(text).toContain('\tBaseValue = 9000\n');
    }, 120_000);

    it('adds an override inside the part rather than where the walk left its brace', async () => {
        buffers.clear();
        invalidatePartTable();
        const table = await buildPartTable(modScope(), ['Components/ArcShield/Radius/BaseValue'], undefined, token);
        const key = rowKeyOf(table, 'test.big_shield');

        const disk = readFileSync(BIG_SHIELD, 'utf8').replace(/\r\n/g, '\n');
        const at = disk.indexOf('\tMaxHealth');
        buffers.set(fileKey(BIG_SHIELD), `${disk.slice(0, at)}\tSprite { Group = big }\n${disk.slice(at)}`);

        const result = await buildPartTableEdit(key, 'Components/ArcShield/Radius/BaseValue', '9', hooks);
        expect(result.status).toBe('ok');
        const text = writtenBuffer(result);
        expect(text).toContain('Components { ArcShield { Radius { BaseValue = 9 } } }');
        // The override belongs to the part, so it stands before the brace the part ends with, and
        // the line the reader typed meanwhile is still whole.
        expect(text).toContain('\tSprite { Group = big }\n');
        expect(text.trimEnd().endsWith('}')).toBe(true);
        expect(text.indexOf('BaseValue = 9 }')).toBeLessThan(text.lastIndexOf('}'));
    }, 120_000);

    it('answers the saved value after a save that lands while the parts are being read', async () => {
        buffers.clear();
        invalidatePartTable();
        let notified = false;
        onPartTableChange(() => {
            notified = true;
        });
        const disk = readFileSync(BIG_SHIELD, 'utf8').replace(/\r\n/g, '\n');
        const changed = disk.replace('MaxHealth = 9000', 'MaxHealth = 12345');
        let fired = false;
        // Every part has been read by the time the walk reports its last one, and the walk has not
        // stored itself yet, which is the window a save falls into during a long build.
        onPartTableProgress((done, total) => {
            if (fired || done < total) return;
            fired = true;
            buffers.set(fileKey(BIG_SHIELD), changed);
            invalidatePartTableFor(pathToFileURL(BIG_SHIELD).href);
        });

        const first = await buildPartTable(modScope(), ['MaxHealth'], undefined, token);
        onPartTableProgress(() => undefined);
        expect(fired).toBe(true);
        expect(first.rows.find((row) => row.id === 'test.big_shield')?.cells['MaxHealth']?.value).toBe(9000);

        const next = await buildPartTable(modScope(), ['MaxHealth'], undefined, token);
        expect(next.rows.find((row) => row.id === 'test.big_shield')?.cells['MaxHealth']?.value).toBe(12345);
        await new Promise((done) => setTimeout(done, 600));
        expect(notified).toBe(true);
    }, 120_000);
});
