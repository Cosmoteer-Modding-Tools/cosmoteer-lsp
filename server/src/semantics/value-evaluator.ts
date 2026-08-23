import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    FunctionCallNode,
    isExpressionNode,
    isFunctionCallNode,
    isGroupNode,
    isMathExpressionNode,
    isValueNode,
    ValueNode,
} from '../core/ast/ast';
import { getStartOfAstNode } from '../utils/ast.utils';
import { FullNavigationStrategy } from '../features/navigation/full.navigation-strategy';
import { FileWithPath, isFile } from '../workspace/cosmoteer-workspace.service';
import { CONSTANTS, mathFunction } from './math-function-registry';

const navigation = new FullNavigationStrategy();

/**
 * One `&reference` the evaluation replaced with a number. This is the substitution step the game's
 * own ExpressionEvaluator performs before mXparser ever sees the expression, and the only part of
 * the computation the source text does not already show.
 */
export interface Substitution {
    /** The reference exactly as written, such as `&~/COST`. */
    path: string;
    /** The number the reference stood for. */
    value: number;
    /** The document the number was read from. An open buffer carries a `file://` uri, a file read
     *  from disk carries its OS path, since that is what its parse is keyed by. */
    uri: string;
    /** The zero-based line inside that document. */
    line: number;
    /** Nesting level, 0 for a reference written in the evaluated node itself. */
    depth: number;
}

/** A computed number together with the references its evaluation substituted. */
export interface TracedValue {
    value: number | null;
    substitutions: Substitution[];
    /** How many references the caps below kept out of the list. */
    omitted: number;
}

// A part typically chains through a base and that base's own base, so a handful of levels covers
// what is worth reading. A reference deeper than this, or later than the entry cap, still
// evaluates exactly as before and is only not recorded.
const MAX_TRACE_DEPTH = 3;
const MAX_TRACE_ENTRIES = 12;

/** The collector a traced evaluation hands down through its {@link EvalContext}. */
interface TraceSink {
    entries: Substitution[];
    /** Identities of the substitutions already recorded, so a reference an expression uses twice is
     *  listed once. */
    seen: Set<string>;
    /** Nesting level of the descent currently running. */
    depth: number;
    omitted: number;
}

interface EvalContext {
    token: CancellationToken;
    /** Reference value nodes already dereferenced on this path. Breaks `A = &B` / `B = &A` cycles. */
    visited: Set<AbstractNode>;
    /** Substitution collector, undefined on the untraced path. Every entry point writes the slot
     *  explicitly, even as undefined, so both paths hand the evaluation the same object shape. */
    trace?: TraceSink;
}

/**
 * Compute the concrete numeric value a node resolves to, following references (through
 * inheritance, via the shared {@link FullNavigationStrategy}), arithmetic with `* /` before
 * `+ -`, and the evaluatable functions of the math-function registry. Returns `null` for
 * anything not purely numeric
 * (strings, percentages/units, unknown functions, unresolved refs, cycles) so callers can
 * simply show nothing rather than a wrong value.
 */
export const evaluateNumericValue = async (
    node: AbstractNode,
    token: CancellationToken
): Promise<number | null> => {
    // The explicit `trace: undefined` is deliberate: this runs on the whole-workspace diagnostics
    // pass, and giving it a different object shape than the traced entry point would make every
    // context read inside the evaluation polymorphic.
    return evaluate(node, { token, visited: new Set(), trace: undefined });
};

/**
 * Compute the same number {@link evaluateNumericValue} does, and record every `&reference` the
 * evaluation replaced with a number along the way. The arithmetic is untouched, the substitutions
 * are collected on a side channel, so the traced and untraced results are the same code producing
 * the same number. A value that does not evaluate carries no substitutions at all, so nothing
 * partial is ever shown.
 *
 * @param node the node to evaluate.
 * @param token cancellation token of the surrounding request.
 * @returns the computed number (null when it does not evaluate) with the substitutions it took.
 */
