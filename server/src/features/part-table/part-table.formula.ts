import { MATH_FUNCTIONS } from '../../semantics/math-function-registry';
import { PartTableOverrides, PartTableRow } from './part-table.types';

/**
 * The formula columns of the part table: an expression written over column paths, computed per row.
 *
 * The functions are the game's own. Every name the rules math registry can evaluate is callable
 * here with the same meaning and the same rounding, so a column that reproduces a value the game
 * computes produces the game's number rather than one that merely looks close. A few more are added
 * for the things a table asks that a rules file never does: `if` for a conditional column, `ref`
 * for the value the row being compared against holds, which is what turns a column into the
 * percentage of a reference part, `coalesce` and `has` for a fallback where a part lacks a value,
 * and the column aggregates and `rank` for a number that says where a row stands among the rows on
 * screen, plus the handful of arithmetic names in {@link TABLE_FUNCTIONS} that a table wants and the
 * game's expression parser has no function for.
 *
 * A column path is written in square brackets, `[Components/ArcShield/Radius/BaseValue]`. A path
 * with no separators may also be written bare, so `MaxHealth / Cost` reads the way a reader would
 * write it. A path may carry `*` to name every column it matches at once, `[Resources/*]`, and a
 * name that is no column of the row but is another formula column of the view reads that column.
 */

/** What the formula reads in addition to the rows. */
export interface FormulaOptions {
    /** The other formula columns of the view, by the name the reader gave them. */
    readonly formulas?: Readonly<Record<string, string>>;
    /** The keys of the rows on screen, which the column aggregates run over. Absent for every row. */
    readonly visible?: readonly string[];
    /** Values the reader typed over cells, read ahead of the file's values. */
    readonly overrides?: PartTableOverrides;
}

/**
 * Functions this table language has beyond the game's math vocabulary.
 *
 * A column formula is read by this module, never by the game, so it is free to offer names the
 * game's expression parser would refuse. The rules-math registry deliberately holds only what the
 * game accepts, so a modder is not told that `pow` works when a part file using it will not load.
 */
const TABLE_FUNCTIONS: Readonly<Record<string, (values: number[]) => number | null>> = {
    sum: (values) => values.reduce((total, value) => total + value, 0),
    avg: (values) => (values.length ? values.reduce((total, value) => total + value, 0) / values.length : null),
    pow: (values) => (values.length === 2 ? values[0] ** values[1] : null),
    sign: (values) => (values.length === 1 ? Math.sign(values[0]) : null),
    cbrt: (values) => (values.length === 1 ? Math.cbrt(values[0]) : null),
    atan2: (values) => (values.length === 2 ? Math.atan2(values[0], values[1]) : null),
};

/**
 * The aggregates over the visible rows, each folding the present values of one expression. Every
 * one is handed at least one value, since an empty column answers null before the fold runs.
 */
const AGGREGATES: Readonly<Record<string, (values: readonly number[]) => number>> = {
    colmin: (values) => values.reduce((lowest, value) => Math.min(lowest, value)),
    colmax: (values) => values.reduce((highest, value) => Math.max(highest, value)),
    colsum: (values) => values.reduce((total, value) => total + value, 0),
    colavg: (values) => values.reduce((total, value) => total + value, 0) / values.length,
    colcount: (values) => values.length,
    colmedian: (values) => {
        const sorted = [...values].sort((left, right) => left - right);
        const middle = Math.floor(sorted.length / 2);
        return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    },
};

/** The functions the formula language adds on top of the rules math registry, lower-cased. */
const EXTRA_FUNCTIONS: ReadonlySet<string> = new Set([
    'if',
    'ref',
    'coalesce',
    'has',
    'rank',
    ...Object.keys(AGGREGATES),
    ...Object.keys(TABLE_FUNCTIONS),
]);

/** One token of a formula. */
interface Token {
    readonly kind: 'number' | 'column' | 'name' | 'operator';
    readonly text: string;
}

/** Thrown when a formula cannot be parsed, carrying the message the view shows instead of a column. */
class FormulaError extends Error {}

/** The two-character operators, tested ahead of the single-character ones. */
const LONG_OPERATORS = ['<=', '>=', '==', '!=', '&&', '||'];

/**
 * Splits a formula into tokens.
 *
 * @param formula the written formula.
 * @returns the tokens, in order.
 */
