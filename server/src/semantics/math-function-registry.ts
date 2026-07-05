/**
 * The single source of truth for every math function the extension knows about. Signature help,
 * the unknown-function and arity diagnostics, argument-type checking and numeric evaluation are
 * all derived from this one table, so when the game's math vocabulary changes (a Cosmoteer update,
 * a new mXparser version) only this file needs to be edited:
 *
 * - a new plain function with no special tooling: add its name to the matching arity group below
 *   (UNARY_NAMES, BINARY_NAMES, TERNARY_NAMES, VARIADIC_NAMES).
 * - a function we should also evaluate, document or type-check: add or extend a CURATED entry
 *   (evaluate closure, named params, doc line). Curated entries override the plain groups.
 * - a new game-registered function (found by decompiling the `IMathFunction` implementations in
 *   `Cosmoteer.dll`, see the `inspect-cosmoteer-ot-format` skill): add a CURATED entry with
 *   `source: 'cosmoteer'`.
 *
 * The base vocabulary is mXparser's built-in collection, taken from
 * https://mathparser.org/mxparser-math-collection/ (Cosmoteer's expressions are
 * mXparser-compatible). All lookups are case-insensitive, every key here is lowercase.
 */

export interface MathFunctionSpec {
    /**
     * Inclusive argument-count bounds. `max` is `Infinity` for variadic functions. Arity is only
     * enforced as a too-few-arguments check (see validator.functioncall.ts): the parser flattens
     * nested calls into extra operands, so an over-count is unreliable and never flagged.
     */
    arity: [number, number];
    /** Named parameters for signature help. When absent, generic names are derived from the arity. */
    params?: readonly string[];
    /** One-line human description shown under the signature in signature help. */
    doc?: string;
    /** Pure numeric implementation, present only for the subset we can evaluate for inlay hints. */
    evaluate?: (args: number[]) => number | null;
    /**
     * Where the name comes from: the mXparser built-in collection, a Cosmoteer-registered
     * `IMathFunction`, or an extra name we accept for compatibility (seen working in the wild
     * although it is not part of the documented mXparser collection).
     */
    source: 'mxparser' | 'cosmoteer' | 'extra';
}

// Plain mXparser vocabulary, grouped by arity. Functions listed here are recognized (no
// unknown-function diagnostic), get generic signature help and a too-few-arguments check, but are
// not evaluated. Move a name into CURATED below to give it an implementation or documentation.

const UNARY_NAMES = [
    'sin', 'cos', 'tg', 'tan', 'ctg', 'cot', 'ctan', 'sec', 'csc', 'cosec',
    'asin', 'arsin', 'arcsin', 'acos', 'arcos', 'arccos', 'atg', 'atan', 'arctg', 'arctan',
    'actg', 'acot', 'actan', 'arcctg', 'arccot', 'arcctan', 'ln', 'log2', 'lg', 'log10',
    'rad', 'exp', 'sqrt', 'sinh', 'cosh', 'tgh', 'tanh', 'coth', 'ctgh', 'ctanh',
    'sech', 'csch', 'cosech', 'deg', 'abs', 'sgn', 'floor', 'ceil', 'not', 'asinh',
    'arsinh', 'arcsinh', 'acosh', 'arcosh', 'arccosh', 'atgh', 'atanh', 'arctgh', 'arctanh', 'acoth',
    'actgh', 'actanh', 'arcoth', 'arccoth', 'arcctgh', 'arcctanh', 'asech', 'arsech', 'arcsech', 'acsch',
    'arcsch', 'arccsch', 'acosech', 'arcosech', 'arccosech', 'sa', 'sinc', 'bell', 'luc', 'fib',
    'harm', 'ispr', 'pi', 'ei', 'li', 'erf', 'erfc', 'erfinv', 'erfcinv', 'ulp',
    'isnan', 'ndig10', 'nfact', 'arcsec', 'arccsc', 'gamma', 'lambw0', 'lambw1', 'sgngamma', 'loggamma',
    'digamma', 'rstud', 'rchi2',
];

const BINARY_NAMES = [
    'log', 'mod', 'c', 'nck', 'bern', 'stirl1', 'stirl2', 'worp', 'euler', 'kdelta',
    'eulerpol', 'runi', 'runid', 'round', 'rnor', 'ndig', 'dig10', 'factval', 'factexp', 'root',
    'gammal', 'gammau', 'gammap', 'gammaregl', 'gammaq', 'gammaregu', 'npk', 'beta', 'logbeta', 'pstud',
    'cstud', 'qstud', 'pchi2', 'cchi2', 'qchi2', 'rfsned',
];

const TERNARY_NAMES = [
    'if', 'chi', 'puni', 'cuni', 'quni', 'pnor', 'cnor', 'qnor', 'dig', 'betainc',
    'betai', 'betareg', 'pfsned', 'cfsned', 'qfsned',
];

