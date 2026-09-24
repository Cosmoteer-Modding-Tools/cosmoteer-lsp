import { Node, parseFormula } from './part-table.formula';
import { numberText } from './xlsx';

/**
 * Writes a part table formula out as an Excel formula, so a formula column of the exported
 * workbook is a live formula the reader can take apart and change rather than a frozen number.
 *
 * The two languages agree on arithmetic and part ways on what a missing value is. A formula here
 * answers nothing when anything it reads is missing, and Excel reads an empty cell as a zero, so a
 * column that some exported part leaves empty is read through a guard that turns the empty cell
 * into `#N/A`. That error spreads through the rest of the expression exactly the way the missing
 * value does here, which is what keeps a column of ratios from filling with zeroes where the game
 * has no value at all.
 *
 * A formula the translation has no faithful Excel form for is refused rather than approximated,
 * and the column is written out as its numbers with the reason beside it on the workbook's second
 * sheet.
 */

/** One column of the exported table, as a formula can name it. */
export interface ExcelColumn {
    /** The column path a formula writes, or the name of another formula column. */
    readonly path: string;
    /** The name the column carries in the workbook, which structured references are written to. */
    readonly name: string;
    /** True when some exported row leaves the column empty, which is what asks for the guard. */
    readonly blank: boolean;
}

/** What the translation writes its references against. */
export interface ExcelFormulaContext {
    /** The name of the workbook's table. */
    readonly table: string;
    /** The exported columns. */
    readonly columns: readonly ExcelColumn[];
    /** The name of the column holding the part's id, which `ref` looks the compared part up in. */
    readonly idColumn: string;
    /** The id of the compared part, absent when the view compares nothing. */
    readonly referenceId?: string;
    /**
     * Whether the compared part is none of the exported rows. `ref` looks the part up by its id in
     * the sheet itself, so a comparison the filter or the search left off the sheet has nothing to
     * find and every cell of the column would read `#N/A`.
     */
    readonly referenceOffSheet?: boolean;
}

/** The longest formula Excel holds in a cell. */
const MAX_LENGTH = 8000;

/** The unary functions that map onto an Excel function of the same shape, by their formula name. */
const UNARY: Readonly<Record<string, string>> = {
    abs: 'ABS',
    sqrt: 'SQRT',
    exp: 'EXP',
    ln: 'LN',
    log10: 'LOG10',
    sin: 'SIN',
    cos: 'COS',
    tan: 'TAN',
    tg: 'TAN',
    asin: 'ASIN',
    arcsin: 'ASIN',
    acos: 'ACOS',
    arccos: 'ACOS',
    atan: 'ATAN',
    arctan: 'ATAN',
    arctg: 'ATAN',
    sinh: 'SINH',
    cosh: 'COSH',
    tanh: 'TANH',
    asinh: 'ASINH',
    acosh: 'ACOSH',
    atanh: 'ATANH',
    sgn: 'SIGN',
    sign: 'SIGN',
    deg: 'DEGREES',
    rad: 'RADIANS',
};

/** The variadic functions, which take the whole argument list as Excel takes it. */
const VARIADIC: Readonly<Record<string, string>> = {
    sum: 'SUM',
    avg: 'AVERAGE',
    mean: 'AVERAGE',
    min: 'MIN',
    max: 'MAX',
};

/** The column aggregates, each folding the whole column rather than the row's own value. */
const AGGREGATES: Readonly<Record<string, string>> = {
    colmin: 'MIN',
    colmax: 'MAX',
    colsum: 'SUM',
    colavg: 'AVERAGE',
    colcount: 'COUNT',
    colmedian: 'MEDIAN',
};

/** Thrown while translating, carrying what to tell the reader instead of a formula. */
class ExcelFormulaError extends Error {}

/** How a column reference is written: for the row it sits on, for the whole column, or for the compared part. */
type Mode = 'row' | 'column' | 'reference';

/**
 * The name written inside a structured reference, with the characters Excel reads as syntax
 * quoted by the single quote it uses for that.
 *
 * @param name the column name.
 * @returns the name as a reference writes it.
 */