export const evaluateNumericValueTraced = async (
    node: AbstractNode,
    token: CancellationToken
): Promise<TracedValue> => {
    const trace: TraceSink = { entries: [], seen: new Set(), depth: 0, omitted: 0 };
    const value = await evaluate(node, { token, visited: new Set(), trace });
    if (value === null) return { value: null, substitutions: [], omitted: 0 };
    return { value, substitutions: trace.entries, omitted: trace.omitted };
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
    // Same explicit `trace: undefined` as above, for the same shape reason.
    return evaluateSequence(parts, { token, visited: new Set(), trace: undefined });
};

/**
 * Resolve the `BaseValue` member of the group a reference points at, the game's ModifiableValue
 * shape (`Arc { BaseValue = 160d }`). The member lookup runs through the same navigation as
 * reference evaluation, so a `BaseValue` supplied by an inherited base group is found too, and a
 * reference-valued `BaseValue` comes back already dereferenced to its final target.
 *
 * @param node the reference value node whose target group to inspect.
 * @param token cancellation token of the surrounding request.
 * @returns the `BaseValue` member's value node, or `null` when the reference does not resolve to a
 * group or the group carries no `BaseValue`.
 */
export const resolveReferencedBaseValue = async (
    node: ValueNode,
    token: CancellationToken
): Promise<AbstractNode | null> => {
    if (node.valueType.type !== 'Reference') return null;
    const target = await navigation
        .navigate(String(node.valueType.value), node, getStartOfAstNode(node).uri, token)
        .catch(() => null);
    if (!target || isFile(target as FileWithPath) || !isGroupNode(target as AbstractNode)) return null;
    const group = target as AbstractNode;
    const member = await navigation
        .navigate('BaseValue', group, getStartOfAstNode(group).uri, token)
        .catch(() => null);
    if (!member || isFile(member as FileWithPath)) return null;
    return member as AbstractNode;
};

const evaluate = async (node: AbstractNode, context: EvalContext): Promise<number | null> => {
    if (context.token.isCancellationRequested) return null;
    if (isValueNode(node)) return evaluateValue(node, context);
    if (isMathExpressionNode(node)) return evaluateSequence(node.elements, context);
    if (isFunctionCallNode(node)) return evaluateFunction(node, context);
    return null;
};

// The sigil and suffix patterns of the unquoted-value path, hoisted out of the body below, which
// runs for every unquoted value node of a parse. A regex literal inside it allocates a fresh RegExp
// per call. A shared instance carries no state here: only `WHITESPACE_RUN` is global, and it is used
// through `String.prototype.replace`, which resets `lastIndex` itself.
const REFERENCE_SIGIL = /^[&<>/.~^]/;
const WHITESPACE_RUN = /\s+/g;
const PERCENT_LITERAL = /^-?\d*\.?\d+%$/;
const DEGREES_LITERAL = /^-?\d*\.?\d+d$/;
const RADIANS_LITERAL = /^-?\d*\.?\d+r$/;

const evaluateValue = async (node: ValueNode, context: EvalContext): Promise<number | null> => {
    if (node.valueType.type === 'Number') return node.valueType.value;
    // A bare mXparser constant (`pi`, `e`) lexes as an unquoted token, sometimes typed `String`,
    // sometimes `Reference`, so check it before the reference-navigation path. A quoted "pi" is a
    // real string and must not match.
    if (!node.quoted) {
        const text = String(node.valueType.value);
        const constant = CONSTANTS[text.toLowerCase()];
        if (constant !== undefined && !REFERENCE_SIGIL.test(text)) return constant;
        // The game's ExpressionEvaluator rewrites suffixed numbers before handing the string to
        // mXparser: `50%` → 0.5, `90d` (degrees) → radians, `2r` (radians) → the bare number.
        // The lexer keeps the suffix inside the value token, so such a literal never reaches the
        // reference path. Convert it here the same way.
        const literal = text.replace(WHITESPACE_RUN, '');
        if (PERCENT_LITERAL.test(literal)) return parseFloat(literal) / 100;
        if (DEGREES_LITERAL.test(literal)) return (parseFloat(literal) / 360) * (Math.PI * 2);
        if (RADIANS_LITERAL.test(literal)) return parseFloat(literal);
    }
    if (node.valueType.type !== 'Reference') return null;
    // `visited` is the current resolution path, not every node ever seen: a node already on the
    // path is a true cycle (`A = &B` / `B = &A`) and must stop. We add on entry and remove on exit
    // (below) so the same node reached again on a separate branch (a diamond, e.g. `&R/0/1` used
    // twice in one expression) still evaluates instead of collapsing to null.
    if (context.visited.has(node)) return null;
    context.visited.add(node);
    const sink = context.trace;
    const slot = sink ? reserveSubstitution(sink, String(node.valueType.value)) : -1;
    if (sink) sink.depth++;
    try {
        const target = await navigation
            .navigate(String(node.valueType.value), node, getStartOfAstNode(node).uri, context.token)
            .catch(() => null);
        // Same verdict as before the trace existed: an unresolved path and a whole-file target both
        // leave nothing numeric to evaluate, so the value is null.
        const resolved = !target || isFile(target as FileWithPath) ? null : (target as AbstractNode);
        const value = resolved ? await evaluate(resolved, context) : null;
        if (sink && slot >= 0) settleSubstitution(sink, slot, value, resolved);
        return value;
    } finally {
        context.visited.delete(node);
        if (sink) sink.depth--;
    }
};

