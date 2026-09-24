import { deflateRawSync } from 'zlib';

/**
 * A minimal writer for the Office Open XML spreadsheet format, enough for the workbooks this
 * server hands out: sheets of numbers and text, real formulas, a table with its filter and its
 * totals row, frozen panes, number formats, conditional shading and hyperlinks.
 *
 * It is written here rather than taken from a package because what a workbook of ours needs is a
 * small corner of the format, and the file it produces is a few kilobytes of XML in a zip. The
 * parts it writes are the ones Excel requires of any workbook, in the order the schema declares
 * them, which is what keeps Excel from offering to repair the file.
 */

/** Where a cell's hyperlink points, and what the tooltip over it says. */
export interface XlsxLink {
    /** The target, an absolute URI. */
    readonly target: string;
    /** The tooltip, absent for none. */
    readonly tooltip?: string;
}

/** One cell of a sheet. A blank cell still carries its style, which is what shades an empty run. */
export type XlsxCell =
    | { readonly kind: 'blank'; readonly style?: number }
    | { readonly kind: 'text'; readonly text: string; readonly style?: number; readonly link?: XlsxLink }
    | {
          readonly kind: 'number';
          readonly value: number | null;
          readonly formula?: string;
          readonly style?: number;
      };

/** How wide a column is drawn, in character widths, and the style its cells default to. */
export interface XlsxColumn {
    readonly width?: number;
    readonly style?: number;
}

/** What a table's totals row computes for one column. */
export type XlsxTotal = 'average' | 'sum' | 'count' | 'min' | 'max';

/** The formats a totals row cell computes with, by what the column asks for. */
const TOTALS_FUNCTION: Readonly<Record<XlsxTotal, number>> = {
    average: 101,
    sum: 109,
    count: 103,
    min: 105,
    max: 104,
};

/**
 * A table over a rectangle of a sheet: the thing Excel calls a table, with a filter on every
 * column, banded rows, and column names that formulas can name instead of addressing cells.
 */
export interface XlsxTable {
    /** The table's name, which structured references in formulas are written against. */
    readonly name: string;
    /** The column names, in order. Each has to be unique and non-empty, as Excel requires. */
    readonly headers: readonly string[];
    /** The one-based row the header sits on. */
    readonly headerRow: number;
    /** The one-based row the last data row sits on. */
    readonly lastRow: number;
    /** The one-based column the table starts at. */
    readonly firstColumn: number;
    /** What the totals row computes per column, absent for a table without one. */
    readonly totals?: readonly (XlsxTotal | undefined)[];
    /** The label the totals row carries in its first cell, when there is a totals row. */
    readonly totalsLabel?: string;
}

/** One conditional shading rule: a formula that is true where the differential format applies. */
export interface XlsxConditionalRule {
    /** The condition, written against the top left cell of the range. */
    readonly formula: string;
    /** The index into the workbook's differential formats. */
    readonly format: number;
}

/** A range and the rules that shade it, first match winning. */
export interface XlsxConditionalFormat {
    /** The range in A1 notation. */
    readonly range: string;
    readonly rules: readonly XlsxConditionalRule[];
}

/** One sheet of the workbook. */
export interface XlsxSheet {
    /** The tab name. Excel refuses more than 31 characters and the `[]:*?/\` characters. */
    readonly name: string;
    /** The columns, by position, for their widths. A column with no entry sizes itself. */
    readonly columns?: readonly XlsxColumn[];
    /** The rows, each a row of cells from column A. */
    readonly rows: readonly (readonly XlsxCell[])[];
    /** How many rows and columns stay put while the rest scrolls. */
    readonly freeze?: { readonly rows: number; readonly columns: number };
    /** The table over the sheet's rectangle, absent for a plain sheet. */
    readonly table?: XlsxTable;
    /** The conditional shading of the sheet. */
    readonly conditionalFormats?: readonly XlsxConditionalFormat[];
}