const tokenize = (formula: string): Token[] => {
    const tokens: Token[] = [];
    let at = 0;
    while (at < formula.length) {
        const character = formula[at];
        if (/\s/.test(character)) {
            at++;
            continue;
        }
        if (character === '[') {
            const close = formula.indexOf(']', at);
            if (close === -1) throw new FormulaError('A column reference is missing its closing bracket.');
            tokens.push({ kind: 'column', text: formula.slice(at + 1, close).trim() });
            at = close + 1;
            continue;
        }
        if (/[0-9]/.test(character) || (character === '.' && /[0-9]/.test(formula[at + 1] ?? ''))) {
            const match = /^[0-9]*\.?[0-9]+([eE][-+]?[0-9]+)?/.exec(formula.slice(at));
            if (!match) throw new FormulaError(`Cannot read a number at "${formula.slice(at, at + 8)}".`);
            tokens.push({ kind: 'number', text: match[0] });
            at += match[0].length;
            continue;
        }
        if (/[A-Za-z_]/.test(character)) {
            const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(formula.slice(at))!;
            tokens.push({ kind: 'name', text: match[0] });
            at += match[0].length;
            continue;
        }
        const long = LONG_OPERATORS.find((operator) => formula.startsWith(operator, at));
        if (long) {
            tokens.push({ kind: 'operator', text: long });
            at += long.length;
            continue;
        }
        if ('+-*/%(),<>=!'.includes(character)) {
            tokens.push({ kind: 'operator', text: character });
            at++;
            continue;
        }
        throw new FormulaError(`"${character}" is not something a formula can contain.`);
    }
    return tokens;
};

/** The parsed shape of a formula, evaluated against one row at a time. */
type Node =
    | { readonly kind: 'number'; readonly value: number }
    | { readonly kind: 'column'; readonly path: string }
    | { readonly kind: 'glob'; readonly pattern: string; readonly matcher: RegExp }
    | { readonly kind: 'unary'; readonly operator: string; readonly operand: Node }
    | { readonly kind: 'binary'; readonly operator: string; readonly left: Node; readonly right: Node }
    | { readonly kind: 'call'; readonly name: string; readonly args: readonly Node[] };

/** The binary operators by precedence level, loosest first. */
const PRECEDENCE: ReadonlyArray<readonly string[]> = [
    ['||', 'or'],
    ['&&', 'and'],
    ['<', '<=', '>', '>=', '==', '!=', '='],
    ['+', '-'],
    ['*', '/', '%'],
];

/**
 * Turns a column glob into the expression that tests a path against it. Compiled once at parse time
 * because the same glob is tested against every cell of every row.
 *
 * @param pattern the bracketed path with its stars.
 * @returns the anchored, case-insensitive expression.
 */
const compileGlob = (pattern: string): RegExp => {
    let source = '';
    for (let at = 0; at < pattern.length; at++) {
        const character = pattern[at];
        if (character !== '*') {
            source += character.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
        } else if (pattern[at + 1] === '*') {
            source += '.*';
            at++;
        } else {
            source += '[^/]*';
        }
    }
    return new RegExp(`^${source}$`, 'i');
};

/**
 * Parses a token stream into a formula tree.
 *
 * @param tokens the formula's tokens.
 * @returns the tree.
 */
const parse = (tokens: readonly Token[]): Node => {
    let at = 0;
    const peek = (): Token | undefined => tokens[at];
    const isOperator = (text: string): boolean => {
        const token = peek();
        if (!token) return false;
        if (token.kind === 'operator') return token.text === text;
        return token.kind === 'name' && token.text.toLowerCase() === text;
    };

    const parsePrimary = (): Node => {
        const token = peek();
        if (!token) throw new FormulaError('The formula ends where a value was expected.');
        at++;
        if (token.kind === 'number') return { kind: 'number', value: Number(token.text) };
        if (token.kind === 'column') {
            if (token.text.includes('*')) {
                return { kind: 'glob', pattern: token.text, matcher: compileGlob(token.text) };
            }
            return { kind: 'column', path: token.text };
        }
        if (token.kind === 'operator' && token.text === '(') {
            const inner = parseAt(0);
            if (!isOperator(')')) throw new FormulaError('A bracket is left open.');
            at++;
            return inner;
        }
        if (token.kind === 'operator' && (token.text === '-' || token.text === '+')) {
            return { kind: 'unary', operator: token.text, operand: parsePrimary() };
        }
        if (token.kind === 'name') {
            const lower = token.text.toLowerCase();
            if (lower === 'not') return { kind: 'unary', operator: 'not', operand: parsePrimary() };
            if (isOperator('(')) {
                at++;
                const args: Node[] = [];
                if (!isOperator(')')) {
                    for (;;) {
                        args.push(parseAt(0));
                        if (isOperator(',')) {
                            at++;
                            continue;
                        }
                        break;
                    }
                }
                if (!isOperator(')')) throw new FormulaError(`The call to "${token.text}" is left open.`);
                at++;
                if (!EXTRA_FUNCTIONS.has(lower) && !MATH_FUNCTIONS[lower]?.evaluate) {
                    throw new FormulaError(`"${token.text}" is not a function a column can use.`);
                }
                return { kind: 'call', name: lower, args };
            }
            // A bare name is a column with no path separators, which is how the part's own fields read.
            return { kind: 'column', path: token.text };
        }
        throw new FormulaError(`"${token.text}" cannot start a value.`);
    };

    const parseAt = (level: number): Node => {
        if (level >= PRECEDENCE.length) return parsePrimary();
        let left = parseAt(level + 1);
        for (;;) {
            const operator = PRECEDENCE[level].find((candidate) => isOperator(candidate));
            if (!operator) return left;
            at++;
            left = { kind: 'binary', operator, left, right: parseAt(level + 1) };
        }
    };

    const tree = parseAt(0);
    if (at !== tokens.length) throw new FormulaError('The formula carries something after its end.');
    return tree;
};