const VARIADIC_NAMES = [
    'iff', 'min', 'max', 'confrac', 'conpol', 'gcd', 'lcm', 'add', 'multi', 'mean',
    'var', 'std', 'rlist', 'coalesce', 'or', 'and', 'xor', 'argmin', 'argmax', 'med',
    'mode', 'base', 'ndist',
];

// Evaluate-closure helpers. Each rejects a call with the wrong argument count by returning null,
// mirroring the arity the spec declares.
const unaryFn = (fn: (x: number) => number) => (a: number[]) => (a.length === 1 ? fn(a[0]) : null);
const binaryFn = (fn: (x: number, y: number) => number) => (a: number[]) => (a.length === 2 ? fn(a[0], a[1]) : null);
const variadicFn = (fn: (xs: number[]) => number) => (a: number[]) => (a.length ? fn(a) : null);

// Spec builders for the curated table.
const unary = (param: string, doc: string, evaluate?: (args: number[]) => number | null): MathFunctionSpec => ({
    arity: [1, 1],
    params: [param],
    doc,
    evaluate,
    source: 'mxparser',
});
const trig = (doc: string, fn: (x: number) => number): MathFunctionSpec => unary('angle', doc, unaryFn(fn));
const invTrig = (doc: string, fn: (x: number) => number): MathFunctionSpec => unary('x', doc, unaryFn(fn));
const variadic = (doc: string, fn: (xs: number[]) => number): MathFunctionSpec => ({
    arity: [1, Infinity],
    params: ['…values'],
    doc,
    evaluate: variadicFn(fn),
    source: 'mxparser',
});

/**
 * The functions whose meaning we model: numeric implementations follow mXparser semantics
 * (https://mathparser.org/mxparser-math-collection/), trigonometry is in radians and `ln` is the
 * natural log. Aliases (`tg`/`tan`, `lg`/`log10`) are separate entries sharing an implementation.
 * Argument-type checking (number or reference) applies only to entries with an `evaluate`, other
 * functions have signatures we do not model and would false-positive.
 */
