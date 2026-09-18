import { inflateRawSync } from 'zlib';
import { describe, expect, it } from 'vitest';
import { buildPartTableWorkbook } from '../../../src/features/part-table/part-table.workbook';
import { PartTableWorkbookModel } from '../../../src/features/part-table/part-table.types';

/**
 * Reads the parts of a workbook back out of its archive, so a test can look at the XML the writer
 * produced rather than only at its length.
 */
const unzip = (bytes: Buffer): Map<string, string> => {
    const parts = new Map<string, string>();
    let at = 0;
    while (at + 4 <= bytes.length && bytes.readUInt32LE(at) === 0x04034b50) {
        const compressed = bytes.readUInt32LE(at + 18);
        const nameLength = bytes.readUInt16LE(at + 26);
        const extraLength = bytes.readUInt16LE(at + 28);
        const name = bytes.subarray(at + 30, at + 30 + nameLength).toString('utf8');
        const start = at + 30 + nameLength + extraLength;
        parts.set(name, inflateRawSync(bytes.subarray(start, start + compressed)).toString('utf8'));
        at = start + compressed;
    }
    return parts;
};

const model: PartTableWorkbookModel = {
    columns: [
        { key: 'id', label: 'Part', numeric: false, frozen: true },
        { key: 'source', label: 'From', numeric: false },
        { key: 'MaxHealth', path: 'MaxHealth', label: 'MaxHealth', numeric: true },
        { key: '@Tiles', path: '@Tiles', label: 'Tiles', numeric: true },
        { key: '@Cost', path: '@Cost', label: 'Cost', numeric: true, unit: 'credits' },
        {
            key: 'formula:0',
            label: 'Health per tile',
            numeric: true,
            formula: '[MaxHealth] / [@Tiles]',
        },
    ],
    rows: [
        {
            id: 'cannon_deck',
            file: 'cannon_deck.rules',
            uri: 'file:///game/Data/ships/terran/cannon_deck/cannon_deck.rules',
            groups: ['Terran', 'WeaponsEnergy'],
            cells: ['cannon_deck', 'Cosmoteer', 4000, 6, 250, 666.6667],
        },
        {
            id: 'shield_gen',
            file: 'shield_gen.rules',
            uri: 'file:///game/Data/ships/terran/shield_gen/shield_gen.rules',
            groups: ['Terran', 'Defenses'],
            cells: ['shield_gen', 'Cosmoteer', 2000, 4, null, 500],
        },
    ],
    groupHeaders: ['Ship class', 'Group'],
    mod: 'Star Wars',
    total: 412,
    referenceId: 'cannon_deck',
    perTile: false,
    asPercent: false,
};

