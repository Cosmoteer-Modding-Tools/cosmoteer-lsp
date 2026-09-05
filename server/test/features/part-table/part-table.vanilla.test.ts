import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { CancellationToken, Connection, WorkDoneProgressReporter } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { aliasRootIndex } from '../../../src/document/schema/alias-root';
import { ReverseIncludeIndex } from '../../../src/features/navigation/reverse-include.index';
import { buildPartTable } from '../../../src/features/part-table/part-table.service';
import { PartTableData, PartTableRow } from '../../../src/features/part-table/part-table.types';
import { globalSettings } from '../../../src/settings';
import { CosmoteerWorkspaceService } from '../../../src/workspace/cosmoteer-workspace.service';

const DATA_DIR = process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
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
    await ReverseIncludeIndex.instance.ensureBuilt([DATA_DIR], token);
};

/** The scope the table is built for: the game's own data, with no mod in the picture. */
const gameScope = () => ({
    context: {
        gameRootDocument: parseReal(join(DATA_DIR, 'cosmoteer.rules')),
        gameRootPath: join(DATA_DIR, 'cosmoteer.rules'),
        folderPaths: [] as string[],
    },
});

/** The columns the value assertions read, asked for explicitly the way the view asks for them. */
const SHOWN = [
    'MaxHealth',
    'Resources/steel',
    'Resources/coil',
    'Components/ArcShield/Radius/BaseValue',
    'Components/ArcShield/Arc/BaseValue',
    'StatsByCategory/0/Stats/ShieldHP',
    'StatsByCategory/0/Stats/DamagePerSecond',
    '@Cost',
    '@DPS',
];

const rowOf = (rows: readonly PartTableRow[], id: string): PartTableRow => {
    const row = rows.find((candidate) => candidate.id === id);
    expect(row, `no row for ${id}`).toBeDefined();
    return row!;
};