/**
 * Reserve the slot a reference's substitution will occupy, before its target is evaluated.
 * Reserving up front is what puts a nested substitution after the reference that pulled it in
 * rather than before it, since the descent finishes before the parent's own number is known.
 *
 * @param sink the collector of the running traced evaluation.
 * @param path the reference exactly as written.
 * @returns the reserved index, or -1 when a cap keeps this reference out of the trace.
 */
const reserveSubstitution = (sink: TraceSink, path: string): number => {
    if (sink.depth >= MAX_TRACE_DEPTH || sink.entries.length >= MAX_TRACE_ENTRIES) {
        sink.omitted++;
        return -1;
    }
    sink.entries.push({ path, value: NaN, uri: '', line: 0, depth: sink.depth });
    return sink.entries.length - 1;
};

/**
 * Fill a reserved slot in once its reference resolved, or drop it again.
 *
 * Everything a descent records sits contiguously after its own slot, so cutting the list back to
 * the slot removes the reference and its whole subtree in one step. That is what a reference which
 * did not evaluate gets, and what one already listed word for word gets. A duplicate is not
 * counted as omitted, since it hides nothing that is not on screen already.
 *
 * @param sink the collector of the running traced evaluation.
 * @param slot the index {@link reserveSubstitution} handed out.
 * @param value the number the reference stood for, or null when it did not evaluate.
 * @param target the node the reference resolved to, or null when it did not resolve.
 * @returns nothing, the sink is updated in place.
 */
const settleSubstitution = (
    sink: TraceSink,
    slot: number,
    value: number | null,
    target: AbstractNode | null
): void => {
    const entry = sink.entries[slot];
    if (value === null || !target) {
        sink.entries.length = slot;
        return;
    }
    const uri = getStartOfAstNode(target).uri;
    // A math operand the parser recovered as an assignment carries no position, and the node type
    // declares one, so the absent case has to be checked rather than trusted.
    const line = target.position ? target.position.line : 0;
    // Encoded rather than concatenated, since a written reference path may carry any separator.
    const key = JSON.stringify([entry.depth, entry.path, uri, line]);
    if (sink.seen.has(key)) {
        sink.entries.length = slot;
        return;
    }
    sink.seen.add(key);
    entry.value = value;
    entry.uri = uri;
    entry.line = line;
};

/**
 * Split a flat operand/operator stream into comma-separated argument groups. The parser drops
 * argument commas inconsistently (only the first may carry a `delimiter`), but valid math always
 * has an operator between two operands, so an operand directly after an operand marks a new
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
 * The number of comma-separated arguments a call passes. Math operands inside one argument
 * (`max(a + b, c)` → 2) stay a single argument. Used for arity validation.
 */
export const functionArgumentCount = (node: FunctionCallNode): number => segmentArguments(node.arguments).length;