const specifier = (name: string): string => name.replace(/['[\]#@]/g, "'$&");

/**
 * The reference to one column, written the way the mode asks for.
 *
 * @param column the exported column.
 * @param mode whether the row's own value, the whole column or the compared part's value is meant.
 * @param context what the references are written against.
 * @param guard whether an empty cell becomes `#N/A` rather than the zero Excel would read.
 * @returns the reference.
 */
const reference = (column: ExcelColumn, mode: Mode, context: ExcelFormulaContext, guard: boolean): string => {
    const whole = `${context.table}[${specifier(column.name)}]`;
    if (mode === 'column') return whole;
    let read = `${context.table}[[#This Row],[${specifier(column.name)}]]`;
    if (mode === 'reference') {
        if (!context.referenceId) throw new ExcelFormulaError('no part is being compared against');
        if (context.referenceOffSheet) {
            throw new ExcelFormulaError(`the compared part "${context.referenceId}" is not one of the exported rows`);
        }
        const id = context.referenceId.replace(/"/g, '""');
        read = `INDEX(${whole},MATCH("${id}",${context.table}[${specifier(context.idColumn)}],0))`;
    }
    return guard && column.blank ? `IF(${read}="",NA(),${read})` : read;
};

/**
 * The exported column a path names, matched without regard to case the way the evaluator matches it.
 *
 * @param path the path or formula name a reference carried.
 * @param context the exported columns.
 * @returns the column.
 */
const columnFor = (path: string, context: ExcelFormulaContext): ExcelColumn => {
    const lower = path.toLowerCase();
    const found = context.columns.find((column) => column.path.toLowerCase() === lower);
    if (!found) throw new ExcelFormulaError(`the column "${path}" is not one of the exported columns`);
    return found;
};

/**
 * The exported columns a wildcard path matches, in the order they are exported.
 *
 * @param matcher the compiled wildcard.
 * @param context the exported columns.
 * @returns the columns.
 */
const globColumns = (matcher: RegExp, mode: Mode, context: ExcelFormulaContext): ExcelColumn[] => {
    // A column aggregate folds one value per row, and a wildcard stands for the sum of several
    // columns of that row. Excel has no whole-column form of that sum outside an array formula, so
    // such a column is refused rather than folded over every cell the wildcard matches, which is a
    // different number.
    if (mode === 'column') throw new ExcelFormulaError('a wildcard inside a column aggregate has no Excel form');
    const matched = context.columns.filter((column) => matcher.test(column.path));
    if (matched.length === 0) throw new ExcelFormulaError('the wildcard matches none of the exported columns');
    return matched;
};

/**
 * The arguments of a call, each translated, with a wildcard spread into the columns it matches the
 * way the evaluator spreads it.
 *
 * @param args the argument trees.
 * @param mode how a column reference is written.
 * @param context what the references are written against.
 * @param guard whether a spread column answers nothing where it is empty. A function that adds its
 *        arguments up wants the plain reference, since an empty column adds nothing, and one that
 *        picks the first value there is wants the guard, since an empty cell is not a value.
 * @returns the translated arguments.
 */
const argumentList = (args: readonly Node[], mode: Mode, context: ExcelFormulaContext, guard = false): string[] => {
    const written: string[] = [];
    for (const argument of args) {
        if (argument.kind === 'glob') {
            for (const column of globColumns(argument.matcher, mode, context)) {
                written.push(reference(column, mode, context, guard));
            }
            continue;
        }
        written.push(write(argument, mode, context));
    }
    return written;
};

/**
 * One call, written as the Excel function that computes the same thing.
 *
 * @param node the call.
 * @param mode how a column reference is written.
 * @param context what the references are written against.
 * @returns the translated call.
 */
const writeCall = (node: Extract<Node, { kind: 'call' }>, mode: Mode, context: ExcelFormulaContext): string => {
    const { name, args } = node;
    const arity = (count: number): void => {
        if (args.length !== count) throw new ExcelFormulaError(`"${name}" was given ${args.length} arguments`);
    };
    if (name === 'if') {
        arity(3);
        return `IF(${writeCondition(args[0], mode, context)},${write(args[1], mode, context)},${write(args[2], mode, context)})`;
    }
    if (name === 'ref') {
        arity(1);
        return write(args[0], 'reference', context);
    }
    if (name === 'coalesce') {
        const written = argumentList(args, mode, context, true);
        // Each candidate already answers `#N/A` where it is missing, so the fallback chain is the
        // one Excel writes for the same question.
        return written.reduceRight((rest, value) => `IFERROR(${value},${rest})`, 'NA()');
    }
    if (name === 'has') {
        arity(1);
        if (args[0].kind === 'glob') {
            return `IF(COUNT(${argumentList(args, mode, context).join(',')})>0,1,0)`;
        }
        return `IF(ISNA(${write(args[0], mode, context)}),0,1)`;
    }
    if (name === 'rank') {
        arity(1);
        return `RANK(${write(args[0], mode, context)},${write(args[0], 'column', context)})`;
    }
    const aggregate = AGGREGATES[name];
    if (aggregate) {
        arity(1);
        return `${aggregate}(${argumentList(args, 'column', context).join(',')})`;
    }
    const variadic = VARIADIC[name];
    if (variadic) {
        const written = argumentList(args, mode, context);
        if (written.length === 0) throw new ExcelFormulaError(`"${name}" was given nothing to compute over`);
        return `${variadic}(${written.join(',')})`;
    }
    const unary = UNARY[name];
    if (unary) {
        arity(1);
        return `${unary}(${write(args[0], mode, context)})`;
    }
    const written = argumentList(args, mode, context);
    switch (name) {
        case 'round':
            arity(2);
            return `ROUND(${written[0]},${written[1]})`;
        case 'ceil':
            arity(1);
            // Excel rounds down towards negative infinity, and the game's ceiling is the same
            // rounding read through a sign flip.
            return `-INT(-(${written[0]}))`;
        case 'floor':
            arity(1);
            return `INT(${written[0]})`;
        case 'pow':
            arity(2);
            return `POWER(${written[0]},${written[1]})`;
        case 'cbrt':
            arity(1);
            return `SIGN(${written[0]})*POWER(ABS(${written[0]}),1/3)`;
        case 'atan2':
            arity(2);
            // Excel names the across argument first, the game's function names the up one first.
            return `ATAN2(${written[1]},${written[0]})`;
        case 'log':
            arity(2);
            return `LOG(${written[1]},${written[0]})`;
        case 'log2':
            arity(1);
            return `LOG(${written[0]},2)`;
        case 'mod':
            arity(2);
            // Excel's own remainder takes the sign of the divisor, the game's takes the sign of the
            // dividend, so it is written out rather than called.
            return `(${written[0]}-${written[1]}*TRUNC(${written[0]}/${written[1]}))`;
        case 'cot':
        case 'ctg':
        case 'ctan':
            arity(1);
            return `(1/TAN(${written[0]}))`;
        case 'sec':
            arity(1);
            return `(1/COS(${written[0]}))`;
        case 'csc':
        case 'cosec':
            arity(1);
            return `(1/SIN(${written[0]}))`;
        default:
            throw new ExcelFormulaError(`"${name}" has no Excel equivalent`);
    }
};

/**
 * A test written as an Excel condition rather than as the one and zero this language answers
 * with, so a conditional column reads the way it would if it had been written in Excel.
 *
 * @param node the tested expression.
 * @param mode how a column reference is written.
 * @param context what the references are written against.
 * @returns the condition.
 */
const writeCondition = (node: Node, mode: Mode, context: ExcelFormulaContext): string => {
    if (node.kind === 'unary' && node.operator === 'not') {
        return `NOT(${writeCondition(node.operand, mode, context)})`;
    }
    if (node.kind === 'binary') {
        const left = () => write(node.left, mode, context);
        const right = () => write(node.right, mode, context);
        switch (node.operator) {
            case '<':
            case '<=':
            case '>':
            case '>=':
                return `${left()}${node.operator}${right()}`;
            case '==':
            case '=':
                return `${left()}=${right()}`;
            case '!=':
                return `${left()}<>${right()}`;
            case '&&':
            case 'and':
                return `AND(${writeCondition(node.left, mode, context)},${writeCondition(node.right, mode, context)})`;
            case '||':
            case 'or':
                return `OR(${writeCondition(node.left, mode, context)},${writeCondition(node.right, mode, context)})`;
            default:
                break;
        }
    }
    return `${write(node, mode, context)}<>0`;
};

/**
 * One node of a formula tree, written as Excel.
 *
 * @param node the node.
 * @param mode how a column reference is written.
 * @param context what the references are written against.
 * @returns the translated expression.
 */
const write = (node: Node, mode: Mode, context: ExcelFormulaContext): string => {
    switch (node.kind) {
        case 'number':
            return numberText(node.value);
        case 'column':
            return reference(columnFor(node.path, context), mode, context, true);
        case 'glob': {
            const columns = globColumns(node.matcher, mode, context);
            const refs = columns.map((column) => reference(column, mode, context, false)).join(',');
            // The evaluator answers nothing for a row carrying none of the matched columns, where a
            // plain sum would answer zero.
            return columns.some((column) => column.blank) ? `IF(COUNT(${refs})=0,NA(),SUM(${refs}))` : `SUM(${refs})`;
        }
        case 'unary': {
            if (node.operator === '-') return `(-${write(node.operand, mode, context)})`;
            if (node.operator === 'not') return `IF(${writeCondition(node, mode, context)},1,0)`;
            return write(node.operand, mode, context);
        }
        case 'binary': {
            switch (node.operator) {
                case '+':
                case '-':
                case '*':
                case '/': {
                    const left = write(node.left, mode, context);
                    const right = write(node.right, mode, context);
                    return `(${left}${node.operator}${right})`;
                }
                case '%': {
                    const left = write(node.left, mode, context);
                    const right = write(node.right, mode, context);
                    return `(${left}-${right}*TRUNC(${left}/${right}))`;
                }
                default:
                    // Every comparison and every logical operator answers one or zero here, which
                    // is the number the rest of the formula computes with.
                    return `IF(${writeCondition(node, mode, context)},1,0)`;
            }
        }
        default:
            return writeCall(node, mode, context);
    }
};

/**
 * Translates a part table formula into the Excel formula that computes the same column.
 *
 * @param formula the formula as the reader wrote it.
 * @param context the table, its columns and the compared part the references are written against.
 * @returns the Excel formula without its leading `=`, or why the formula has no Excel form.
 */
export const toExcelFormula = (
    formula: string,
    context: ExcelFormulaContext
): { formula: string } | { reason: string } => {
    const parsed = parseFormula(formula);
    if ('error' in parsed) return { reason: parsed.error };
    try {
        const written = write(parsed.tree, 'row', context);
        // A written-out remainder repeats both its operands, so a formula that nests them grows
        // several times over the one the reader typed, and Excel refuses what it cannot hold.
        if (written.length > MAX_LENGTH) return { reason: 'it grows past the length Excel takes' };
        return { formula: written };
    } catch (error) {
        return { reason: error instanceof ExcelFormulaError ? error.message : 'it has no Excel form' };
    }
};
