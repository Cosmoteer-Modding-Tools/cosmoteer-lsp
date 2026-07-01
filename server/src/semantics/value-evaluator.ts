import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    FunctionCallNode,
    isExpressionNode,
    isFunctionCallNode,
    isMathExpressionNode,
    isValueNode,
    ValueNode,
} from '../core/ast/ast';
import { getStartOfAstNode } from '../utils/ast.utils';
import { FullNavigationStrategy } from '../features/navigation/full.navigation-strategy';
import { FileWithPath, isFile } from '../workspace/cosmoteer-workspace.service';

const navigation = new FullNavigationStrategy();

/**
 * The pure numeric functions we can evaluate. Cosmoteer's math is mXparser-compatible
 * (https://mathparser.org/mxparser-math-collection/), so these follow mXparser semantics:
 * trigonometry is in radians and `ln` is the natural log. Names are matched case-insensitively
 * and several mXparser aliases map to the same function. A call with the wrong arity (or a
 * domain function whose meaning isn't pure arithmetic, e.g. `deg`/`vol`) returns `null` so the
 * caller shows nothing rather than a wrong number. Operators beyond `+ - * /` (mXparser's `^`,
 * `!`, `%`) are not covered — the lexer never tokenizes them, so they can't reach this table.
 */
const unary = (fn: (x: number) => number) => (a: number[]) => (a.length === 1 ? fn(a[0]) : null);
const binary = (fn: (x: number, y: number) => number) => (a: number[]) => (a.length === 2 ? fn(a[0], a[1]) : null);
const variadic = (fn: (xs: number[]) => number) => (a: number[]) => (a.length ? fn(a) : null);

const FUNCTIONS: Record<string, (args: number[]) => number | null> = {
    // Rounding / sign / magnitude
    ceil: unary(Math.ceil),
    floor: unary(Math.floor),
    // mXparser `round(x, n)` rounds to n decimals; a lone `round(x)` is the nearest integer.
    round: (a) =>
        a.length === 1
            ? Math.round(a[0])
            : a.length === 2
              ? Math.round(a[0] * 10 ** a[1]) / 10 ** a[1]
              : null,
    abs: unary(Math.abs),
    sign: unary(Math.sign),
    sgn: unary(Math.sign), // mXparser spelling
    // Roots / powers / exponential / logarithms
    sqrt: unary(Math.sqrt),
    cbrt: unary(Math.cbrt),
    exp: unary(Math.exp),
    ln: unary(Math.log), // natural log (mXparser)
    log2: unary(Math.log2),
    log10: unary(Math.log10),
    lg: unary(Math.log10), // mXparser alias for log base 10
    // mXparser `log(a, b)` is log base a of b.
    log: binary((base, x) => Math.log(x) / Math.log(base)),
    pow: binary(Math.pow),
    // Trigonometry — radians
    sin: unary(Math.sin),
    cos: unary(Math.cos),
    tan: unary(Math.tan),
    tg: unary(Math.tan),
    ctan: unary((x) => 1 / Math.tan(x)),
    cot: unary((x) => 1 / Math.tan(x)),
    ctg: unary((x) => 1 / Math.tan(x)),
    sec: unary((x) => 1 / Math.cos(x)),
    csc: unary((x) => 1 / Math.sin(x)),
    cosec: unary((x) => 1 / Math.sin(x)),
    asin: unary(Math.asin),
    arcsin: unary(Math.asin),
    acos: unary(Math.acos),
    arccos: unary(Math.acos),
    atan: unary(Math.atan),
    arctan: unary(Math.atan),
    arctg: unary(Math.atan),
    atan2: binary(Math.atan2),
    // Hyperbolic
    sinh: unary(Math.sinh),
    cosh: unary(Math.cosh),
    tanh: unary(Math.tanh),
    asinh: unary(Math.asinh),
    acosh: unary(Math.acosh),
    atanh: unary(Math.atanh),
    // Aggregates (variadic)
    min: variadic((xs) => Math.min(...xs)),
    max: variadic((xs) => Math.max(...xs)),
    sum: variadic((xs) => xs.reduce((s, x) => s + x, 0)),
    avg: variadic((xs) => xs.reduce((s, x) => s + x, 0) / xs.length),
    // Modulo
    mod: binary((x, y) => x % y),
};

/** Lowercased names of every function we can numerically evaluate (a subset of all valid mXparser functions). */
export const KNOWN_FUNCTION_NAMES: ReadonlySet<string> = new Set(Object.keys(FUNCTIONS));

/**
 * Argument-count bounds `[min, max]` for each {@link FUNCTIONS} entry (`max` is `Infinity` for the
 * variadic aggregates). Mirrors the arity each closure enforces, so the validator can flag a call
 * with the wrong number of arguments. Only covers functions we evaluate — arity is intentionally not
 * checked for valid-but-unevaluatable mXparser functions, whose arities we don't model. A test keeps
 * this table's keys in lock-step with {@link FUNCTIONS}.
 */