/** Everything one `evaluateFormula` call shares between its rows. */
interface Context {
    /** The row `ref` reads, absent when the view compares nothing. */
    readonly reference: PartTableRow | undefined;
    /** The rows the aggregates and `rank` run over. */
    readonly visible: readonly PartTableRow[];
    /** The other formula columns by lower-cased name, null for one that does not parse. */
    readonly formulas: ReadonlyMap<string, Node | null>;
    /** The values the reader typed over cells. */
    readonly overrides: PartTableOverrides;
    /** The value of an aggregated expression per visible row key, computed once per expression. */
    readonly memo: Map<Node, ReadonlyMap<string, number | null>>;
    /** The formula columns being evaluated right now, so one that names itself stops instead of recursing. */
    readonly stack: string[];
}

/**
 * The number the reader typed over a column of a row, matched without regard to case like a cell.
 *
 * @param row the row.
 * @param path the column path.
 * @param overrides the typed values.
 * @returns the typed number, null for a typed value that is no number, undefined when nothing was typed there.
 */
const overrideValue = (row: PartTableRow, path: string, overrides: PartTableOverrides): number | null | undefined => {
    const typed = overrides[row.key];
    if (!typed) return undefined;
    const direct = typed[path];
    if (direct !== undefined) return direct;
    const lower = path.toLowerCase();
    for (const [key, value] of Object.entries(typed)) {
        if (key.toLowerCase() === lower) return value;
    }
    return undefined;
};

/**
 * The number a column holds for a row, matched without regard to case so a path typed by hand still
 * finds its column. A value the reader typed over the cell wins over the file's.
 *
 * @param row the row to read.
 * @param path the column path.
 * @param overrides the typed values.
 * @returns the number, null when the column holds no number, undefined when the row has no such column.
 */
const columnValue = (row: PartTableRow, path: string, overrides: PartTableOverrides): number | null | undefined => {
    const typed = overrideValue(row, path, overrides);
    if (typed !== undefined) return typed;
    const direct = row.cells[path];
    if (direct) return direct.value;
    const lower = path.toLowerCase();
    for (const [key, cell] of Object.entries(row.cells)) {
        if (key.toLowerCase() === lower) return cell.value;
    }
    return undefined;
};

/**
 * The present numbers of every column of a row a glob matches. A typed value shadows the file's
 * value of the same column, so a typed null hides a cell rather than doubling it.
 *
 * @param row the row to read.
 * @param matcher the compiled glob.
 * @param overrides the typed values.
 * @returns the numbers, in the order the columns are stored.
 */
const globValues = (row: PartTableRow, matcher: RegExp, overrides: PartTableOverrides): number[] => {
    const values: number[] = [];
    const shadowed = new Set<string>();
    const typed = overrides[row.key];
    if (typed) {
        for (const [path, value] of Object.entries(typed)) {
            if (!matcher.test(path)) continue;
            shadowed.add(path.toLowerCase());
            if (value !== null) values.push(value);
        }
    }
    for (const [path, cell] of Object.entries(row.cells)) {
        if (!matcher.test(path) || (shadowed.size > 0 && shadowed.has(path.toLowerCase()))) continue;
        if (cell.value !== null) values.push(cell.value);
    }
    return values;
};