/**
 * Evaluate a flat `[operand, op, operand, …]` sequence in the exact order mXparser 4.4.2
 * `Expression.calculate()` folds operators: tetration `^^`, power `^` (right-associative),
 * postfix `!`, modulo `#`, `* /`, `+ -`, the binary relations (each spelling group in its fixed
 * order), the boolean families (AND, then OR/XOR, then implications) and the bitwise operators
 * loosest of all. Semantics of each operator mirror the `MathFunctions` / `BinaryRelations` /
 * `BooleanAlgebra` implementations, including the epsilon relations and the three-valued boolean
 * logic, so hints show what the game really computes.
 */
const evaluateSequence = async (parts: AbstractNode[], context: EvalContext): Promise<number | null> => {
    // Mixed stream of operand values and operator spellings, folded in place phase by phase.
    const items: (number | { op: string })[] = [];
    for (const part of parts) {
        if (isExpressionNode(part)) {
            items.push({ op: part.expressionType });
        } else {
            const value = await evaluate(part, context);
            if (value === null) return null;
            items.push(value);
        }
    }
    if (items.length === 0) return null;

    const isOperand = (item: number | { op: string } | undefined): item is number => typeof item === 'number';
    // Fold every `operand op operand` triple whose operator is in `ops`, taking the leftmost match
    // each round (rightmost for the right-associative power) exactly like calculate()'s scan order.
    const foldBinary = (ops: readonly string[], apply: (op: string, a: number, b: number) => number, rightAssoc = false) => {
        for (;;) {
            let found = -1;
            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                if (typeof item === 'number' || !ops.includes(item.op)) continue;
                if (!isOperand(items[i - 1]) || !isOperand(items[i + 1])) continue;
                found = i;
                if (!rightAssoc) break;
            }
            if (found < 0) return;
            const result = apply(
                (items[found] as { op: string }).op,
                items[found - 1] as number,
                items[found + 1] as number
            );
            items.splice(found - 1, 3, result);
        }
    };
    // Fold a postfix operator onto the operand before it, leftmost first.
    const foldPostfix = (op: string, apply: (a: number) => number) => {
        for (;;) {
            const found = items.findIndex(
                (item, i) => typeof item !== 'number' && item.op === op && isOperand(items[i - 1])
            );
            if (found < 0) return;
            items.splice(found - 1, 2, apply(items[found - 1] as number));
        }
    };

    foldBinary(['^^'], (_, a, b) => tetration(a, b), true); // tetration, right-associative
    foldBinary(['^'], (_, a, b) => a ** b, true); // power, right-associative
    // `!` folds AFTER the power level: mXparser computes `2^3!` as `(2^3)!` = 40320.
    foldPostfix('!', (a) => factorial(a));
    foldBinary(['#'], (_, a, b) => (Number.isNaN(a) || Number.isNaN(b) ? NaN : a % b)); // MathFunctions.mod
    foldBinary(['*', '/'], (op, a, b) => (op === '*' ? a * b : a / b));
    foldBinary(['+', '-'], (op, a, b) => (op === '+' ? a + b : a - b));
    // Binary relations: calculate() checks each spelling group in this fixed order, so all
    // not-equals fold before all equals, which fold before `<`, `>`, `<=`, `>=`.
    foldBinary(['<>', '~=', '!='], (_, a, b) => negate3(relationEq(a, b)));
    foldBinary(['=', '=='], (_, a, b) => relationEq(a, b));
    foldBinary(['<'], (_, a, b) => relationCompare(a, b, (x, y, eps) => x < y - eps));
    foldBinary(['>'], (_, a, b) => relationCompare(a, b, (x, y, eps) => x > y + eps));
    foldBinary(['<='], (_, a, b) => relationCompare(a, b, (x, y, eps) => x <= y + eps));
    foldBinary(['>='], (_, a, b) => relationCompare(a, b, (x, y, eps) => x >= y - eps));
    // Boolean families in BooleanAlgebra's three-valued logic (NaN = unknown): the AND/NAND level,
    // then OR/NOR/XOR, then the implications, mirroring bolCalc's priority groups.
    foldBinary(['&', '&&', '~&', '~&&'], (op, a, b) =>
        op.startsWith('~') ? negate3(and3(a, b)) : and3(a, b)
    );
    foldBinary(['|', '||', '~|', '~||', '(+)'], (op, a, b) =>
        op === '(+)' ? xor3(a, b) : op.startsWith('~') ? negate3(or3(a, b)) : or3(a, b)
    );
    foldBinary(['-->', '<--', '-/>', '</-', '<->'], (op, a, b) => {
        if (op === '<->') return negate3(xor3(a, b));
        const forward = op === '-->' || op === '-/>' ? imp3(a, b) : imp3(b, a);
        return op === '-/>' || op === '</-' ? negate3(forward) : forward;
    });
    // Bitwise binds loosest of all in calculate(); operands go through a C# (long) cast.
    foldBinary(['@&', '@|', '@^', '@<<', '@>>'], bitwise);

    // An operator none of the folds handle leaves the sequence partially collapsed, and returning
    // the left operand as the "result" would lie. Show nothing instead.
    if (items.length !== 1 || !isOperand(items[0])) return null;
    // calculate() finishes with almost-integer rounding, which is what lets the game read
    // `(&A) * (0.2 / 0.1)` into an int field. Division by zero (`Infinity`) and NaN are not real
    // numbers; return null like evaluateFunction so callers show nothing rather than "= Infinity".
    const settled = almostIntRound(items[0]);
    return isFinite(settled) ? settled : null;
};