export const FUNCTION_ARITY: Record<string, [number, number]> = {
    ceil: [1, 1], floor: [1, 1], round: [1, 2], abs: [1, 1], sign: [1, 1], sgn: [1, 1],
    sqrt: [1, 1], cbrt: [1, 1], exp: [1, 1], ln: [1, 1], log2: [1, 1], log10: [1, 1], lg: [1, 1],
    log: [2, 2], pow: [2, 2],
    sin: [1, 1], cos: [1, 1], tan: [1, 1], tg: [1, 1], ctan: [1, 1], cot: [1, 1], ctg: [1, 1],
    sec: [1, 1], csc: [1, 1], cosec: [1, 1],
    asin: [1, 1], arcsin: [1, 1], acos: [1, 1], arccos: [1, 1], atan: [1, 1], arctan: [1, 1], arctg: [1, 1],
    atan2: [2, 2],
    sinh: [1, 1], cosh: [1, 1], tanh: [1, 1], asinh: [1, 1], acosh: [1, 1], atanh: [1, 1],
    min: [1, Infinity], max: [1, Infinity], sum: [1, Infinity], avg: [1, Infinity],
    mod: [2, 2],
};

/** mXparser mathematical constants usable bare in an expression (no `&`). */
const CONSTANTS: Record<string, number> = {
    pi: Math.PI,
    e: Math.E,
};

/** Lowercased names of bare numeric constants (`pi`, `e`) that are valid operands without a `&`. */
export const KNOWN_CONSTANT_NAMES: ReadonlySet<string> = new Set(Object.keys(CONSTANTS));

interface EvalContext {
    token: CancellationToken;
    /** Reference value nodes already dereferenced on this path — breaks `A = &B` / `B = &A` cycles. */
    visited: Set<AbstractNode>;
}

/**
 * Compute the concrete numeric value a node resolves to — following references (through
 * inheritance, via the shared {@link FullNavigationStrategy}), arithmetic with `* /` before
 * `+ -`, and the {@link FUNCTIONS} above. Returns `null` for anything not purely numeric
 * (strings, percentages/units, unknown functions, unresolved refs, cycles) so callers can
 * simply show nothing rather than a wrong value.
 */
export const evaluateNumericValue = async (
    node: AbstractNode,
    token: CancellationToken
): Promise<number | null> => {
    return evaluate(node, { token, visited: new Set() });
};

/**
 * Evaluate a flat `operand (op operand)*` run as one arithmetic expression. Lists store math
 * inline-flattened (`[10 * 2, &A + 5]` → `[10, *, 2, &A, +, 5]` with no grouping nodes), so
 * callers segment the run themselves (see the inlay-hint service) and hand each group here.
 */
export const evaluateExpressionGroup = async (
    parts: AbstractNode[],
    token: CancellationToken
): Promise<number | null> => {
    return evaluateSequence(parts, { token, visited: new Set() });
};

const evaluate = async (node: AbstractNode, context: EvalContext): Promise<number | null> => {
    if (context.token.isCancellationRequested) return null;
    if (isValueNode(node)) return evaluateValue(node, context);
    if (isMathExpressionNode(node)) return evaluateSequence(node.elements, context);
    if (isFunctionCallNode(node)) return evaluateFunction(node, context);
    return null;
};

const evaluateValue = async (node: ValueNode, context: EvalContext): Promise<number | null> => {
    if (node.valueType.type === 'Number') return node.valueType.value;
    // A bare mXparser constant (`pi`, `e`) lexes as an unquoted token — sometimes typed `String`,
    // sometimes `Reference` — so check it before the reference-navigation path. A quoted "pi" is a
    // real string and must not match.
    if (!node.quoted) {
        const text = String(node.valueType.value);
        const constant = CONSTANTS[text.toLowerCase()];
        if (constant !== undefined && !/^[&<>/.~^]/.test(text)) return constant;
        // mXparser percentage: `50%` → 0.5. The lexer keeps `%` inside the value token, so a
        // numeric-with-trailing-`%` literal never reaches the reference path — convert it here.
        const percent = text.replace(/\s+/g, '');
        if (/^-?\d*\.?\d+%$/.test(percent)) return parseFloat(percent) / 100;
    }
    if (node.valueType.type !== 'Reference') return null;
    // `visited` is the current resolution path, not every node ever seen: a node already on the
    // path is a true cycle (`A = &B` / `B = &A`) and must stop. We add on entry and remove on exit
    // (below) so the same node reached again on a separate branch — a diamond, e.g. `&R/0/1` used
    // twice in one expression — still evaluates instead of collapsing to null.
    if (context.visited.has(node)) return null;
    context.visited.add(node);
    try {
        const target = await navigation
            .navigate(String(node.valueType.value), node, getStartOfAstNode(node).uri, context.token)
            .catch(() => null);
        if (!target || isFile(target as FileWithPath)) return null;
        return await evaluate(target as AbstractNode, context);
    } finally {
        context.visited.delete(node);
    }
};