const CURATED: Record<string, MathFunctionSpec> = {
    // Rounding, sign, magnitude
    ceil: unary('x', 'Round up to the nearest integer.', unaryFn(Math.ceil)),
    floor: unary('x', 'Round down to the nearest integer.', unaryFn(Math.floor)),
    round: {
        arity: [1, 2],
        params: ['x', 'places'],
        doc: 'Round to the nearest integer, or to `places` decimals.',
        // mXparser `round(x, n)` rounds to n decimals and a lone `round(x)` is the nearest integer.
        evaluate: (a) =>
            a.length === 1 ? Math.round(a[0]) : a.length === 2 ? Math.round(a[0] * 10 ** a[1]) / 10 ** a[1] : null,
        source: 'mxparser',
    },
    abs: unary('x', 'Absolute value.', unaryFn(Math.abs)),
    sign: { ...unary('x', 'Sign of x: -1, 0 or 1.', unaryFn(Math.sign)), source: 'extra' },
    sgn: unary('x', 'Sign of x: -1, 0 or 1.', unaryFn(Math.sign)),
    // Roots, powers, exponential, logarithms
    sqrt: unary('x', 'Square root.', unaryFn(Math.sqrt)),
    cbrt: { ...unary('x', 'Cube root.', unaryFn(Math.cbrt)), source: 'extra' },
    exp: unary('x', 'e raised to the power x.', unaryFn(Math.exp)),
    ln: unary('x', 'Natural logarithm (base e).', unaryFn(Math.log)),
    log2: unary('x', 'Logarithm base 2.', unaryFn(Math.log2)),
    log10: unary('x', 'Logarithm base 10.', unaryFn(Math.log10)),
    lg: unary('x', 'Logarithm base 10.', unaryFn(Math.log10)),
    log: {
        arity: [2, 2],
        params: ['base', 'x'],
        doc: 'Logarithm of x to the given base.',
        // mXparser `log(a, b)` is log base a of b.
        evaluate: binaryFn((base, x) => Math.log(x) / Math.log(base)),
        source: 'mxparser',
    },
    pow: {
        arity: [2, 2],
        params: ['base', 'exponent'],
        doc: 'base raised to the power exponent.',
        evaluate: binaryFn(Math.pow),
        source: 'extra',
    },
    mod: {
        arity: [2, 2],
        params: ['a', 'b'],
        doc: 'Remainder of a divided by b.',
        evaluate: binaryFn((x, y) => x % y),
        source: 'mxparser',
    },
    atan2: {
        arity: [2, 2],
        params: ['y', 'x'],
        doc: 'Angle of the vector (x, y), in radians.',
        evaluate: binaryFn(Math.atan2),
        source: 'extra',
    },
    // Trigonometry, radians
    sin: trig('Sine of an angle (radians).', Math.sin),
    cos: trig('Cosine of an angle (radians).', Math.cos),
    tan: trig('Tangent of an angle (radians).', Math.tan),
    tg: trig('Tangent of an angle (radians).', Math.tan),
    cot: trig('Cotangent of an angle (radians).', (x) => 1 / Math.tan(x)),
    ctg: trig('Cotangent of an angle (radians).', (x) => 1 / Math.tan(x)),
    ctan: trig('Cotangent of an angle (radians).', (x) => 1 / Math.tan(x)),
    sec: trig('Secant of an angle (radians).', (x) => 1 / Math.cos(x)),
    csc: trig('Cosecant of an angle (radians).', (x) => 1 / Math.sin(x)),
    cosec: trig('Cosecant of an angle (radians).', (x) => 1 / Math.sin(x)),
    asin: invTrig('Arc sine, in radians.', Math.asin),
    arcsin: invTrig('Arc sine, in radians.', Math.asin),
    acos: invTrig('Arc cosine, in radians.', Math.acos),
    arccos: invTrig('Arc cosine, in radians.', Math.acos),
    atan: invTrig('Arc tangent, in radians.', Math.atan),
    arctan: invTrig('Arc tangent, in radians.', Math.atan),
    arctg: invTrig('Arc tangent, in radians.', Math.atan),
    // Hyperbolic
    sinh: invTrig('Hyperbolic sine.', Math.sinh),
    cosh: invTrig('Hyperbolic cosine.', Math.cosh),
    tanh: invTrig('Hyperbolic tangent.', Math.tanh),
    asinh: invTrig('Inverse hyperbolic sine.', Math.asinh),
    acosh: invTrig('Inverse hyperbolic cosine.', Math.acosh),
    atanh: invTrig('Inverse hyperbolic tangent.', Math.atanh),
    // Aggregates
    min: variadic('Smallest of the given values.', (xs) => Math.min(...xs)),
    max: variadic('Largest of the given values.', (xs) => Math.max(...xs)),
    sum: { ...variadic('Sum of the given values.', (xs) => xs.reduce((s, x) => s + x, 0)), source: 'extra' },
    avg: {
        ...variadic('Average of the given values.', (xs) => xs.reduce((s, x) => s + x, 0) / xs.length),
        source: 'extra',
    },
    // Cosmoteer-registered functions (decompiled `IMathFunction` implementations in Cosmoteer.dll).
    // As of the 2026-06 build the only one is `db2vol` (`DecibelsToVolumeMathFunction`); it takes a
    // quoted string argument, so it is never argument-type checked or evaluated.
    db2vol: {
        arity: [1, 1],
        params: ['"decibels"'],
        doc: 'Convert a decibel string to a linear volume.',
        source: 'cosmoteer',
    },
};

const buildRegistry = (): Record<string, MathFunctionSpec> => {
    const registry: Record<string, MathFunctionSpec> = {};
    const groups: [readonly string[], [number, number]][] = [
        [UNARY_NAMES, [1, 1]],
        [BINARY_NAMES, [2, 2]],
        [TERNARY_NAMES, [3, 3]],
        [VARIADIC_NAMES, [1, Infinity]],
    ];
    for (const [names, arity] of groups) {
        for (const name of names) registry[name] = { arity, source: 'mxparser' };
    }
    return Object.assign(registry, CURATED);
};

/** Every known math function, keyed by lowercase name. */
export const MATH_FUNCTIONS: Readonly<Record<string, MathFunctionSpec>> = buildRegistry();

/**
 * Look a function up by its written name.
 *
 * @param name the function name as written in the document (any casing).
 * @returns the spec, or undefined for an unknown name.
 */
export const mathFunction = (name: string): MathFunctionSpec | undefined => MATH_FUNCTIONS[name.toLowerCase()];

/** Lowercased names of every recognized math function. A name outside this set is a likely typo. */
export const ALL_MATH_FUNCTION_NAMES: ReadonlySet<string> = new Set(Object.keys(MATH_FUNCTIONS));

/** Lowercased names of the functions we can numerically evaluate (the entries with an implementation). */
export const KNOWN_FUNCTION_NAMES: ReadonlySet<string> = new Set(
    Object.keys(MATH_FUNCTIONS).filter((name) => MATH_FUNCTIONS[name].evaluate !== undefined)
);

/** mXparser mathematical constants usable bare in an expression (no `&`). */
export const CONSTANTS: Readonly<Record<string, number>> = {
    pi: Math.PI,
    e: Math.E,
};

/** Lowercased names of bare numeric constants (`pi`, `e`) that are valid operands without a `&`. */
export const KNOWN_CONSTANT_NAMES: ReadonlySet<string> = new Set(Object.keys(CONSTANTS));