/**
 * Computes another formula column of the view for a row, when the name is one.
 *
 * @param name the name a column reference carried that matched no column of the row.
 * @param row the row being computed.
 * @param context the shared state of the call.
 * @returns the number, or null when the name is no formula, the formula does not parse, or it names itself.
 */
const formulaValue = (name: string, row: PartTableRow, context: Context): number | null => {
    const lower = name.toLowerCase();
    const tree = context.formulas.get(lower);
    if (!tree || context.stack.includes(lower)) return null;
    context.stack.push(lower);
    try {
        return evaluateNode(tree, row, context);
    } finally {
        context.stack.pop();
    }
};

/**
 * Computes a formula tree for one row.
 *
 * @param node the tree.
 * @param row the row being computed.
 * @param context the shared state of the call.
 * @returns the number, or null when anything the formula reads is missing.
 */
const evaluateNode = (node: Node, row: PartTableRow, context: Context): number | null => {
    switch (node.kind) {
        case 'number':
            return node.value;
        case 'column': {
            const value = columnValue(row, node.path, context.overrides);
            return value === undefined ? formulaValue(node.path, row, context) : value;
        }
        case 'glob': {
            // Outside an argument list a glob stands for one number, and the sum is the one a reader
            // means by `[Resources/*]`, the whole of what the part costs in resources.
            const values = globValues(row, node.matcher, context.overrides);
            return values.length === 0 ? null : values.reduce((total, value) => total + value, 0);
        }
        case 'unary': {
            const operand = evaluateNode(node.operand, row, context);
            if (operand === null) return null;
            if (node.operator === '-') return -operand;
            if (node.operator === 'not') return operand === 0 ? 1 : 0;
            return operand;
        }
        case 'binary': {
            const left = evaluateNode(node.left, row, context);
            const right = evaluateNode(node.right, row, context);
            if (left === null || right === null) return null;
            switch (node.operator) {
                case '+':
                    return left + right;
                case '-':
                    return left - right;
                case '*':
                    return left * right;
                case '/':
                    return right === 0 ? null : left / right;
                case '%':
                    return right === 0 ? null : left % right;
                case '<':
                    return left < right ? 1 : 0;
                case '<=':
                    return left <= right ? 1 : 0;
                case '>':
                    return left > right ? 1 : 0;
                case '>=':
                    return left >= right ? 1 : 0;
                case '==':
                case '=':
                    return left === right ? 1 : 0;
                case '!=':
                    return left !== right ? 1 : 0;
                case '&&':
                case 'and':
                    return left !== 0 && right !== 0 ? 1 : 0;
                default:
                    return left !== 0 || right !== 0 ? 1 : 0;
            }
        }
        default:
            return evaluateCall(node.name, node.args, row, context);
    }
};

/**
 * The values of the arguments of a call, in order, with each glob spread into the values of the
 * columns it matches so `sum([Resources/*])` adds every resource.
 *
 * @param args the argument trees.
 * @param row the row being computed.
 * @param context the shared state of the call.
 * @returns the values, or null when an argument that is no glob is missing.
 */
const argumentValues = (args: readonly Node[], row: PartTableRow, context: Context): number[] | null => {
    const values: number[] = [];
    for (const argument of args) {
        if (argument.kind === 'glob') {
            values.push(...globValues(row, argument.matcher, context.overrides));
            continue;
        }
        const value = evaluateNode(argument, row, context);
        if (value === null) return null;
        values.push(value);
    }
    return values;
};

/**
 * The value of an expression for every visible row, computed once per expression and call so an
 * aggregate costs one pass over the rows rather than one pass per row.
 *
 * @param node the expression.
 * @param context the shared state of the call.
 * @returns the value by row key.
 */
const valuesPerRow = (node: Node, context: Context): ReadonlyMap<string, number | null> => {
    const known = context.memo.get(node);
    if (known) return known;
    const computed = new Map<string, number | null>();
    for (const row of context.visible) computed.set(row.key, evaluateNode(node, row, context));
    context.memo.set(node, computed);
    return computed;
};

/**
 * Computes a function call for one row.
 *
 * @param name the function's lower-cased name.
 * @param args its argument trees.
 * @param row the row being computed.
 * @param context the shared state of the call.
 * @returns the number, or null when an argument is missing or the call is malformed.
 */
