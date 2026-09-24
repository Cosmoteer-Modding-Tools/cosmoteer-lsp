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

    it('writes a drive letter into the link the way Excel reads one', () => {
        // A document uri escapes the drive colon, and Excel reads the escape as part of the name
        // and refuses the workbook over it. The escapes of a space and a bracket are read the way
        // they are meant, so those stay.
        const windows = buildPartTableWorkbook({
            ...model,
            rows: [
                {
                    ...model.rows[0],
                    uri: 'file:///C%3A/Program%20Files%20(x86)/Steam/steamapps/common/Cosmoteer/Data/cannon_deck.rules',
                },
            ],
        });
        const rels = unzip(Buffer.from(windows.base64, 'base64')).get('xl/worksheets/_rels/sheet1.xml.rels') ?? '';
        expect(rels).toContain(
            'Target="file:///C:/Program%20Files%20(x86)/Steam/steamapps/common/Cosmoteer/Data/cannon_deck.rules"'
        );
        expect(rels).not.toContain('%3A');
    });

    it('leaves a colon escaped where it is part of a name rather than a drive', () => {
        // Only a drive letter at the front is rewritten. A file whose name holds a colon, which
        // the systems without drive letters allow, keeps the escape that says so.
        const posix = buildPartTableWorkbook({
            ...model,
            rows: [{ ...model.rows[0], uri: 'file:///home/mod/odd%3Aname/cannon_deck.rules' }],
        });
        const rels = unzip(Buffer.from(posix.base64, 'base64')).get('xl/worksheets/_rels/sheet1.xml.rels') ?? '';
        expect(rels).toContain('Target="file:///home/mod/odd%3Aname/cannon_deck.rules"');
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

    it('names a column Excel reads as syntax the way a formula has to name it', () => {
        // A reader names a formula column freely, and the characters Excel reads as syntax inside a
        // structured reference reach the totals row as syntax unless they are quoted. The column's
        // own name and its header cell stay as they were written, which is how Excel writes them.
        const odd = buildPartTableWorkbook({
            ...model,
            columns: [
                ...model.columns.slice(0, 5),
                { key: 'formula:0', label: "Bob's [odd] #1 @rank", numeric: true, formula: '[MaxHealth] + 1' },
            ],
        });
        const parts = unzip(Buffer.from(odd.base64, 'base64'));
        expect(parts.get('xl/worksheets/sheet1.xml')).toContain(
            '<f>SUBTOTAL(101,Parts[Bob&apos;&apos;s &apos;[odd&apos;] &apos;#1 &apos;@rank])</f>'
        );
        expect(parts.get('xl/tables/table1.xml')).toContain('name="Bob&apos;s [odd] #1 @rank"');
        expect(parts.get('xl/worksheets/sheet1.xml')).toContain(
            '<t xml:space="preserve">Bob&apos;s [odd] #1 @rank</t>'
        );
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

    it('tells a typed-over value apart from one read out of the files', () => {
        // The first part's cost was typed over. It keeps the credits format of its column and is
        // written in italics on top of it, which is the mark the view puts on such a cell.
        const guessed = buildPartTableWorkbook({
            ...model,
            rows: [{ ...model.rows[0], typed: [4] }, model.rows[1]],
        });
        const parts = unzip(Buffer.from(guessed.base64, 'base64'));
        const sheet = parts.get('xl/worksheets/sheet1.xml') ?? '';
        const typedStyle = /<c r="G2" s="(\d+)"/.exec(sheet)?.[1];
        const readStyle = /<c r="E2" s="(\d+)"/.exec(sheet)?.[1];
        expect(typedStyle).toBeDefined();
        expect(typedStyle).not.toBe(readStyle);
        const styles = parts.get('xl/styles.xml') ?? '';
        const format = new RegExp(`<xf numFmtId="(\\d+)" fontId="(\\d+)"[^>]*>(?:(?!</?xf).)*</xf>`, 'g');
        const written = [...styles.matchAll(format)][Number(typedStyle)];
        const fonts = [...styles.matchAll(/<font>(.*?)<\/font>/g)].map((entry) => entry[1]);
        expect(fonts[Number(written[2])]).toContain('<i/>');
        // The credits format rides along rather than being swapped out for the italics.
        expect(Number(written[1])).toBeGreaterThan(0);
    });

    it('says on its second sheet which values were typed over the table', () => {
        const guessed = buildPartTableWorkbook({
            ...model,
            rows: [
                { ...model.rows[0], typed: [2, 4] },
                { ...model.rows[1], typed: [2] },
            ],
        });
        const about = unzip(Buffer.from(guessed.base64, 'base64')).get('xl/worksheets/sheet2.xml') ?? '';
        expect(about).toContain('Typed values');
        expect(about).toContain('3 values were typed over the table');
        expect(about).toContain('MaxHealth, Cost');
    });

    it('says on its second sheet what the export was made of', () => {
        const about = parts.get('xl/worksheets/sheet2.xml') ?? '';
        expect(about).toContain('Cosmoteer part table');
        expect(about).toContain('The game and Star Wars');
        expect(about).toContain('2 of 412 parts');
        expect(about).toContain('[MaxHealth] / [@Tiles]');
    });

    it('writes a number too large for a decimal as the exponent it is', () => {
        // A fixed twelve decimal places answers an exponent of its own from 1e21 up, and cutting
        // the zeroes off that answer cuts the exponent, which wrote 1e30 into the file as 1000.
        const huge = buildPartTableWorkbook({
            ...model,
            rows: [{ ...model.rows[0], cells: ['cannon_deck', 'Cosmoteer', 1e30, 6, 250, 1e-13] }, model.rows[1]],
        });
        const sheet = unzip(Buffer.from(huge.base64, 'base64')).get('xl/worksheets/sheet1.xml') ?? '';
        expect(sheet).toContain('<v>1e+30</v>');
        expect(sheet).toContain('<v>1e-13</v>');
        expect(sheet).not.toContain('<v>1000</v>');
    });

    it('writes a number a formula multiplies by as the number it is', () => {
        const scaled = buildPartTableWorkbook({
            ...model,
            columns: [
                ...model.columns.slice(0, 5),
                { key: 'formula:0', label: 'Scaled', numeric: true, formula: '[MaxHealth] * 1e30' },
            ],
        });
        const sheet = unzip(Buffer.from(scaled.base64, 'base64')).get('xl/worksheets/sheet1.xml') ?? '';
        expect(sheet).toContain('*1e+30)');
    });

    it('cuts a text value at the longest one the format takes', () => {
        // Excel refuses the whole workbook over one longer cell, so the value costs itself.
        const long = buildPartTableWorkbook({
            ...model,
            rows: [{ ...model.rows[0], cells: ['x'.repeat(40000), 'Cosmoteer', 4000, 6, 250, 666] }, model.rows[1]],
        });
        const sheet = unzip(Buffer.from(long.base64, 'base64')).get('xl/worksheets/sheet1.xml') ?? '';
        const written = /<c r="C2"[^>]*><is><t xml:space="preserve">(x*…?)<\/t>/.exec(sheet)?.[1] ?? '';
        expect(written.length).toBe(32767);
        expect(written.endsWith('…')).toBe(true);
    });

    it('writes the numbers alone for a formula that compares against a part the sheet does not hold', () => {
        // The lookup reads the sheet's own id column, so a compared part the filter or the search
        // took off the sheet would leave every cell of the column reading #N/A.
        const away = buildPartTableWorkbook({
            ...model,
            referenceId: 'ion_beam_prism',
            columns: [
                ...model.columns.slice(0, 5),
                { key: 'formula:0', label: 'Share', numeric: true, formula: '[MaxHealth] / ref([MaxHealth]) * 100' },
            ],
        });
        const sheets = unzip(Buffer.from(away.base64, 'base64'));
        expect(sheets.get('xl/worksheets/sheet1.xml')).not.toContain('MATCH(&quot;ion_beam_prism&quot;');
        expect(sheets.get('xl/worksheets/sheet2.xml')).toContain('not one of the exported rows');
        // The part it was compared against is still recorded, since the numbers were computed
        // against it.
        expect(sheets.get('xl/worksheets/sheet2.xml')).toContain('ion_beam_prism');
    });

    it('writes a formula column against a compared part the sheet does hold', () => {
        const here = buildPartTableWorkbook({
            ...model,
            columns: [
                ...model.columns.slice(0, 5),
                { key: 'formula:0', label: 'Share', numeric: true, formula: '[MaxHealth] / ref([MaxHealth]) * 100' },
            ],
        });
        const sheet = unzip(Buffer.from(here.base64, 'base64')).get('xl/worksheets/sheet1.xml') ?? '';
        expect(sheet).toContain('MATCH(&quot;cannon_deck&quot;');
    });

    it('writes the numbers alone for a formula the translation refuses', () => {
        const perTile = buildPartTableWorkbook({ ...model, perTile: true });
        const sheets = unzip(Buffer.from(perTile.base64, 'base64'));
        expect(sheets.get('xl/worksheets/sheet1.xml')).not.toContain('<f>(Parts');
        expect(sheets.get('xl/worksheets/sheet2.xml')).toContain('divided by the tiles');
    });
});
