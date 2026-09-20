import * as l10n from '@vscode/l10n';
import { ExcelColumn, toExcelFormula } from './part-table.excel-formula';
import { Node, parseFormula } from './part-table.formula';
import {
    PartTableWorkbookColumn,
    PartTableWorkbookModel,
    PartTableWorkbookResult,
    PartTableUnit,
} from './part-table.types';
import { XlsxCell, XlsxConditionalFormat, XlsxSheet, XlsxStyle, columnLetters, totalsFormula, writeXlsx } from './xlsx';

/**
 * Builds the workbook the part table exports: the rows and columns on screen as a real Excel
 * table, with the numbers as numbers, the formula columns as live Excel formulas, the comparison
 * against another part as conditional shading, and a second sheet saying what the export was made
 * of.
 *
 * The view sends what it is showing rather than being read again here, so the workbook holds
 * exactly the parts, columns, order and typed-over values the reader was looking at.
 */

/** The name the workbook's table carries, which every structured reference is written against. */
const TABLE_NAME = 'Parts';

/** The view's key for the column holding the part's id, which the reader can move and unpin. */
const ID_KEY = 'id';

/** How far from the compared part a value has to be for the stronger shade, as the view shades it. */
const FAR_FACTOR = 2;

/** How close to the compared part a value counts as the same, as the view shades it. */
const SAME_BAND = 0.005;

/**
 * The shades of the comparison, the view's own colours laid over white, since a spreadsheet fill
 * has no transparency to lay them over the row banding with.
 */
const SHADES = {
    same: 'E8E8E8',
    above: 'F4D3D3',
    farAbove: 'ECB0B0',
    below: 'C9E1F4',
    farBelow: 'A0C9EC',
};

/**
 * The number format a column is written with, so a value reads as the thing it measures.
 *
 * Excel keeps the decimal separator of a format that has one even where a value has no decimals,
 * `4000` under `#,##0.####` reading as `4,000.`, so a column of whole numbers is given a format
 * without one rather than a format that only sometimes needs it.
 *
 * @param unit the unit the column's numbers carry, absent for a plain number.
 * @param fractional whether any exported value of the column has decimals.
 * @returns the format code.
 */
const formatFor = (unit: PartTableUnit | undefined, fractional: boolean): string => {
    switch (unit) {
        case 'percent':
            return fractional ? '0.##%' : '0%';
        case 'angle':
            return fractional ? '0.####" rad"' : '0" rad"';
        case 'seconds':
            return fractional ? '0.###" s"' : '0" s"';
        case 'credits':
            return fractional ? '#,##0.##' : '#,##0';
        default:
            // The general format is the one that leaves a whole number whole, at the price of the
            // thousands separators a column of whole numbers can have.
            return fractional ? 'General' : '#,##0';
    }
};

/**
 * A name a file system takes, for the workbook the save dialog opens on.
 *
 * @param text the name as it reads.
 * @returns the name with everything a path separator or a reserved character replaced.
 */