/**
 * A cell format. Every field is optional, and a style with none of them is the workbook default,
 * which is what the first entry of a workbook's styles has to be.
 */
export interface XlsxStyle {
    /** The number format code, `#,##0.00`, absent for the general format. */
    readonly numberFormat?: string;
    readonly bold?: boolean;
    readonly italic?: boolean;
    /** The font colour as `RRGGBB`. */
    readonly color?: string;
    /** The solid fill colour as `RRGGBB`. */
    readonly fill?: string;
    /** Whether the text wraps inside the cell. */
    readonly wrap?: boolean;
    readonly align?: 'left' | 'center' | 'right';
}

/** The whole workbook. */
export interface XlsxWorkbook {
    readonly sheets: readonly XlsxSheet[];
    /** The cell formats, addressed by a cell's `style`. The first entry is the sheet default. */
    readonly styles: readonly XlsxStyle[];
    /** The formats conditional shading picks from, addressed by a rule's `format`. */
    readonly dxfs?: readonly XlsxStyle[];
}

/** One file of the zip, already encoded. */
interface ZipEntry {
    readonly name: string;
    readonly data: Buffer;
}

/** The table of the polynomial the zip format's checksum is built on, computed once. */
const CRC_TABLE = ((): Int32Array => {
    const table = new Int32Array(256);
    for (let byte = 0; byte < 256; byte++) {
        let value = byte;
        for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
        table[byte] = value;
    }
    return table;
})();

/**
 * The zip checksum of a buffer.
 *
 * @param data the bytes.
 * @returns the checksum as an unsigned 32 bit number.
 */
const crc32 = (data: Buffer): number => {
    let crc = -1;
    for (let at = 0; at < data.length; at++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ data[at]) & 0xff];
    return (crc ^ -1) >>> 0;
};

/**
 * Packs the entries into a zip archive, every entry deflated.
 *
 * @param entries the files, in the order they are stored.
 * @returns the archive.
 */
const zip = (entries: readonly ZipEntry[]): Buffer => {
    const locals: Buffer[] = [];
    const central: Buffer[] = [];
    let offset = 0;
    for (const entry of entries) {
        const name = Buffer.from(entry.name, 'utf8');
        const deflated = deflateRawSync(entry.data, { level: 9 });
        const checksum = crc32(entry.data);
        const local = Buffer.alloc(30 + name.length);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0, 6);
        local.writeUInt16LE(8, 8);
        local.writeUInt16LE(0, 10);
        local.writeUInt16LE(0, 12);
        local.writeUInt32LE(checksum, 14);
        local.writeUInt32LE(deflated.length, 18);
        local.writeUInt32LE(entry.data.length, 22);
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(0, 28);
        name.copy(local, 30);
        locals.push(local, deflated);

        const header = Buffer.alloc(46 + name.length);
        header.writeUInt32LE(0x02014b50, 0);
        header.writeUInt16LE(20, 4);
        header.writeUInt16LE(20, 6);
        header.writeUInt16LE(0, 8);
        header.writeUInt16LE(8, 10);
        header.writeUInt16LE(0, 12);
        header.writeUInt16LE(0, 14);
        header.writeUInt32LE(checksum, 16);
        header.writeUInt32LE(deflated.length, 20);
        header.writeUInt32LE(entry.data.length, 24);
        header.writeUInt16LE(name.length, 28);
        header.writeUInt32LE(0, 38);
        header.writeUInt32LE(offset, 42);
        name.copy(header, 46);
        central.push(header);
        offset += local.length + deflated.length;
    }
    const directory = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, directory, end]);
};

/**
 * The text with the five characters XML reserves escaped, and the control characters the format
 * forbids dropped, since a value read out of a file can carry anything.
 *
 * @param text the text.
 * @returns the escaped text.
 */
const xml = (text: string): string =>
    text
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');

/** The longest text the format takes in one cell. */
const LONGEST_TEXT = 32767;