describe.skipIf(!HAVE_DATA)('part table over vanilla data', () => {
    // One build for every assertion: reading a hundred and sixty parts out of the game data is the
    // whole cost of the suite, and none of the assertions changes what was read.
    let table: PartTableData;

    beforeAll(async () => {
        await initializeWorkspace();
        table = await buildPartTable(gameScope(), SHOWN, undefined, token);
    }, 120_000);

    it('reads the game parts with the numbers the game computes', () => {
        expect(table.rows.length).toBeGreaterThan(50);
        const small = rowOf(table.rows, 'cosmoteer.shield_gen_small');

        // Written on the part itself.
        expect(small.cells['MaxHealth']?.value).toBe(6000);
        // A pair list is addressed by its key, so the column means the same thing on every part.
        expect(small.cells['Resources/steel']?.value).toBe(40);
        expect(small.cells['Resources/coil']?.value).toBe(40);
        // Reached through the components, four hops down.
        expect(small.cells['Components/ArcShield/Radius/BaseValue']?.value).toBe(7.5);
        // The stat the game's own tooltip shows, written as a division of two references elsewhere in
        // the file: 6000 battery over 0.4 drain per damage.
        expect(small.cells['StatsByCategory/0/Stats/ShieldHP']?.value).toBe(15000);
        // An angle is stored in radians whatever suffix it was written with.
        expect(small.cells['Components/ArcShield/Arc/BaseValue']?.value).toBeCloseTo(Math.PI / 2, 6);
    });

    it('works out the columns a modder keeps by hand', () => {
        const small = rowOf(table.rows, 'cosmoteer.shield_gen_small');
        // Forty steel at 25 and forty coils at 100, the prices the resource files declare.
        expect(small.cells['@Cost']?.value).toBe(5000);
        expect(small.cells['@Cost']?.unit).toBe('credits');
        // Two by three, whether or not the size columns are on screen.
        expect(small.cells['@Tiles']?.value).toBe(6);
        // A shield has no damage stat, so the column is simply absent on it.
        expect(small.cells['@DPS']).toBeUndefined();

        // The laser's damage per second is the game's own stat, read as the game computes it.
        const laser = rowOf(table.rows, 'cosmoteer.laser_blaster_small');
        expect(laser.cells['@DPS']?.value).toBeGreaterThan(0);
        expect(laser.cells['@DPS']?.value).toBe(laser.cells['StatsByCategory/0/Stats/DamagePerSecond']?.value);

        // The build menu group is what the game files parts under.
        expect(small.editorGroup).toBe('Defenses');
        expect(small.editorGroups).toEqual(['Defenses']);
        expect(table.editorGroups).toContain('WeaponsEnergy');

        // The ship classes register the parts: a shield belongs to the terran ships, a deposit to
        // the asteroids and a megarock to the megaroids.
        expect(small.ships).toEqual(['Terran']);
        expect(rowOf(table.rows, 'cosmoteer.deposit_carbon_1x').ships).toEqual(['Asteroid']);
        expect(rowOf(table.rows, 'cosmoteer.megarock_1x1').ships).toEqual(['Megaroid']);
        expect(table.ships).toEqual(['Asteroid', 'Megaroid', 'Terran']);

        const cost = table.columns.find((column) => column.path === '@Cost');
        expect(cost?.derived).toBe(true);
        expect(cost?.rows).toBeGreaterThan(50);
    });

    it('carries the filter axes and the provenance a reader needs', () => {
        const small = rowOf(table.rows, 'cosmoteer.shield_gen_small');

        expect(small.categories).toContain('defense');
        expect(small.components).toContain('ArcShield');
        expect(table.categories).toContain('defense');
        expect(table.componentTypes).toContain('ArcShield');

        // A value the part writes itself points at the part's own file, and one it takes from a base
        // points at the base.
        expect(small.cells['MaxHealth']?.inherited).toBe(false);
        expect(small.cells['MaxHealth']?.uri.toLowerCase()).toContain('shield_gen_small');
    });

    it('narrows the columns to the parts the filter leaves', async () => {
        const narrowed = await buildPartTable(gameScope(), SHOWN, { categories: ['defense'] }, token);
        expect(narrowed.rows.length).toBeGreaterThan(0);
        expect(narrowed.rows.length).toBeLessThan(table.rows.length);
        expect(narrowed.columns.length).toBeLessThan(table.columns.length);
        // The whole scope is still counted, so the view can say what it is showing of what there is.
        expect(narrowed.total).toBe(table.rows.length);
        // The axes stay the whole scope's, so narrowing to one category never takes the others out
        // of the dropdown that would let the reader leave it again.
        expect(narrowed.categories).toEqual(table.categories);
        for (const row of narrowed.rows) expect(row.categories).toContain('defense');
    }, 60_000);

    it('offers the columns the parts really differ in', async () => {
        expect(table.suggested.length).toBeGreaterThan(0);
        // The opening set is what a table asked for no columns computes, so its cells say whether
        // the suggestion holds up: a number in some row, read from more than one declaration.
        const opening = await buildPartTable(gameScope(), undefined, undefined, token);
        expect(opening.suggested).toEqual(table.suggested);
        for (const path of table.suggested) {
            const cells = opening.rows.map((row) => row.cells[path]).filter((cell) => cell !== undefined);
            expect(cells.some((cell) => cell.value !== null)).toBe(true);
            // A field the base writes once and every part inherits unchanged compares nothing, so
            // the opening set never offers one.
            const declarations = new Set(cells.map((cell) => `${cell.uri}#${cell.line}:${cell.character}`));
            expect(declarations.size).toBeGreaterThan(1);
        }
        // The health is what a reader opens the table for, and every part writes its own.
        expect(table.suggested).toContain('MaxHealth');
        // The figures a hand-kept sheet starts with come first, and the icon's size does not come at all.
        expect(table.suggested.slice(0, 3)).toEqual(['MaxHealth', '@Cost', '@Tiles']);
        expect(table.suggested).toContain('Resources/steel');
        expect(table.suggested.some((path) => /EditorIcon|SelectionPriority/i.test(path))).toBe(false);
    }, 60_000);

    it('narrows to a build menu group', async () => {
        const narrowed = await buildPartTable(gameScope(), SHOWN, { editorGroups: ['Defenses'] }, token);
        expect(narrowed.rows.length).toBeGreaterThan(0);
        // A part the menu lists under several groups belongs to each of them.
        for (const row of narrowed.rows) expect(row.editorGroups).toContain('Defenses');
    }, 60_000);
});
