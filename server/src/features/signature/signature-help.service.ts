/**
 * Signature help for the math/function calls that appear in `.rules` values (`Damage = ceil(&Base / 2)`).
 *
 * As the cursor sits inside a function's parentheses we show the function's parameter list and
 * highlight the argument currently being typed. The active call and active parameter are found by a
 * raw-text scan rather than the AST: the parser flattens nested calls (`floor(sqrt(x))` keeps no
 * inner `FunctionCallNode`) and, more importantly, signature help fires while typing (right after a
 * `(` or `,`) when the document is incomplete and the AST has no clean call node yet. A forward
 * scan over the characters reconstructs the call nesting from parentheses directly, so it works
 * mid-edit and handles arbitrary nesting uniformly.
 */
import { SignatureHelp, SignatureInformation } from 'vscode-languageserver/node';
import { MathFunctionSpec, mathFunction } from '../../semantics/math-function-registry';

// Fallback parameter names for registry entries that declare an arity but no named params.
const GENERIC_PARAM_NAMES = ['a', 'b', 'c', 'd', 'e'];

/**
 * Derive the parameter labels for a spec: curated names when present, otherwise generic names from
 * the arity (`x` for unary, `a, b` for binary, `…values` for variadic). An optional tail parameter
 * of a `[min, max]` range is rendered too, the highlight clamp below keeps it usable. Shared with
 * math-function completion, whose items show the same signature as their detail.
 *
 * @param spec the registry entry to render.
 * @returns the ordered parameter labels for the signature.
 */
export const paramsOf = (spec: MathFunctionSpec): readonly string[] => {
    if (spec.params) return spec.params;
    const [min, max] = spec.arity;
    if (!isFinite(max)) return ['…values'];
    if (max === 1) return ['x'];
    return GENERIC_PARAM_NAMES.slice(0, max);
};

/**
 * Build the LSP signature for a known function name from its registry entry.
 *
 * @param rawName the function name as written in the document.
 * @param spec the registry entry for that name.
 * @returns the rendered signature with one label per parameter.
 */
const buildSignature = (rawName: string, spec: MathFunctionSpec): SignatureInformation => {
    const name = rawName.toLowerCase();
    const params = paramsOf(spec);
    return {
        label: `${name}(${params.join(', ')})`,
        documentation: spec.doc ?? 'mXparser math function.',
        parameters: params.map((p) => ({ label: p })),
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
    const spec = active ? mathFunction(active.name) : undefined;
    if (!active || !spec) return null;

    const signature = buildSignature(active.name, spec);
    const paramCount = signature.parameters?.length ?? 0;
    // Clamp the highlighted parameter to the last slot: variadic functions keep highlighting their
    // single `…values` slot, and an over-typed fixed-arity call keeps the last parameter lit rather
    // than highlighting nothing.
    const activeParameter = paramCount === 0 ? 0 : Math.min(active.activeParameter, paramCount - 1);

    return {
        signatures: [signature],
        activeSignature: 0,
        activeParameter: isFinite(spec.arity[1]) ? activeParameter : 0,
    };
};