/**
 * A text cell's text, cut to the longest one the format takes. Excel refuses a whole workbook over
 * one longer cell, so a value that cannot be written whole costs itself rather than the file.
 *
 * @param text the text.
 * @returns the text, with an ellipsis where it was cut.
 */
const cellText = (text: string): string => {
    if (text.length <= LONGEST_TEXT) return text;
    const kept = text.slice(0, LONGEST_TEXT - 1);
    // A cut between the halves of a surrogate pair leaves a character XML has no place for.
    return `${/[\uD800-\uDBFF]$/.test(kept) ? kept.slice(0, -1) : kept}…`;
};

/**
 * The column's letters, `A` for the first and `AA` for the twenty seventh.
 *
 * @param column the one-based column number.
 * @returns the letters.
 */
export const columnLetters = (column: number): string => {
    let letters = '';
    let left = column;
    while (left > 0) {
        const remainder = (left - 1) % 26;
        letters = String.fromCharCode(65 + remainder) + letters;
        left = Math.floor((left - remainder) / 26);
    }
    return letters;
};

/**
 * A cell's address.
 *
 * @param row the one-based row.
 * @param column the one-based column.
 * @returns the address in A1 notation.
 */
export const cellAddress = (row: number, column: number): string => `${columnLetters(column)}${row}`;

/**
 * A number as the format writes it: a plain decimal wherever one says the same thing, since a
 * reader takes `0.0000001` better than `1e-7`.
 *
 * The exponent form stands at both ends of the range, where a decimal cannot say it. Excel reads
 * either, in a cell value and in a formula alike, and writing the decimal there would be writing a
 * different number: a fixed twelve places answers an exponent of its own from 1e21 up and rounds
 * everything under 1e-12 away to nothing.
 *
 * @param value the number.
 * @returns the text of the number.
 */
export const numberText = (value: number): string => {
    const text = String(value);
    if (!/e/i.test(text)) return text;
    const size = Math.abs(value);
    if (size >= 1e21 || size < 1e-12) return text;
    // Only the zeroes behind the last digit that says something go, never a digit of the number.
    return value
        .toFixed(12)
        .replace(/(\.\d*[1-9])0+$/, '$1')
        .replace(/\.0*$/, '');
};

/**
 * The styles part: the number formats, fonts, fills and cell formats every style asks for, plus
 * the differential formats the conditional shading picks from.
 *
 * @param styles the cell formats.
 * @param dxfs the differential formats.
 * @returns the part's XML.
 */