describe('the part table workbook', () => {
    const built = buildPartTableWorkbook(model);
    const parts = unzip(Buffer.from(built.base64, 'base64'));
    const sheet = parts.get('xl/worksheets/sheet1.xml') ?? '';
    const table = parts.get('xl/tables/table1.xml') ?? '';

    it('names the file after the mod and the day', () => {
        expect(built.fileName).toMatch(/^Star-Wars-parts-\d{4}-\d{2}-\d{2}\.xlsx$/);
    });

    it('writes every part a workbook needs', () => {
        expect([...parts.keys()]).toEqual(
            expect.arrayContaining([
                '[Content_Types].xml',
                '_rels/.rels',
                'xl/workbook.xml',
                'xl/_rels/workbook.xml.rels',
                'xl/styles.xml',
                'xl/worksheets/sheet1.xml',
                'xl/worksheets/sheet2.xml',
                'xl/tables/table1.xml',
            ])
        );
    });

    it('puts the grouping ahead of the columns, as its own columns', () => {
        expect(sheet).toContain('<t xml:space="preserve">Ship class</t>');
        expect(sheet).toContain('<t xml:space="preserve">Group</t>');
        expect(sheet).toContain('<t xml:space="preserve">Terran</t>');
    });

    it('writes a number as a number', () => {
        expect(sheet).toContain('<v>4000</v>');
    });

    it('leaves a cell the part has no value for empty', () => {
        // The cost of the second part is missing, so the row carries no cell for that column at all.
        expect(sheet).toContain('<c r="F3" s="2"><v>4</v></c><c r="H3"');
    });

    it('writes a formula column as a live formula over the table', () => {
        expect(sheet).toContain('<f>(Parts[[#This Row],[MaxHealth]]/Parts[[#This Row],[Tiles]])</f>');
        expect(sheet).toContain('<v>666.6667</v>');
    });

    it('links a part back to the file it is written in', () => {
        expect(sheet).toContain('<hyperlink ref="C2"');
        expect(parts.get('xl/worksheets/_rels/sheet1.xml.rels')).toContain(
            'Target="file:///game/Data/ships/terran/cannon_deck/cannon_deck.rules"'
        );
    });

    it('freezes the header row and the columns the view pins', () => {
        expect(sheet).toContain('<pane xSplit="3" ySplit="1" topLeftCell="D2"');
    });

    it('makes the rows a table with a filter and an average under it', () => {
        expect(table).toContain('ref="A1:H4"');
        expect(table).toContain('<autoFilter ref="A1:H3"/>');
        expect(table).toContain('<tableColumn id="3" name="Part"/>');
        expect(table).toContain('totalsRowFunction="average"');
        expect(sheet).toContain('<f>SUBTOTAL(101,Parts[MaxHealth])</f>');
    });

    it('shades every numeric column against the compared part', () => {
        expect(sheet).toContain('<conditionalFormatting sqref="E2:E3">');
        expect(sheet).toContain('AND(ISNUMBER(E2),$E$2&lt;&gt;0,E2/$E$2&gt;2)');
    });

    it('keeps a grouping column and a column of the same name apart', () => {
        const clash = buildPartTableWorkbook({ ...model, groupHeaders: ['Part'] });
        const table = unzip(Buffer.from(clash.base64, 'base64')).get('xl/tables/table1.xml') ?? '';
        expect(table).toContain('name="Part"');
        expect(table).toContain('name="Part (2)"');
    });

    it('exports the headers alone when the view has no rows left', () => {
        const empty = buildPartTableWorkbook({ ...model, rows: [] });
        const parts = unzip(Buffer.from(empty.base64, 'base64'));
        expect(parts.has('xl/tables/table1.xml')).toBe(false);
        expect(parts.get('xl/worksheets/sheet1.xml')).toContain('MaxHealth');
    });

    it('follows the part column when the reader has moved it', () => {
        const moved = buildPartTableWorkbook({
            ...model,
            groupHeaders: undefined,
            columns: [model.columns[2], model.columns[0], ...model.columns.slice(3)],
            rows: model.rows.map((row) => ({
                ...row,
                groups: undefined,
                cells: [row.cells[2], row.cells[0], ...row.cells.slice(3)],
            })),
        });
        const parts = unzip(Buffer.from(moved.base64, 'base64'));
        // The link to the file rides on the part's own column rather than on whichever is first.
        expect(parts.get('xl/worksheets/sheet1.xml')).toContain('<hyperlink ref="B2"');
        // The first column now averages, so the totals row has no cell free for the label.
        expect(parts.get('xl/tables/table1.xml')).not.toContain('totalsRowLabel');
    });

    it('refuses a formula column that reads itself', () => {
        const circular = buildPartTableWorkbook({
            ...model,
            columns: [
                ...model.columns.slice(0, 5),
                { key: 'formula:0', label: 'Loop', numeric: true, formula: '[Loop] + 1' },
            ],
        });
        const parts = unzip(Buffer.from(circular.base64, 'base64'));
        // The totals row still averages the column. What must not be there is a cell reading itself.
        expect(parts.get('xl/worksheets/sheet1.xml')).not.toContain('[#This Row],[Loop]');
        expect(parts.get('xl/worksheets/sheet2.xml')).toContain('reads itself');
    });

    it('refuses two formula columns that read each other', () => {
        const mutual = buildPartTableWorkbook({
            ...model,
            columns: [
                ...model.columns.slice(0, 5),
                { key: 'formula:0', label: 'There', numeric: true, formula: '[Back] + 1' },
                { key: 'formula:1', label: 'Back', numeric: true, formula: '[There] - 1' },
            ],
        });
        const about = unzip(Buffer.from(mutual.base64, 'base64')).get('xl/worksheets/sheet2.xml') ?? '';
        expect(about.match(/reads itself/g)?.length).toBe(2);
    });

    it('says on its second sheet what the export was made of', () => {
        const about = parts.get('xl/worksheets/sheet2.xml') ?? '';
        expect(about).toContain('Cosmoteer part table');
        expect(about).toContain('The game and Star Wars');
        expect(about).toContain('2 of 412 parts');
        expect(about).toContain('[MaxHealth] / [@Tiles]');
    });

    it('writes the numbers alone for a formula the translation refuses', () => {
        const perTile = buildPartTableWorkbook({ ...model, perTile: true });
        const sheets = unzip(Buffer.from(perTile.base64, 'base64'));
        expect(sheets.get('xl/worksheets/sheet1.xml')).not.toContain('<f>(Parts');
        expect(sheets.get('xl/worksheets/sheet2.xml')).toContain('divided by the tiles');
    });
});