const fileSafe = (text: string): string =>
    text
        .replace(/[\\/:*?"<>|]/g, '-')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');

/**
 * A date and time as the reader's own clock has it, since a stamp on an export is read against the
 * day the reader is having rather than against the one in London.
 *
 * @param at the moment.
 * @param withTime whether the time of day rides along.
 * @returns the stamp.
 */
const stampOf = (at: Date, withTime: boolean): string => {
    const pad = (value: number): string => String(value).padStart(2, '0');
    const day = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
    return withTime ? `${day} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}` : day;
};

/**
 * The header a column carries in the workbook: its context and its label as one line, since a
 * table column is named by one string.
 *
 * @param column the column as the view sends it.
 * @returns the header.
 */
const headerOf = (column: PartTableWorkbookColumn): string =>
    column.context ? `${column.context} › ${column.label}` : column.label;

/**
 * The headers of the whole sheet, made unique, since Excel refuses a table with two columns of one
 * name. The view can show two columns that shorten to the same header, and a grouping column can
 * carry the name of a column beside it.
 *
 * @param model what the view is showing.
 * @returns the grouping headers and the column headers, each in order.
 */
const uniqueHeaders = (model: PartTableWorkbookModel): { groups: string[]; columns: string[] } => {
    const used = new Set<string>();
    const unique = (wanted: string): string => {
        let header = wanted;
        let ordinal = 2;
        while (used.has(header.toLowerCase())) header = `${wanted} (${ordinal++})`;
        used.add(header.toLowerCase());
        return header;
    };
    return {
        groups: (model.groupHeaders ?? []).map((header, index) => unique(header || `Group ${index + 1}`)),
        columns: model.columns.map((column) => unique(headerOf(column) || column.key)),
    };
};

/**
 * How wide a column is drawn: the width the reader dragged, converted from pixels, or one that
 * fits the header.
 *
 * @param column the column.
 * @param header the header it carries.
 * @returns the width in character widths.
 */
const widthOf = (column: PartTableWorkbookColumn, header: string): number => {
    if (column.width) return Math.min(60, Math.max(6, Math.round((column.width - 5) / 7)));
    const longest = header.split(' › ').reduce((most, piece) => Math.max(most, piece.length), 0);
    return Math.min(28, Math.max(9, longest + 2));
};

/**
 * Whether a column shows decimals once its format has had its way with the numbers. A percentage
 * is written as the fraction it is and shown times a hundred, so a rate of a quarter is a whole
 * number on the sheet even though the value it is written from is not.
 *
 * @param model what the view is showing.
 * @param index the column's position among the view's columns.
 * @param unit the unit the column's numbers carry.
 * @returns true when any exported value of the column is shown with decimals.
 */
const hasDecimals = (model: PartTableWorkbookModel, index: number, unit: PartTableUnit | undefined): boolean =>
    model.rows.some((row) => {
        const value = row.cells[index];
        if (typeof value !== 'number') return false;
        return !Number.isInteger(unit === 'percent' ? value * 100 : value);
    });

/** The styles a workbook is built from, gathered as the sheets ask for them. */
class Styles {
    private readonly entries: XlsxStyle[] = [{}];

    /**
     * The index of a style, adding it on first use so the workbook carries each format once.
     *
     * @param style the format.
     * @returns the index a cell addresses it by.
     */
    public id(style: XlsxStyle): number {
        const key = JSON.stringify(style);
        const known = this.entries.findIndex((entry) => JSON.stringify(entry) === key);
        if (known !== -1) return known;
        this.entries.push(style);
        return this.entries.length - 1;
    }

    /**
     * The styles as the writer takes them.
     *
     * @returns the list, its first entry the default.
     */
    public all(): readonly XlsxStyle[] {
        return this.entries;
    }
}

/**
 * The formula columns written out as Excel formulas, each with the reason where it has none.
 *
 * @param model what the view is showing.
 * @param headers the header of each column, in order.
 * @returns the Excel formula or the reason, by column key.
 */
const translateFormulas = (
    model: PartTableWorkbookModel,
    headers: readonly string[]
): Map<string, { formula?: string; reason?: string }> => {
    const translated = new Map<string, { formula?: string; reason?: string }>();
    const circular = circularFormulas(model);
    const blank = model.columns.map((column, index) =>
        model.rows.some((row) => row.cells[index] === null || row.cells[index] === undefined)
    );
    const columns: ExcelColumn[] = [];
    model.columns.forEach((column, index) => {
        // A formula names a real column by its path and another formula column by its name, which
        // is how the evaluator resolves them too.
        const path = column.formula === undefined ? (column.path ?? column.key) : column.label;
        columns.push({ path, name: headers[index], blank: blank[index] });
    });
    const context = {
        table: TABLE_NAME,
        columns,
        idColumn: headers[idColumnOf(model)],
        referenceId: model.referenceId,
    };
    for (const column of model.columns) {
        if (column.formula === undefined) continue;
        if (model.perTile) {
            translated.set(column.key, {
                reason: l10n.t('every number is divided by the tiles the part covers'),
            });
            continue;
        }
        if (circular.has(column.key)) {
            // A cell of Excel that reads itself is a circular reference the whole workbook
            // complains about, where the view's evaluator answers nothing and moves on.
            translated.set(column.key, { reason: l10n.t('it reads itself, directly or through another column') });
            continue;
        }
        const result = toExcelFormula(column.formula, context);
        translated.set(column.key, 'formula' in result ? { formula: result.formula } : { reason: result.reason });
    }
    return translated;
};

/**
 * Which column holds the part's id. It opens the table as the first column and stays there for
 * most readers, but the view lets it be unpinned and dragged, and the link to the part's file and
 * the lookup of the compared part both have to follow it.
 *
 * @param model what the view is showing.
 * @returns the column's position among the view's columns, zero when the view sends no id column.
 */
const idColumnOf = (model: PartTableWorkbookModel): number => {
    const at = model.columns.findIndex((column) => column.key === ID_KEY);
    return at === -1 ? 0 : at;
};

/**
 * The formula columns that read themselves, straight or around through another formula column.
 *
 * @param model what the view is showing.
 * @returns the keys of the columns no Excel formula can be written for.
 */
const circularFormulas = (model: PartTableWorkbookModel): Set<string> => {
    const byName = new Map<string, PartTableWorkbookColumn>();
    for (const column of model.columns)
        if (column.formula !== undefined) byName.set(column.label.toLowerCase(), column);
    const reads = new Map<string, string[]>();
    for (const column of byName.values()) {
        const parsed = parseFormula(column.formula ?? '');
        const named: string[] = [];
        if (!('error' in parsed)) {
            const walk = (node: Node): void => {
                if (node.kind === 'column') {
                    if (byName.has(node.path.toLowerCase())) named.push(node.path.toLowerCase());
                } else if (node.kind === 'unary') walk(node.operand);
                else if (node.kind === 'binary') {
                    walk(node.left);
                    walk(node.right);
                } else if (node.kind === 'call') node.args.forEach(walk);
            };
            walk(parsed.tree);
        }
        reads.set(column.label.toLowerCase(), named);
    }
    const circular = new Set<string>();
    for (const [name, column] of byName) {
        const seen = new Set<string>();
        const reaches = (from: string): boolean => {
            for (const next of reads.get(from) ?? []) {
                if (next === name) return true;
                if (seen.has(next)) continue;
                seen.add(next);
                if (reaches(next)) return true;
            }
            return false;
        };
        if (reaches(name)) circular.add(column.key);
    }
    return circular;
};

/**
 * The shading that compares every numeric column against the part the view compares against. The
 * rules are the view's own bands, written against the compared part's cell in the same column.
 *
 * @param model what the view is showing.
 * @param styles the workbook's differential formats, added to as the rules ask for them.
 * @param firstColumn the one-based column the exported columns start at.
 * @returns one block per numeric column, empty when no exported part is being compared against.
 */
const comparisonShading = (
    model: PartTableWorkbookModel,
    styles: XlsxStyle[],
    firstColumn: number
): XlsxConditionalFormat[] => {
    const at = model.rows.findIndex((row) => row.id === model.referenceId);
    if (!model.referenceId || at === -1 || model.rows.length < 2) return [];
    const format = (fill: string): number => {
        const known = styles.findIndex((entry) => entry.fill === fill);
        if (known !== -1) return known;
        styles.push({ fill });
        return styles.length - 1;
    };
    const referenceRow = at + 2;
    const blocks: XlsxConditionalFormat[] = [];
    model.columns.forEach((column, index) => {
        if (!column.numeric) return;
        const letter = columnLetters(firstColumn + index);
        const first = `${letter}2`;
        const base = `$${letter}$${referenceRow}`;
        const ratio = `${first}/${base}`;
        const guard = `AND(ISNUMBER(${first}),${base}<>0,`;
        blocks.push({
            range: `${first}:${letter}${model.rows.length + 1}`,
            rules: [
                { formula: `${guard}ABS(${ratio}-1)<=${SAME_BAND})`, format: format(SHADES.same) },
                { formula: `${guard}${ratio}>${FAR_FACTOR})`, format: format(SHADES.farAbove) },
                { formula: `${guard}${ratio}>1)`, format: format(SHADES.above) },
                { formula: `${guard}${ratio}<${1 / FAR_FACTOR})`, format: format(SHADES.farBelow) },
                { formula: `${guard}${ratio}<1)`, format: format(SHADES.below) },
            ],
        });
    });
    return blocks;
};

/**
 * The sheet the parts are written on: the grouping columns the view groups by, then its columns,
 * as one filterable table with a totals row under it.
 *
 * @param model what the view is showing.
 * @param headers the headers of the grouping columns and of the columns.
 * @param translated the Excel formula of each formula column, or why it has none.
 * @param styles the workbook's cell formats, added to as the cells ask for them.
 * @param dxfs the workbook's differential formats, added to by the shading.
 * @returns the sheet.
 */
const partsSheet = (
    model: PartTableWorkbookModel,
    headers: { readonly groups: readonly string[]; readonly columns: readonly string[] },
    translated: ReadonlyMap<string, { formula?: string; reason?: string }>,
    styles: Styles,
    dxfs: XlsxStyle[]
): XlsxSheet => {
    const groups = headers.groups;
    const idColumn = idColumnOf(model);
    const header = styles.id({ bold: true, wrap: true, align: 'left' });
    const numberStyles = model.columns.map((column, index) =>
        styles.id({ numberFormat: formatFor(column.unit, hasDecimals(model, index, column.unit)) })
    );
    const allHeaders = [...groups, ...headers.columns];
    const rows: XlsxCell[][] = [allHeaders.map((text) => ({ kind: 'text', text, style: header }) as XlsxCell)];
    for (const row of model.rows) {
        const cells: XlsxCell[] = groups.map(
            (_, index) => ({ kind: 'text', text: row.groups?.[index] ?? '' }) as XlsxCell
        );
        model.columns.forEach((column, index) => {
            const value = row.cells[index];
            if (typeof value === 'number') {
                const excel = translated.get(column.key)?.formula;
                cells.push({ kind: 'number', value, formula: excel, style: numberStyles[index] });
                return;
            }
            if (typeof value === 'string' && value !== '') {
                // The part's own column carries the link to the file it is written in, so a row of
                // the workbook still leads back to the declaration behind it.
                const link = index === idColumn && row.uri ? { target: row.uri, tooltip: row.file } : undefined;
                cells.push({ kind: 'text', text: value, link });
                return;
            }
            cells.push({ kind: 'blank' });
        });
        rows.push(cells);
    }

    const averages =
        model.rows.length > 1 ? allHeaders.map((_, index) => averageOf(index, groups.length, model)) : undefined;
    const table = {
        name: TABLE_NAME,
        headers: allHeaders,
        headerRow: 1,
        lastRow: model.rows.length + 1,
        firstColumn: 1,
        totals: averages,
        // The label sits in the first cell of the totals row, which only a column without an
        // average of its own has room for.
        totalsLabel: averages && averages[0] === undefined ? l10n.t('Average') : undefined,
    };
    const totalStyles = model.columns.map((column) => styles.id({ numberFormat: formatFor(column.unit, true) }));
    if (table.totals) {
        const label = table.totalsLabel;
        const totals: XlsxCell[] = allHeaders.map((_, index) => {
            if (index === 0 && label) return { kind: 'text', text: label, style: header };
            const formula = totalsFormula(table, index);
            if (!formula) return { kind: 'blank' };
            const column = index - groups.length;
            // An average has decimals where the column it folds has none, so the totals row is
            // written with the format that keeps them.
            return { kind: 'number', value: null, formula, style: totalStyles[column] };
        });
        rows.push(totals);
    }

    return {
        name: l10n.t('Parts'),
        columns: [
            ...groups.map((text) => ({ width: Math.min(28, Math.max(12, text.length + 2)) })),
            ...model.columns.map((column, index) => ({ width: widthOf(column, headers.columns[index]) })),
        ],
        rows,
        freeze: { rows: 1, columns: groups.length + model.columns.filter((column) => column.frozen).length },
        // A table of Excel's needs a row under its header, so an empty view exports its headers
        // as a plain sheet rather than as a table Excel would refuse to open.
        table: model.rows.length > 0 ? table : undefined,
        conditionalFormats: comparisonShading(model, dxfs, groups.length + 1),
    };
};

/**
 * Whether a column of the sheet gets an average in the totals row, which the numeric ones do.
 *
 * @param index the column's position on the sheet.
 * @param groupCount how many grouping columns come first.
 * @param model what the view is showing.
 * @returns the totals function, or undefined for a column that is not a number.
 */
const averageOf = (index: number, groupCount: number, model: PartTableWorkbookModel): 'average' | undefined => {
    if (index < groupCount) return undefined;
    return model.columns[index - groupCount]?.numeric ? 'average' : undefined;
};

/**
 * The sheet that says what the export was made of: when it was taken, which parts it holds, what
 * was filtered out, what it was compared against, and every formula column with the Excel formula
 * it was written as.
 *
 * @param model what the view is showing.
 * @param translated the Excel formula of each formula column, or why it has none.
 * @param styles the workbook's cell formats.
 * @returns the sheet.
 */
const aboutSheet = (
    model: PartTableWorkbookModel,
    translated: ReadonlyMap<string, { formula?: string; reason?: string }>,
    styles: Styles
): XlsxSheet => {
    const title = styles.id({ bold: true });
    const wrapped = styles.id({ wrap: true });
    const rows: XlsxCell[][] = [];
    const line = (label: string, value: string): void => {
        rows.push([
            { kind: 'text', text: label, style: title },
            { kind: 'text', text: value, style: wrapped },
        ]);
    };
    rows.push([{ kind: 'text', text: l10n.t('Cosmoteer part table'), style: title }]);
    line(l10n.t('Exported'), stampOf(new Date(), true));
    line(l10n.t('Parts'), model.mod ? l10n.t('The game and {0}', model.mod) : l10n.t('The game alone'));
    line(l10n.t('Rows'), l10n.t('{0} of {1} parts', model.rows.length, model.total || model.rows.length));
    line(l10n.t('Columns'), String(model.columns.length));
    if (model.search) line(l10n.t('Filter'), model.search);
    for (const filter of model.filters ?? []) line(filter.label, filter.value);
    if (model.referenceId) line(l10n.t('Compared with'), model.referenceId);
    if (model.perTile) line(l10n.t('Per tile'), l10n.t('Every number is divided by the tiles the part covers.'));
    if (model.asPercent) {
        line(
            l10n.t('Percentages'),
            l10n.t('The view was showing percentages of the compared part. The workbook holds the values themselves.')
        );
    }
    const formulas = model.columns.filter((column) => column.formula !== undefined);
    if (formulas.length > 0) {
        rows.push([]);
        rows.push([
            { kind: 'text', text: l10n.t('Formula column'), style: title },
            { kind: 'text', text: l10n.t('As written'), style: title },
            { kind: 'text', text: l10n.t('In the workbook'), style: title },
        ]);
        for (const column of formulas) {
            const result = translated.get(column.key);
            rows.push([
                { kind: 'text', text: column.label, style: wrapped },
                { kind: 'text', text: column.formula ?? '', style: wrapped },
                {
                    kind: 'text',
                    text: result?.formula
                        ? `=${result.formula}`
                        : l10n.t('The numbers alone, since {0}.', result?.reason ?? ''),
                    style: wrapped,
                },
            ]);
        }
    }
    return { name: l10n.t('About'), columns: [{ width: 22 }, { width: 46 }, { width: 60 }], rows };
};

/**
 * Builds the workbook for what the part table is showing.
 *
 * @param model the rows, columns and formulas the view sends.
 * @returns the file's bytes as base64, with the name the save dialog opens on.
 */
export const buildPartTableWorkbook = (model: PartTableWorkbookModel): PartTableWorkbookResult => {
    const headers = uniqueHeaders(model);
    const translated = translateFormulas(model, headers.columns);
    const styles = new Styles();
    const dxfs: XlsxStyle[] = [];
    const parts = partsSheet(model, headers, translated, styles, dxfs);
    const about = aboutSheet(model, translated, styles);
    const bytes = writeXlsx({ sheets: [parts, about], styles: styles.all(), dxfs });
    const stamp = stampOf(new Date(), false);
    const name = fileSafe(model.mod || 'cosmoteer');
    return { fileName: `${name || 'cosmoteer'}-parts-${stamp}.xlsx`, base64: bytes.toString('base64') };
};