const stylesXml = (styles: readonly XlsxStyle[], dxfs: readonly XlsxStyle[]): string => {
    const formats: string[] = [];
    const formatId = (code: string | undefined): number => {
        // The general format is the one every workbook already has, under the identity zero.
        if (!code || code === 'General') return 0;
        const known = formats.indexOf(code);
        if (known !== -1) return 164 + known;
        formats.push(code);
        return 164 + formats.length - 1;
    };
    const fonts: string[] = [];
    const fontId = (style: XlsxStyle): number => {
        const font =
            `<font>${style.bold ? '<b/>' : ''}${style.italic ? '<i/>' : ''}` +
            `${style.color ? `<color rgb="FF${style.color}"/>` : ''}<sz val="11"/><name val="Calibri"/></font>`;
        const known = fonts.indexOf(font);
        if (known !== -1) return known;
        fonts.push(font);
        return fonts.length - 1;
    };
    const fills: string[] = [
        '<fill><patternFill patternType="none"/></fill>',
        '<fill><patternFill patternType="gray125"/></fill>',
    ];
    const fillId = (color: string | undefined): number => {
        if (!color) return 0;
        const fill = `<fill><patternFill patternType="solid"><fgColor rgb="FF${color}"/><bgColor indexed="64"/></patternFill></fill>`;
        const known = fills.indexOf(fill);
        if (known !== -1) return known;
        fills.push(fill);
        return fills.length - 1;
    };
    // The font of every style is registered before the cell formats are written, so the font list
    // is complete by the time it is serialized.
    const cellXfs = styles.map((style) => {
        const number = formatId(style.numberFormat);
        const font = fontId(style);
        const fill = fillId(style.fill);
        const alignment =
            style.wrap || style.align
                ? `<alignment${style.align ? ` horizontal="${style.align}"` : ''}${style.wrap ? ' wrapText="1"' : ''} vertical="top"/>`
                : '';
        return (
            `<xf numFmtId="${number}" fontId="${font}" fillId="${fill}" borderId="0" xfId="0"` +
            ` applyNumberFormat="${number ? 1 : 0}" applyFont="1" applyFill="${fill ? 1 : 0}"` +
            `${alignment ? ' applyAlignment="1"' : ''}>${alignment}</xf>`
        );
    });
    const differential = dxfs.map(
        (style) =>
            '<dxf>' +
            `${style.color || style.bold ? `<font>${style.bold ? '<b/>' : ''}${style.color ? `<color rgb="FF${style.color}"/>` : ''}</font>` : ''}` +
            `${style.fill ? `<fill><patternFill><bgColor rgb="FF${style.fill}"/></patternFill></fill>` : ''}` +
            '</dxf>'
    );
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        (formats.length
            ? `<numFmts count="${formats.length}">${formats
                  .map((code, index) => `<numFmt numFmtId="${164 + index}" formatCode="${xml(code)}"/>`)
                  .join('')}</numFmts>`
            : '') +
        `<fonts count="${fonts.length}">${fonts.join('')}</fonts>` +
        `<fills count="${fills.length}">${fills.join('')}</fills>` +
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        `<cellXfs count="${cellXfs.length}">${cellXfs.join('')}</cellXfs>` +
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
        `<dxfs count="${differential.length}">${differential.join('')}</dxfs>` +
        '<tableStyles count="0" defaultTableStyle="TableStyleMedium2"/>' +
        '</styleSheet>'
    );
};

/**
 * One sheet's part, with its panes, columns, cells, shading, hyperlinks and the table over it.
 *
 * @param sheet the sheet.
 * @param links the hyperlinks found in it, filled in as the cells are written.
 * @param hasTable whether a table part is related to this sheet.
 * @returns the part's XML.
 */
