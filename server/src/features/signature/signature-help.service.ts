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

/** A character a function name may hold, hoisted out of the per-character scan below. */
const IDENT_CHAR = /[A-Za-z0-9_]/;

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
    const [, max] = spec.arity;
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
    // The name is shown as written, since only that spelling is the one the game accepts.
    const name = rawName;
    const params = paramsOf(spec);
    return {
        label: `${name}(${params.join(', ')})`,
        documentation: spec.doc ?? 'mXparser math function.',
        parameters: params.map((p) => ({ label: p })),
    };
};

/** The active function call enclosing `offset`, found by a forward scan that tracks parenthesis nesting. */
interface ActiveCall {
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
 * The offset the scan for an enclosing call starts at: the beginning of the value's own line.
 *
 * A field value ends at the newline unless the line is continued with a trailing backslash, so a
 * call can never begin on an earlier line than that. Scanning further back used to hand a comment
 * on one line to a value on the next.
 *
 * @param text the whole document text.
 * @param offset the cursor position.
 * @returns the offset to start scanning at.
 */
const valueStartOffset = (text: string, offset: number): number => {
    let start = text.lastIndexOf('\n', offset - 1) + 1;
    while (start > 0) {
        const lineBefore = text.slice(text.lastIndexOf('\n', start - 2) + 1, start - 1).trimEnd();
        if (!lineBefore.endsWith('\\')) break;
        start = text.lastIndexOf('\n', start - 2) + 1;
    }
    return start;
};

/**
 * Reconstruct the call stack at `offset` by scanning `text` forward from the start of the value.
 * Returns the innermost frame that belongs to a named function call, with the count of top-level
 * commas seen inside it so far (the active argument index). Returns undefined when the cursor is not
 * inside any `name(` call, including when it sits in a comment.
 */
export const activeCallAt = (text: string, offset: number): ActiveCall | undefined => {
    const start = valueStartOffset(text, offset);
    const stack: Frame[] = [];
    let pendingIdent = '';
    let inString = false;

    for (let i = start; i < offset; i++) {
        const c = text[i];
        if (inString) {
            // A quote the value escapes does not end the string, and reading it as an end used to
            // flip the rest of the line into "code" and answer a call for plain text.
            if (c === '\\') {
                i++;
                continue;
            }
            if (c === '"') inString = false;
            continue;
        }
        // Everything after a line comment belongs to the comment, so no call encloses the cursor.
        if (c === '/' && text[i + 1] === '/') return undefined;
        if (c === '/' && text[i + 1] === '*') {
            const close = text.indexOf('*/', i + 2);
            if (close < 0 || close + 2 > offset) return undefined;
            i = close + 1;
            pendingIdent = '';
            continue;
        }
        if (c === '"') {
            inString = true;
            pendingIdent = '';
            continue;
        }
        if (IDENT_CHAR.test(c)) {
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
