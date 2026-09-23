import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { CancellationToken, Connection, WorkDoneProgressReporter } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { aliasRootIndex } from '../../../src/document/schema/alias-root';
import { ReverseIncludeIndex } from '../../../src/mod/reverse-include.index';
import { MemberInjectionIndex } from '../../../src/mod/member-injection.index';
import { AddBaseIndex } from '../../../src/mod/add-base.index';
import { buildPartTable, invalidatePartTable } from '../../../src/features/part-table/part-table.service';
import { PartTableData, PartTableRow } from '../../../src/features/part-table/part-table.types';
import { globalSettings } from '../../../src/settings';
import { CosmoteerWorkspaceService } from '../../../src/workspace/cosmoteer-workspace.service';

const DATA_DIR = process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const MOD_DIR = resolve(__dirname, 'fixtures', 'values-mod');
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

/** Brings the workspace up against the game's data with the fixture mod beside it. */
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
    invalidatePartTable();
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

/** The columns the assertions read, asked for the way the view asks for them. */
const SHOWN = [
    '@DPS',
    '@Cost',
    'StatsByCategory/0/Stats/DamagePerSecond',
    'StatsByCategory/1/Stats/Barrels',
    'Resources/coil',
    'Audit/Vertices/0/0',
    'Audit/Vertices/0/1',
    'Audit/Vertices/1/0',
    'Audit/Vertices/1/1',
    'Audit/Vertices/3',
    'Audit/Vertices/2',
];

const rowOf = (rows: readonly PartTableRow[], id: string): PartTableRow => {
    const row = rows.find((candidate) => candidate.id === id);
    expect(row, `no row for ${id}`).toBeDefined();
    return row!;
};

describe.skipIf(!HAVE_DATA)('part table values over a mod that writes them by reference', () => {
    let table: PartTableData;

    beforeAll(async () => {
        await initializeWorkspace();
        table = await buildPartTable(modScope(), SHOWN, undefined, token);
    }, 180_000);

    it('reads the damage per second the part declares rather than multiplying it by the barrels', () => {
        const turret = rowOf(table.rows, 'test.twin_cannon');
        // The stats block is what the game prints in the part's own tooltip, so its damage per
        // second is the figure for the whole weapon however many barrels stand beside it.
        expect(turret.cells['StatsByCategory/0/Stats/DamagePerSecond']?.value).toBe(300);
        expect(turret.cells['StatsByCategory/1/Stats/Barrels']?.value).toBe(2);
        expect(turret.cells['@DPS']?.value).toBe(300);
    });

    it('keys a resource named by reference under the resource it names', () => {
        const part = rowOf(table.rows, 'test.ref_resource');
        expect(part.cells['Resources/coil']?.value).toBe(40);
        // Forty coils at the hundred credits the resource file prices them at.
        expect(part.cells['@Cost']?.value).toBe(4000);
    });

    it('reads a pair of numbers named by reference by position rather than as a key', () => {
        const part = rowOf(table.rows, 'test.ref_resource');
        expect(part.cells['Audit/Vertices/0/0']?.value).toBe(3);
        expect(part.cells['Audit/Vertices/0/1']?.value).toBe(0);
        expect(part.cells['Audit/Vertices/1/0']?.value).toBe(2);
        expect(part.cells['Audit/Vertices/1/1']?.value).toBe(1);
        // The written coordinate is not a name, so no column is keyed by the number it stands for.
        expect(part.cells['Audit/Vertices/3']).toBeUndefined();
        expect(part.cells['Audit/Vertices/2']).toBeUndefined();
    });
});