const sheetXml = (
    sheet: XlsxSheet,
    links: Array<{ ref: string; id: string; target: string; tooltip?: string }>,
    hasTable: boolean
): string => {
    const width = sheet.rows.reduce((widest, row) => Math.max(widest, row.length), 0);
    const dimension = sheet.rows.length ? `A1:${cellAddress(sheet.rows.length, Math.max(width, 1))}` : 'A1';
    const freeze = sheet.freeze;
    const pane =
        freeze && (freeze.rows || freeze.columns)
            ? `<pane${freeze.columns ? ` xSplit="${freeze.columns}"` : ''}${freeze.rows ? ` ySplit="${freeze.rows}"` : ''}` +
              ` topLeftCell="${cellAddress(freeze.rows + 1, freeze.columns + 1)}" activePane="bottomRight" state="frozen"/>`
            : '';
    const columns = (sheet.columns ?? []).map((column, index) =>
        column.width === undefined && column.style === undefined
            ? ''
            : `<col min="${index + 1}" max="${index + 1}"${column.width === undefined ? '' : ` width="${column.width.toFixed(2)}" customWidth="1"`}` +
              `${column.style === undefined ? '' : ` style="${column.style}"`}/>`
    );
    const rows = sheet.rows.map((cells, rowIndex) => {
        const number = rowIndex + 1;
        const written = cells.map((cell, columnIndex) => {
            const reference = cellAddress(number, columnIndex + 1);
            const style = cell.style ? ` s="${cell.style}"` : '';
            if (cell.kind === 'text') {
                if (cell.link) {
                    links.push({
                        ref: reference,
                        id: `rId${links.length + 1}`,
                        target: cell.link.target,
                        tooltip: cell.link.tooltip,
                    });
                }
                return `<c r="${reference}"${style} t="inlineStr"><is><t xml:space="preserve">${xml(cellText(cell.text))}</t></is></c>`;
            }
            if (cell.kind === 'number') {
                const formula = cell.formula ? `<f>${xml(cell.formula)}</f>` : '';
                const value =
                    cell.value === null || !Number.isFinite(cell.value) ? '' : `<v>${numberText(cell.value)}</v>`;
                if (!formula && !value) return style ? `<c r="${reference}"${style}/>` : '';
                return `<c r="${reference}"${style}>${formula}${value}</c>`;
            }
            return style ? `<c r="${reference}"${style}/>` : '';
        });
        return `<row r="${number}">${written.join('')}</row>`;
    });
    // The priority orders the rules across the whole sheet, so the first rule that matches shades
    // the cell however many blocks the sheet carries.
    let priority = 0;
    const shading = (sheet.conditionalFormats ?? [])
        .map(
            (format) =>
                `<conditionalFormatting sqref="${format.range}">` +
                format.rules
                    .map(
                        (rule) =>
                            `<cfRule type="expression" dxfId="${rule.format}" priority="${++priority}" stopIfTrue="1">` +
                            `<formula>${xml(rule.formula)}</formula></cfRule>`
                    )
                    .join('') +
                '</conditionalFormatting>'
        )
        .join('');
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"' +
        ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        `<dimension ref="${dimension}"/>` +
        `<sheetViews><sheetView workbookViewId="0">${pane}</sheetView></sheetViews>` +
        '<sheetFormatPr defaultRowHeight="15"/>' +
        (columns.some((column) => column) ? `<cols>${columns.join('')}</cols>` : '') +
        `<sheetData>${rows.join('')}</sheetData>` +
        shading +
        (links.length
            ? `<hyperlinks>${links
                  .map(
                      (link) =>
                          `<hyperlink ref="${link.ref}" r:id="${link.id}"${link.tooltip ? ` tooltip="${xml(link.tooltip)}"` : ''}/>`
                  )
                  .join('')}</hyperlinks>`
            : '') +
        '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>' +
        (hasTable ? '<tableParts count="1"><tablePart r:id="rIdTable"/></tableParts>' : '') +
        '</worksheet>'
    );
};

/**
 * A table's part: the range it covers, the filter over it, its column names and what its totals
 * row computes.
 *
 * @param table the table.
 * @param id the part's number, which is its identity in the workbook.
 * @returns the part's XML.
 */
const tableXml = (table: XlsxTable, id: number): string => {
    const first = cellAddress(table.headerRow, table.firstColumn);
    const lastColumn = table.firstColumn + table.headers.length - 1;
    const totalsRows = table.totals ? 1 : 0;
    const reference = `${first}:${cellAddress(table.lastRow + totalsRows, lastColumn)}`;
    const filter = `${first}:${cellAddress(table.lastRow, lastColumn)}`;
    const columns = table.headers.map((header, index) => {
        const total = table.totals?.[index];
        const label =
            totalsRows && index === 0 && table.totalsLabel ? ` totalsRowLabel="${xml(table.totalsLabel)}"` : '';
        const fn = total ? ` totalsRowFunction="${total}"` : '';
        return `<tableColumn id="${index + 1}" name="${xml(header)}"${label}${fn}/>`;
    });
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        `<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="${id}" name="${xml(table.name)}"` +
        ` displayName="${xml(table.name)}" ref="${reference}" totalsRowCount="${totalsRows}">` +
        `<autoFilter ref="${filter}"/>` +
        `<tableColumns count="${columns.length}">${columns.join('')}</tableColumns>` +
        '<tableStyleInfo name="TableStyleMedium2" showFirstColumn="0" showLastColumn="0"' +
        ' showRowStripes="1" showColumnStripes="0"/>' +
        '</table>'
    );
};