/**
 * Split a flat operand/operator stream into comma-separated argument groups. The parser drops
 * argument commas inconsistently (only the first may carry a `delimiter`), but valid math always
 * has an operator between two operands — so an operand directly after an operand marks a new
 * argument. `sum(1, 2, 3)` → `[[1], [2], [3]]`; `max(a + b, c)` → `[[a, +, b], [c]]`.
 */
const segmentArguments = (parts: AbstractNode[]): AbstractNode[][] => {
    const groups: AbstractNode[][] = [];
    let current: AbstractNode[] = [];
    let prevWasOperand = false;
    for (const part of parts) {
        if (isExpressionNode(part)) {
            current.push(part);
            prevWasOperand = false;
            continue;
        }
        if (prevWasOperand) {
            groups.push(current);
            current = [];
        }
        current.push(part);
        prevWasOperand = true;
    }
    if (current.length) groups.push(current);
    return groups;
};

/**
 * The number of comma-separated arguments a call passes — math operands inside one argument
 * (`max(a + b, c)` → 2) stay a single argument. Used for arity validation.
 */
export const functionArgumentCount = (node: FunctionCallNode): number => segmentArguments(node.arguments).length;

/**
 * Evaluate a flat `[operand, op, operand, …]` sequence by mXparser precedence: `^` (power,
 * right-associative) binds tightest, then `* /`, then `+ -` (both left-associative).
 */
const evaluateSequence = async (parts: AbstractNode[], context: EvalContext): Promise<number | null> => {
    const values: number[] = [];
    const operators: ('+' | '-' | '*' | '/' | '^')[] = [];
    for (const part of parts) {
        if (isExpressionNode(part)) {
            // `!` is postfix: apply factorial to the value just produced (binds tighter than any
            // binary operator) rather than queuing it as a binary operator awaiting a right operand.
            if (part.expressionType === '!') {
                if (values.length === 0) return null;
                const result = factorial(values[values.length - 1]);
                if (result === null) return null;
                values[values.length - 1] = result;
            } else {
                operators.push(part.expressionType);
            }
        } else {
            const value = await evaluate(part, context);
            if (value === null) return null;
            values.push(value);
        }
    }
    if (values.length === 0 || values.length !== operators.length + 1) return null;

    // Collapse `values[i] op values[i+1]` → `values[i]` for every operator the predicate accepts,
    // walking right-to-left for the (right-associative) power level and left-to-right otherwise.
    const fold = (apply: (op: string, a: number, b: number) => number | null, rightAssoc = false) => {
        let i = rightAssoc ? operators.length - 1 : 0;
        while (i >= 0 && i < operators.length) {
            const result = apply(operators[i], values[i], values[i + 1]);
            if (result === null) {
                i += rightAssoc ? -1 : 1;
                continue;
            }
            values[i] = result;
            values.splice(i + 1, 1);
            operators.splice(i, 1);
            if (rightAssoc) i--;
        }
    };

    fold((op, a, b) => (op === '^' ? a ** b : null), true); // power, right-associative
    fold((op, a, b) => (op === '*' ? a * b : op === '/' ? a / b : null)); // multiplicative
    fold((op, a, b) => (op === '+' ? a + b : op === '-' ? a - b : null)); // additive
    // Division by zero (`Infinity`) and a fractional power of a negative base (`NaN`) are not real
    // numbers; return null like evaluateFunction so callers show nothing rather than "= Infinity".
    return isFinite(values[0]) ? values[0] : null;
};

const evaluateFunction = async (node: FunctionCallNode, context: EvalContext): Promise<number | null> => {
    const fn = FUNCTIONS[node.name.toLowerCase()];
    if (!fn) return null;
    const args: number[] = [];
    for (const group of segmentArguments(node.arguments)) {
        const value = await evaluateSequence(group, context);
        if (value === null) return null;
        args.push(value);
    }
    const result = args.length ? fn(args) : null;
    return result === null || !isFinite(result) ? null : result;
};

/**
 * mXparser factorial (`n!`). Defined here only for non-negative integers up to 170 (171! overflows
 * to Infinity). Anything else returns null so the caller shows nothing rather than a bogus number.
 */
const factorial = (n: number): number | null => {
    if (!Number.isInteger(n) || n < 0 || n > 170) return null;
    let result = 1;
    for (let i = 2; i <= n; i++) result *= i;
    return result;
};

/** Format a computed value for display: trims floating-point noise and trailing zeros. */
export const formatNumber = (value: number): string => {
    const rounded = Math.round(value * 1e6) / 1e6;
    return String(rounded);
};
