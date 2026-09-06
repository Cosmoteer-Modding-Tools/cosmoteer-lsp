import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { CancellationToken, Connection, TextEdit, WorkDoneProgressReporter } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { aliasRootIndex } from '../../../src/document/schema/alias-root';
import { ReverseIncludeIndex } from '../../../src/features/navigation/reverse-include.index';
import { MemberInjectionIndex } from '../../../src/mod/member-injection.index';
import { AddBaseIndex } from '../../../src/mod/add-base.index';
import { buildPartTable, buildPartTableEdit } from '../../../src/features/part-table/part-table.service';
import { PartTableData } from '../../../src/features/part-table/part-table.types';
import { globalSettings } from '../../../src/settings';
import { CosmoteerWorkspaceService } from '../../../src/workspace/cosmoteer-workspace.service';

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

/**
 * The text after the edits land, the way the editor applies them, so a test can read the written
 * line rather than reason about offsets.
 */
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

/** The one file an edit result writes, with its text as the edit leaves it. */
const written = (result: { edit?: { changes?: Record<string, TextEdit[]> } }): { file: string; text: string } => {
    const [uri, edits] = Object.entries(result.edit!.changes!)[0];
    const file = fileURLToPath(uri);
    return { file, text: applied(readFileSync(file, 'utf8'), edits) };
};

/** The scope the table is built for: the game's data with the fixture mod beside it. */
const modScope = () => ({
    context: {
        gameRootDocument: parseReal(join(DATA_DIR, 'cosmoteer.rules')),
        gameRootPath: join(DATA_DIR, 'cosmoteer.rules'),
        folderPaths: [MOD_DIR],
    },
    modRoot: MOD_DIR,
});

const hooks = { openText: () => undefined, dataRootPath: DATA_DIR };

describe.skipIf(!HAVE_DATA)('part table edits over the fixture mod', () => {
    let table: PartTableData;

    beforeAll(async () => {
        await initializeWorkspace();
        table = await buildPartTable(
            modScope(),
            ['MaxHealth', 'Components/ArcShield/Radius/BaseValue'],
            undefined,
            token
        );
    }, 120_000);

    it('reads the mod part beside the game parts', () => {
        const big = table.rows.find((row) => row.id === 'test.big_shield');
        expect(big?.source).toBe('scope-mod');
        expect(big?.ships).toEqual(['Terran']);
        expect(big?.cells['MaxHealth']?.value).toBe(9000);
        expect(big?.cells['MaxHealth']?.inherited).toBe(false);
        // A value under a container the part inherits whole is inherited too, whatever the
        // container itself says about its own members.
        expect(big?.cells['Components/ArcShield/Radius/BaseValue']?.value).toBe(7.5);
        expect(big?.cells['Components/ArcShield/Radius/BaseValue']?.inherited).toBe(true);
        expect(table.mod).toBe('scope-mod');
    });

    it('writes an own value over in place', async () => {
        const big = table.rows.find((row) => row.id === 'test.big_shield')!;
        const result = await buildPartTableEdit(big.key, 'MaxHealth', '9500', hooks);
        expect(result.status).toBe('ok');
        const edits = Object.values(result.edit!.changes!)[0];
        expect(edits).toHaveLength(1);
        expect(edits[0].newText).toBe('9500');
        expect(edits[0].range.start.line).toBe(3);
    });

    it('adds an override to the part for an inherited value', async () => {
        const big = table.rows.find((row) => row.id === 'test.big_shield')!;
        const result = await buildPartTableEdit(big.key, 'Components/ArcShield/Radius/BaseValue', '9', hooks);
        expect(result.message).toBeUndefined();
        expect(result.status).toBe('ok');
        const edits = Object.values(result.edit!.changes!)[0];
        expect(edits[0].newText).toContain('Components { ArcShield { Radius { BaseValue = 9 } } }');
        expect(Object.keys(result.edit!.changes!)[0].toLowerCase()).toContain('big_shield');
    });

    it('writes a literal over a reference the part owns', async () => {
        const part = table.rows.find((row) => row.id === 'test.ref_shield')!;
        expect(part.cells['MaxHealth']?.value).toBe(4000);
        expect(part.cells['MaxHealth']?.inherited).toBe(false);
        const result = await buildPartTableEdit(part.key, 'MaxHealth', '9500', hooks);
        expect(result.status).toBe('ok');
        const { file, text } = written(result);
        expect(file.toLowerCase()).toContain('ref_shield');
        expect(text).toContain('\tMaxHealth = 9500\n');
        expect(text).not.toContain('&<constants.rules>/HP');
    });

    it('writes a literal over a nested reference the part owns', async () => {
        const part = table.rows.find((row) => row.id === 'test.ref_shield')!;
        expect(part.cells['Components/ArcShield/Radius/BaseValue']?.value).toBe(2);
        const result = await buildPartTableEdit(part.key, 'Components/ArcShield/Radius/BaseValue', '9', hooks);
        expect(result.status).toBe('ok');
        expect(written(result).text).toContain('Radius { BaseValue = 9 }');
    });

    it('writes a literal over an expression the part owns', async () => {
        const part = table.rows.find((row) => row.id === 'test.expr_shield')!;
        expect(part.cells['MaxHealth']?.value).toBe(8000);
        const result = await buildPartTableEdit(part.key, 'MaxHealth', '9500', hooks);
        expect(result.status).toBe('ok');
        const { text } = written(result);
        expect(text).toContain('\tMaxHealth = 9500\n');
        expect(text).not.toContain('Mult)');
        const nested = await buildPartTableEdit(part.key, 'Components/ArcShield/Radius/BaseValue', '9', hooks);
        expect(nested.status).toBe('ok');
        expect(written(nested).text).toContain('Radius { BaseValue = 9 }');
    });

    it('overrides on the part what it inherits from a base of the mod', async () => {
        const part = table.rows.find((row) => row.id === 'test.derived_shield')!;
        expect(part.cells['MaxHealth']?.value).toBe(5555);
        expect(part.cells['MaxHealth']?.inherited).toBe(true);
        const result = await buildPartTableEdit(part.key, 'MaxHealth', '6000', hooks);
        expect(result.status).toBe('ok');
        const { file, text } = written(result);
        expect(file.toLowerCase()).toContain('derived_shield');
        expect(text).toContain('MaxHealth = 6000');
    });

    it('writes into the manifest where the mod overrides a game part', async () => {
        const armor = table.rows.find((row) => row.id === 'cosmoteer.armor')!;
        expect(armor.cells['MaxHealth']?.value).toBe(1234);
        const result = await buildPartTableEdit(armor.key, 'MaxHealth', '2000', hooks);
        expect(result.status).toBe('ok');
        const { file, text } = written(result);
        expect(file.toLowerCase()).toContain('mod.rules');
        expect(text).toContain('MaxHealth = 2000');
    });

    it('refuses to write into the game', async () => {
        const shield = table.rows.find((row) => row.id === 'cosmoteer.shield_gen_small')!;
        const result = await buildPartTableEdit(shield.key, 'MaxHealth', '7000', hooks);
        expect(result.status).toBe('refused');
    });

    it('refuses a value that is not a number', async () => {
        const big = table.rows.find((row) => row.id === 'test.big_shield')!;
        expect((await buildPartTableEdit(big.key, 'MaxHealth', 'lots', hooks)).status).toBe('refused');
    });
});