/**
 * A column's name as a structured reference writes it, with the characters Excel reads as syntax
 * quoted by the single quote it uses for that.
 *
 * Excel writes the name itself raw, both in the column's own declaration and in the header cell,
 * and escapes it only where a formula names the column. A name carrying a bracket, a hash, a quote
 * or an at sign therefore reaches the totals row as syntax rather than as a name, and Excel refuses
 * the whole workbook over it, which a column a reader named after their own metric easily does.
 *
 * @param name the column's header.
 * @returns the name as a reference writes it.
 */
const specifier = (name: string): string => name.replace(/['[\]#@]/g, "'$&");

/**
 * The formula a totals row cell holds, which is the one Excel writes itself: a subtotal over the
 * table's column, so hiding rows with the filter changes the number.
 *
 * @param table the table.
 * @param column the column's position in the table, zero based.
 * @returns the formula, or null when the column has no total.
 */
export const totalsFormula = (table: XlsxTable, column: number): string | null => {
    const total = table.totals?.[column];
    if (!total) return null;
    return `SUBTOTAL(${TOTALS_FUNCTION[total]},${table.name}[${specifier(table.headers[column])}])`;
};

/**
 * Writes a workbook out as the bytes of an `.xlsx` file.
 *
 * @param workbook the sheets, their styles and the formats their shading picks from.
 * @returns the file's bytes.
 */
export const writeXlsx = (workbook: XlsxWorkbook): Buffer => {
    const entries: ZipEntry[] = [];
    const add = (name: string, text: string): void => {
        entries.push({ name, data: Buffer.from(text, 'utf8') });
    };
    const tables: Array<{ sheet: number; table: XlsxTable }> = [];
    workbook.sheets.forEach((sheet, index) => {
        if (sheet.table) tables.push({ sheet: index, table: sheet.table });
    });

    add(
        '[Content_Types].xml',
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
            '<Default Extension="xml" ContentType="application/xml"/>' +
            '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
            workbook.sheets
                .map(
                    (_, index) =>
                        `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
                )
                .join('') +
            tables
                .map(
                    (_, index) =>
                        `<Override PartName="/xl/tables/table${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/>`
                )
                .join('') +
            '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
            '</Types>'
    );
    add(
        '_rels/.rels',
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
            '</Relationships>'
    );
    add(
        'xl/workbook.xml',
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"' +
            ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
            '<workbookPr/><bookViews><workbookView/></bookViews><sheets>' +
            workbook.sheets
                .map(
                    (sheet, index) =>
                        `<sheet name="${xml(sheet.name.slice(0, 31))}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`
                )
                .join('') +
            '</sheets></workbook>'
    );
    add(
        'xl/_rels/workbook.xml.rels',
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
            workbook.sheets
                .map(
                    (_, index) =>
                        `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`
                )
                .join('') +
            `<Relationship Id="rId${workbook.sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
            '</Relationships>'
    );
    add('xl/styles.xml', stylesXml(workbook.styles, workbook.dxfs ?? []));

    workbook.sheets.forEach((sheet, index) => {
        const links: Array<{ ref: string; id: string; target: string; tooltip?: string }> = [];
        const tableIndex = tables.findIndex((entry) => entry.sheet === index);
        add(`xl/worksheets/sheet${index + 1}.xml`, sheetXml(sheet, links, tableIndex !== -1));
        if (links.length === 0 && tableIndex === -1) return;
        add(
            `xl/worksheets/_rels/sheet${index + 1}.xml.rels`,
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
                links
                    .map(
                        (link) =>
                            `<Relationship Id="${link.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink"` +
                            ` Target="${xml(link.target)}" TargetMode="External"/>`
                    )
                    .join('') +
                (tableIndex === -1
                    ? ''
                    : '<Relationship Id="rIdTable" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table"' +
                      ` Target="../tables/table${tableIndex + 1}.xml"/>`) +
                '</Relationships>'
        );
    });
    tables.forEach((entry, index) => add(`xl/tables/table${index + 1}.xml`, tableXml(entry.table, index + 1)));
    return zip(entries);
};