// mXparser's BinaryRelations.DEFAULT_COMPARISON_EPSILON, also used by BooleanAlgebra to decide
// truthiness (epsilon comparison is on by default and the game never turns it off).
const COMPARISON_EPSILON = 1e-14;

const ulpFloat = new Float64Array(1);
const ulpBits = new BigUint64Array(ulpFloat.buffer);
/**
 * MathFunctions.ulp on the magnitude: the distance from |x| to the next representable double. A
 * negative operand does not widen the tolerance, so `(-4) == (-5)` is 0.
 */
const ulp = (x: number): number => {
    if (Number.isNaN(x)) return NaN;
    const magnitude = Math.abs(x);
    ulpFloat[0] = magnitude;
    ulpBits[0] += 1n;
    return ulpFloat[0] - magnitude;
};

/** The epsilon a relation compares with: max(1e-14, ulp(b)), or exact for infinite operands. */
const relationEpsilon = (a: number, b: number): number =>
    !isFinite(a) || !isFinite(b) ? 0 : Math.max(COMPARISON_EPSILON, ulp(b));

/** BinaryRelations.eq: NaN-propagating epsilon equality. */
const relationEq = (a: number, b: number): number => {
    if (Number.isNaN(a) || Number.isNaN(b)) return NaN;
    return Math.abs(a - b) <= relationEpsilon(a, b) ? 1 : 0;
};

/** BinaryRelations.lt/gt/leq/geq share this shape, differing only in the epsilon-shifted compare. */
const relationCompare = (a: number, b: number, compare: (a: number, b: number, eps: number) => boolean): number => {
    if (Number.isNaN(a) || Number.isNaN(b)) return NaN;
    return compare(a, b, relationEpsilon(a, b)) ? 1 : 0;
};

/** BooleanAlgebra.double2IntBoolean: NaN = unknown, |x| > epsilon = true, else false. */
const bool3 = (x: number): boolean | null => (Number.isNaN(x) ? null : Math.abs(x) > COMPARISON_EPSILON);

/** Kleene three-valued AND, matching BooleanAlgebra.AND_TRUTH_TABLE (false dominates unknown). */
const and3 = (a: number, b: number): number => {
    const x = bool3(a);
    const y = bool3(b);
    if (x === false || y === false) return 0;
    if (x === null || y === null) return NaN;
    return 1;
};

/** Kleene three-valued OR, matching BooleanAlgebra.OR_TRUTH_TABLE (true dominates unknown). */
const or3 = (a: number, b: number): number => {
    const x = bool3(a);
    const y = bool3(b);
    if (x === true || y === true) return 1;
    if (x === null || y === null) return NaN;
    return 0;
};

/** Kleene three-valued XOR: any unknown operand makes the result unknown. */
const xor3 = (a: number, b: number): number => {
    const x = bool3(a);
    const y = bool3(b);
    if (x === null || y === null) return NaN;
    return x !== y ? 1 : 0;
};

