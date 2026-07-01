/**
 * Signature help for the math/function calls that appear in `.rules` values (`Damage = ceil(&Base / 2)`).
 *
 * As the cursor sits inside a function's parentheses we show the function's parameter list and
 * highlight the argument currently being typed. The active call and active parameter are found by a
 * raw-text scan rather than the AST: the parser flattens nested calls (`floor(sqrt(x))` keeps no
 * inner `FunctionCallNode`) and, more importantly, signature help fires while typing — right after a
 * `(` or `,` — when the document is incomplete and the AST has no clean call node yet. A forward
 * scan over the characters reconstructs the call nesting from parentheses directly, so it works
 * mid-edit and handles arbitrary nesting uniformly.
 */
import { SignatureHelp, SignatureInformation } from 'vscode-languageserver/node';
import { FUNCTION_ARITY } from '../../semantics/value-evaluator';
import { MXPARSER_FUNCTION_NAMES, COSMOTEER_FUNCTION_NAMES } from '../../semantics/mxparser-functions';

interface Signature {
    /** Ordered parameter names, each a substring of the rendered label so the client can highlight it. */
    params: readonly string[];
    /** One-line human description shown under the signature. */
    doc: string;
    /** Variadic functions (`min`, `max`, …) keep highlighting their single `…values` slot. */
    variadic?: boolean;
}

const unary = (param: string, doc: string): Signature => ({ params: [param], doc });
const trig = (doc: string): Signature => unary('angle', doc);
const invTrig = (doc: string): Signature => unary('x', doc);

/**
 * Curated signatures for the functions whose meaning we know — the numerically-evaluatable set plus
 * Cosmoteer's `db2vol`. Keyed by lowercase name. Aliases (`tg`/`tan`, `lg`/`log10`, …) share an
 * entry. Any other valid-but-unmodelled mXparser keyword still gets a generic `name(…)` signature so
 * help appears for it too, just without named parameters.
 */
const SIGNATURES: Record<string, Signature> = {
    ceil: unary('x', 'Round up to the nearest integer.'),
    floor: unary('x', 'Round down to the nearest integer.'),
    round: { params: ['x', 'places'], doc: 'Round to the nearest integer, or to `places` decimals.' },
    abs: unary('x', 'Absolute value.'),
    sign: unary('x', 'Sign of x: -1, 0 or 1.'),
    sgn: unary('x', 'Sign of x: -1, 0 or 1.'),
    sqrt: unary('x', 'Square root.'),
    cbrt: unary('x', 'Cube root.'),
    exp: unary('x', 'e raised to the power x.'),
    ln: unary('x', 'Natural logarithm (base e).'),
    log2: unary('x', 'Logarithm base 2.'),
    log10: unary('x', 'Logarithm base 10.'),
    lg: unary('x', 'Logarithm base 10.'),
    log: { params: ['base', 'x'], doc: 'Logarithm of x to the given base.' },
    pow: { params: ['base', 'exponent'], doc: 'base raised to the power exponent.' },
    mod: { params: ['a', 'b'], doc: 'Remainder of a divided by b.' },
    atan2: { params: ['y', 'x'], doc: 'Angle of the vector (x, y), in radians.' },
    sin: trig('Sine of an angle (radians).'),
    cos: trig('Cosine of an angle (radians).'),
    tan: trig('Tangent of an angle (radians).'),
    tg: trig('Tangent of an angle (radians).'),
    cot: trig('Cotangent of an angle (radians).'),
    ctg: trig('Cotangent of an angle (radians).'),
    ctan: trig('Cotangent of an angle (radians).'),
    sec: trig('Secant of an angle (radians).'),
    csc: trig('Cosecant of an angle (radians).'),
    cosec: trig('Cosecant of an angle (radians).'),
    asin: invTrig('Arc sine, in radians.'),
    arcsin: invTrig('Arc sine, in radians.'),
    acos: invTrig('Arc cosine, in radians.'),
    arccos: invTrig('Arc cosine, in radians.'),
    atan: invTrig('Arc tangent, in radians.'),
    arctan: invTrig('Arc tangent, in radians.'),
    arctg: invTrig('Arc tangent, in radians.'),
    sinh: invTrig('Hyperbolic sine.'),
    cosh: invTrig('Hyperbolic cosine.'),
    tanh: invTrig('Hyperbolic tangent.'),
    asinh: invTrig('Inverse hyperbolic sine.'),
    acosh: invTrig('Inverse hyperbolic cosine.'),
    atanh: invTrig('Inverse hyperbolic tangent.'),
    min: { params: ['…values'], doc: 'Smallest of the given values.', variadic: true },
    max: { params: ['…values'], doc: 'Largest of the given values.', variadic: true },
    sum: { params: ['…values'], doc: 'Sum of the given values.', variadic: true },
    avg: { params: ['…values'], doc: 'Average of the given values.', variadic: true },
    db2vol: { params: ['"decibels"'], doc: 'Convert a decibel string to a linear volume.' },
};