const evaluateCall = (name: string, args: readonly Node[], row: PartTableRow, context: Context): number | null => {
    // A conditional picks a branch, so only the branch it picks is computed and a missing value in
    // the other one costs nothing.
    if (name === 'if') {
        if (args.length !== 3) return null;
        const condition = evaluateNode(args[0], row, context);
        if (condition === null) return null;
        return evaluateNode(condition !== 0 ? args[1] : args[2], row, context);
    }
    if (name === 'ref') {
        if (args.length !== 1 || !context.reference) return null;
        return evaluateNode(args[0], context.reference, context);
    }
    if (name === 'coalesce') {
        for (const argument of args) {
            if (argument.kind === 'glob') {
                const matched = globValues(row, argument.matcher, context.overrides);
                if (matched.length > 0) return matched[0];
                continue;
            }
            const value = evaluateNode(argument, row, context);
            if (value !== null) return value;
        }
        return null;
    }
    if (name === 'has') {
        if (args.length !== 1) return null;
        if (args[0].kind === 'glob') return globValues(row, args[0].matcher, context.overrides).length > 0 ? 1 : 0;
        return evaluateNode(args[0], row, context) === null ? 0 : 1;
    }
    if (name === 'rank') {
        if (args.length !== 1) return null;
        const perRow = valuesPerRow(args[0], context);
        const own = perRow.has(row.key) ? perRow.get(row.key)! : evaluateNode(args[0], row, context);
        if (own === null) return null;
        let ahead = 0;
        for (const value of perRow.values()) {
            if (value !== null && value > own) ahead++;
        }
        return ahead + 1;
    }
    const aggregate = AGGREGATES[name];
    if (aggregate) {
        if (args.length !== 1) return null;
        const present: number[] = [];
        for (const value of valuesPerRow(args[0], context).values()) {
            if (value !== null) present.push(value);
        }
        return present.length === 0 ? null : aggregate(present);
    }
    const table = TABLE_FUNCTIONS[name];
    if (table) {
        const tableValues = argumentValues(args, row, context);
        if (!tableValues) return null;
        const tableResult = table(tableValues);
        return tableResult === null || !Number.isFinite(tableResult) ? null : tableResult;
    }
    const spec = MATH_FUNCTIONS[name];
    if (!spec?.evaluate) return null;
    const values = argumentValues(args, row, context);
    if (!values) return null;
    const [minimum, maximum] = spec.arity;
    if (values.length < minimum || values.length > maximum) return null;
    const result = spec.evaluate(values);
    return result === null || !Number.isFinite(result) ? null : result;
};

/**
 * Parses the other formula columns of the view, so a reference to one of them evaluates its tree
 * without parsing it again for every row.
 *
 * @param formulas the formulas by the name the reader gave them.
 * @returns the trees by lower-cased name, null for a formula that does not parse.
 */
const parseFormulas = (formulas: Readonly<Record<string, string>> | undefined): ReadonlyMap<string, Node | null> => {
    const parsed = new Map<string, Node | null>();
    for (const [name, formula] of Object.entries(formulas ?? {})) {
        let tree: Node | null;
        try {
            tree = parse(tokenize(formula));
        } catch {
            tree = null;
        }
        parsed.set(name.toLowerCase(), tree);
    }
    return parsed;
};

/**
 * Computes a formula column over a whole table.
 *
 * @param formula the written formula.
 * @param rows the rows to compute it for.
 * @param reference the row `ref` reads, absent when the view compares nothing.
 * @param options the other formula columns, the rows on screen and the values typed over cells.
 * @returns the value per row key, or the message to show when the formula does not parse.
 */
export const evaluateFormula = (
    formula: string,
    rows: readonly PartTableRow[],
    reference: PartTableRow | undefined,
    options: FormulaOptions = {}
): { values: Record<string, number | null>; error?: string } => {
    let tree: Node;
    try {
        tree = parse(tokenize(formula));
    } catch (error) {
        return { values: {}, error: error instanceof FormulaError ? error.message : 'The formula cannot be read.' };
    }
    const visibleKeys = options.visible ? new Set(options.visible) : undefined;
    const context: Context = {
        reference,
        visible: visibleKeys ? rows.filter((row) => visibleKeys.has(row.key)) : rows,
        formulas: parseFormulas(options.formulas),
        overrides: options.overrides ?? {},
        memo: new Map(),
        stack: [],
    };
    const values: Record<string, number | null> = {};
    for (const row of rows) {
        const value = evaluateNode(tree, row, context);
        values[row.key] = value !== null && Number.isFinite(value) ? value : null;
    }
    return { values };
};