/** Kleene implication a --> b = (not a) or b, matching BooleanAlgebra.IMP_TRUTH_TABLE. */
const imp3 = (a: number, b: number): number => {
    const x = bool3(a);
    const y = bool3(b);
    if (x === false || y === true) return 1;
    if (x === null || y === null) return NaN;
    return 0;
};

/** Boolean negation of an already-collapsed 0/1/NaN result. */
const negate3 = (r: number): number => (Number.isNaN(r) ? NaN : r > COMPARISON_EPSILON ? 0 : 1);

/**
 * The bitwise operators fold their operands through a C# (long) cast. Anything a long cannot
 * faithfully hold (NaN, infinities, magnitudes past 2^63) is undefined behavior in the game, so
 * return NaN and let the caller show nothing. Shift counts wrap at 64 like C# long shifts.
 */
const bitwise = (op: string, a: number, b: number): number => {
    if (!isFinite(a) || !isFinite(b) || Math.abs(a) >= 2 ** 63 || Math.abs(b) >= 2 ** 63) return NaN;
    const x = BigInt(Math.trunc(a));
    const y = BigInt(Math.trunc(b));
    let result: bigint;
    switch (op) {
        case '@&':
            result = x & y;
            break;
        case '@|':
            result = x | y;
            break;
        case '@^':
            result = x ^ y;
            break;
        case '@<<':
            result = BigInt.asIntN(64, x << (y & 63n));
            break;
        default:
            result = x >> (y & 63n);
            break;
    }
    return Number(result);
};

/**
 * MathFunctions.tetration for finite arguments: n < 0 or an (almost) zero base with
 * (almost) zero height is NaN, height floors to an integer, then `a` is power-iterated. The
 * infinite-height branch (Lambert W convergence) never shows up in .rules math and returns NaN.
 */
const tetration = (a: number, n: number): number => {
    if (Number.isNaN(a) || Number.isNaN(n) || !isFinite(n)) return NaN;
    if (n < -COMPARISON_EPSILON) return NaN;
    if (Math.abs(n) <= COMPARISON_EPSILON || Math.floor(n) === 0) {
        return Math.abs(a) > COMPARISON_EPSILON ? 1 : NaN;
    }
    if (Math.abs(a) <= COMPARISON_EPSILON) return 0;
    const height = Math.floor(n);
    let result = a;
    for (let i = 2; i <= height && isFinite(result); i++) result = a ** result;
    return result;
};

/**
 * mXparser's almost-integer rounding, applied at the end of every calculate(): a result within
 * 1e-14 of an integer snaps to it. This is why `0.1 * 30` reads as exactly 3 in the game.
 */
const almostIntRound = (x: number): number => {
    if (!isFinite(x)) return x;
    const rounded = Math.round(x);
    return Math.abs(x - rounded) <= COMPARISON_EPSILON ? rounded : x;
};

const evaluateFunction = async (node: FunctionCallNode, context: EvalContext): Promise<number | null> => {
    const fn = mathFunction(node.name)?.evaluate;
    if (!fn) return null;
    const args: number[] = [];
    for (const group of segmentArguments(node.arguments)) {
        const value = await evaluateSequence(group, context);
        if (value === null) return null;
        args.push(value);
    }
    const result = args.length ? fn(args) : null;
    if (result === null) return null;
    // A function call standing alone as the field value still goes through one calculate() in the
    // game, so its result gets the same almost-integer rounding as a folded sequence.
    const settled = almostIntRound(result);
    return isFinite(settled) ? settled : null;
};

/**
 * mXparser factorial (`n!`). Defined here only for non-negative integers up to 170 (171! overflows
 * to Infinity). Anything else returns NaN so the caller shows nothing rather than a bogus number.
 */
const factorial = (n: number): number => {
    if (!Number.isInteger(n) || n < 0 || n > 170) return NaN;
    let result = 1;
    for (let i = 2; i <= n; i++) result *= i;
    return result;
};

/** Format a computed value for display: trims floating-point noise and trailing zeros. */
export const formatNumber = (value: number): string => {
    const rounded = Math.round(value * 1e6) / 1e6;
    return String(rounded);
};