/** True for any name that should get signature help — a curated, evaluatable or valid mXparser/Cosmoteer function. */
const isKnownFunction = (name: string): boolean =>
    name in SIGNATURES || MXPARSER_FUNCTION_NAMES.has(name) || COSMOTEER_FUNCTION_NAMES.has(name) || name in FUNCTION_ARITY;

/** Build the LSP signature for a function name (curated if known, else a generic variadic `name(…)`). */
const buildSignature = (rawName: string): SignatureInformation => {
    const name = rawName.toLowerCase();
    const sig = SIGNATURES[name] ?? { params: ['…'], doc: 'mXparser math function.', variadic: true };
    const label = `${name}(${sig.params.join(', ')})`;
    return {
        label,
        documentation: sig.doc,
        parameters: sig.params.map((p) => ({ label: p })),
    };
};

/** The active function call enclosing `offset`, found by a forward scan that tracks parenthesis nesting. */
export interface ActiveCall {
    name: string;
    /** Zero-based index of the argument the cursor is in (commas before it at this call's depth). */
    activeParameter: number;
}

interface Frame {
    /** Function name immediately before this `(`, or null for a plain grouping `(`. */
    name: string | null;
    commas: number;
}

/**
 * Reconstruct the call stack at `offset` by scanning `text` forward from a bounded window. Returns
 * the innermost frame that belongs to a named function call, with the count of top-level commas seen
 * inside it so far (the active argument index). Returns undefined when the cursor is not inside any
 * `name(` call.
 */
export const activeCallAt = (text: string, offset: number): ActiveCall | undefined => {
    // A 4 KB look-back comfortably covers any realistic single value expression while bounding work.
    const start = Math.max(0, offset - 4096);
    const stack: Frame[] = [];
    let pendingIdent = '';
    let inString = false;

    for (let i = start; i < offset; i++) {
        const c = text[i];
        if (inString) {
            if (c === '"') inString = false;
            continue;
        }
        if (c === '"') {
            inString = true;
            pendingIdent = '';
            continue;
        }
        if (/[A-Za-z0-9_]/.test(c)) {
            pendingIdent += c;
            continue;
        }
        if (c === '(') {
            // `name(` (identifier immediately before, no separator) starts a function frame. A bare
            // `(` is a grouping frame whose own commas must not count toward an outer call's args.
            stack.push({ name: pendingIdent || null, commas: 0 });
        } else if (c === ')') {
            stack.pop();
        } else if (c === ',') {
            if (stack.length) stack[stack.length - 1].commas++;
        }
        pendingIdent = '';
    }

    for (let i = stack.length - 1; i >= 0; i--) {
        const frame = stack[i];
        if (frame.name) return { name: frame.name, activeParameter: frame.commas };
    }
    return undefined;
};

/** Compute signature help for the math function call the cursor sits in, or null if there is none. */
export const computeSignatureHelp = (text: string, offset: number): SignatureHelp | null => {
    const active = activeCallAt(text, offset);
    if (!active || !isKnownFunction(active.name.toLowerCase())) return null;

    const signature = buildSignature(active.name);
    const paramCount = signature.parameters?.length ?? 0;
    const sig = SIGNATURES[active.name.toLowerCase()];
    // Clamp the highlighted parameter to the last slot: variadic functions keep highlighting their
    // single `…values` slot, and an over-typed fixed-arity call keeps the last parameter lit rather
    // than highlighting nothing.
    const activeParameter = paramCount === 0 ? 0 : Math.min(active.activeParameter, paramCount - 1);

    return {
        signatures: [signature],
        activeSignature: 0,
        activeParameter: sig?.variadic ? 0 : activeParameter,
    };
};
