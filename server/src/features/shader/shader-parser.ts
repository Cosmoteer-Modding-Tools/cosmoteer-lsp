/**
 * A scanner for Cosmoteer `.shader` files (HLSL with a small preprocessor). It extracts the three
 * things the language server cares about: the `#include` chain, the entry-point function names, and
 * the top-level `_`-prefixed uniform declarations a material sets from its `.rules` file.
 *
 * It is deliberately a lexical scanner, not a real HLSL parser. It tracks brace depth so it can tell a
 * file-scope uniform from a local variable or a struct member, and it understands `cbuffer` blocks
 * (whose members are also file-scope uniforms), but it does not type-check or evaluate anything.
 */

/** The kind of a parsed uniform, mapped from its HLSL declaration type. */
export type ShaderConstantKind = 'texture' | 'sampler' | 'float' | 'vec2' | 'vec3' | 'vec4' | 'matrix' | 'int' | 'bool';

/** The source position of a declared name, so navigation can jump to it (0-based line and column). */
export interface DeclarationPosition {
    /** The 0-based line the name appears on. */
    readonly line: number;
    /** The 0-based column of the name's first character. */
    readonly column: number;
}

/** A `_`-prefixed uniform declared at file scope in a shader. */
export interface ShaderConstant {
    /** The constant name including its leading underscore, e.g. `_hotColor`. */
    readonly name: string;
    /** The normalized kind derived from the HLSL declaration type. */
    readonly kind: ShaderConstantKind;
    /** The raw HLSL type token as written, e.g. `float3` or `Texture2D`. */
    readonly hlslType: string;
    /** The literal default value text if the declaration has an initializer, else undefined. */
    readonly default?: string;
    /** Where the name is declared in this file, for go-to-definition and the outline. */
    readonly position?: DeclarationPosition;
}

/** A function defined at file scope, with the position of its name for navigation. */
export interface ShaderFunction {
    /** The function name, e.g. `pix` or `vert`. */
    readonly name: string;
    /** Where the name appears in this file. */
    readonly position: DeclarationPosition;
}

/** Everything the scanner pulls out of a single shader file, before includes are followed. */
export interface ParsedShader {
    /** The literal paths of every `#include "…"` directive, in source order. */
    readonly includes: readonly string[];
    /** The `_`-prefixed uniforms declared at file scope in this file alone. */
    readonly constants: readonly ShaderConstant[];
    /** The function names defined at file scope (entry-point candidates such as `vert`/`pix`). */
    readonly functions: readonly string[];
    /** The file-scope functions with the source position of each name, for navigation and the outline. */
    readonly functionDecls: readonly ShaderFunction[];
}

/** The HLSL declaration types the scanner recognizes, mapped to a normalized {@link ShaderConstantKind}. */
const TYPE_KINDS: Readonly<Record<string, ShaderConstantKind>> = {
    Texture2D: 'texture',
    Texture3D: 'texture',
    TextureCube: 'texture',
    SamplerState: 'sampler',
    float: 'float',
    float2: 'vec2',
    float3: 'vec3',
    float4: 'vec4',
    float2x2: 'matrix',
    float3x3: 'matrix',
    float4x4: 'matrix',
    matrix: 'matrix',
    int: 'int',
    uint: 'int',
    bool: 'bool',
};

const TYPE_TOKENS = Object.keys(TYPE_KINDS).join('|');

/** Matches a file-scope uniform declaration: an optional `static`/`const`, a known type, a `_name`. */
const UNIFORM_RE = new RegExp(
    `^\\s*(?:static\\s+|const\\s+|uniform\\s+)*(${TYPE_TOKENS})\\s+(_[A-Za-z0-9_]+)\\s*(?::\\s*[A-Za-z0-9_()]+)?\\s*(?:=\\s*([^;]+?))?\\s*;`
);

/** Matches a `cbuffer Name {` block opener (its members are file-scope uniforms). */
const CBUFFER_RE = /^\s*cbuffer\b/;

/** Matches a `struct Name {` block opener (its members are not uniforms). */
const STRUCT_RE = /^\s*struct\b/;

/** Matches a function definition opener, capturing the function name (used as an entry-point list). */
const FUNCTION_RE = /^\s*(?:\[[^\]]*\]\s*)*[A-Za-z_][\w<>]*\s+([A-Za-z_]\w*)\s*\(/;

/** Matches an `#include "path"` directive, capturing the quoted path. */
const INCLUDE_RE = /^\s*#\s*include\s+"([^"]+)"/;

/**
 * Removes comments and string/char literals from a line of HLSL so the scanner never trips over a
 * `{`, `}`, `;` or `_name` that lives inside one. Block comments are handled by the caller, this only
 * strips a `//` line comment and any double-quoted run on the line.
 *
 * @param line the raw source line.
 * @returns the line with `//` comments and quoted spans blanked out.
 */
const stripInline = (line: string): string => {
    let out = '';
    for (let i = 0; i < line.length; i++) {
        if (line[i] === '/' && line[i + 1] === '/') break;
        if (line[i] === '"') {
            i++;
            while (i < line.length && line[i] !== '"') i++;
            continue;
        }
        out += line[i];
    }
    return out;
};

/**
 * The column of a declared name in the original source line. The scanner matches against a
 * comment-stripped copy of the line, so the name is located in the raw line first (its true document
 * column), falling back to the stripped line when a same-line comment shifted it.
 *
 * @param raw the original source line, whose columns the editor uses.
 * @param code the comment-stripped line the regex matched against.
 * @param name the declared name to locate.
 * @returns the 0-based column of the name.
 */
const columnOf = (raw: string, code: string, name: string): number => {
    const inRaw = raw.indexOf(name);
    return inRaw >= 0 ? inRaw : Math.max(0, code.indexOf(name));
};

/** A frame on the brace stack, recording what kind of block a `{` opened. */
type BlockKind = 'cbuffer' | 'struct' | 'func' | 'block';

/**
 * Scans one shader file's source into its includes, file-scope uniforms, and function names. Uniforms
 * are collected at brace depth 0 and inside `cbuffer` blocks. Bodies of functions and structs are
 * skipped so their locals and members are never mistaken for uniforms. The preprocessor is treated
 * permissively, an `#ifdef`-guarded uniform is still reported so completion can offer it.
 *
 * @param source the full text of a `.shader` file.
 * @returns the includes, constants, and function names found in this file alone.
 */
export const parseShader = (source: string): ParsedShader => {
    const includes: string[] = [];
    const constants: ShaderConstant[] = [];
    const functions: string[] = [];
    const functionDecls: ShaderFunction[] = [];
    const seen = new Set<string>();
    const stack: BlockKind[] = [];

    // The directive that opened the next `{` we encounter, remembered across the lines between the
    // declaration and its brace (a function signature can span several lines).
    let pendingBlock: BlockKind | null = null;
    let inBlockComment = false;

    const lines = source.split(/\r?\n/);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const raw = lines[lineIndex];
        let line = raw;
        if (inBlockComment) {
            const end = line.indexOf('*/');
            if (end < 0) continue;
            line = line.slice(end + 2);
            inBlockComment = false;
        }
        // Drop any block comment that opens and does not close on this line.
        for (;;) {
            const open = line.indexOf('/*');
            if (open < 0) break;
            const close = line.indexOf('*/', open + 2);
            if (close < 0) {
                line = line.slice(0, open);
                inBlockComment = true;
                break;
            }
            line = line.slice(0, open) + ' ' + line.slice(close + 2);
        }

        const include = INCLUDE_RE.exec(raw);
        if (include) includes.push(include[1]);

        const code = stripInline(line);
        const atFileScope = stack.length === 0;
        const inCbuffer = stack[stack.length - 1] === 'cbuffer';

        // A uniform is real only at file scope or directly inside a cbuffer.
        if (atFileScope || inCbuffer) {
            const uniform = UNIFORM_RE.exec(code);
            if (uniform && !seen.has(uniform[2])) {
                seen.add(uniform[2]);
                const column = columnOf(raw, code, uniform[2]);
                constants.push({
                    name: uniform[2],
                    kind: TYPE_KINDS[uniform[1]],
                    hlslType: uniform[1],
                    default: uniform[3]?.trim() || undefined,
                    position: { line: lineIndex, column },
                });
            }
        }

        // Decide what an upcoming `{` will open, from this line's openers.
        if (atFileScope) {
            if (CBUFFER_RE.test(code)) pendingBlock = 'cbuffer';
            else if (STRUCT_RE.test(code)) pendingBlock = 'struct';
            else if (FUNCTION_RE.test(code)) {
                pendingBlock = 'func';
                const fn = FUNCTION_RE.exec(code);
                if (fn && !TYPE_KINDS[fn[1]]) {
                    functions.push(fn[1]);
                    functionDecls.push({ name: fn[1], position: { line: lineIndex, column: columnOf(raw, code, fn[1]) } });
                }
            }
        }

        // Walk the braces on the line, pushing and popping the block stack.
        for (const ch of code) {
            if (ch === '{') {
                stack.push(pendingBlock ?? 'block');
                pendingBlock = null;
            } else if (ch === '}') {
                stack.pop();
            }
        }
    }

    return { includes, constants, functions, functionDecls };
}

/** One parameter of a shader function, with its HLSL type and name. */
export interface ShaderParam {
    /** The parameter's HLSL type token, e.g. `float2`. */
    readonly type: string;
    /** The parameter name. */
    readonly name: string;
    /** True when the parameter declares a default value (`float limit = 1.0`), so a call may omit it. */
    readonly optional?: boolean;
}

/** A file-scope function's full signature: return type, name, and typed parameter list. */
export interface ShaderFunctionSignature {
    /** The function name. */
    readonly name: string;
    /** The declared return type token, e.g. `float4` or `void`. */
    readonly returnType: string;
    /** The parameters in order (empty for a `()` or `(void)` list). */
    readonly params: readonly ShaderParam[];
}

/** Control-flow keywords that read like `keyword (…) {` but are not function definitions. */
const CONTROL_KEYWORDS = new Set(['if', 'else', 'for', 'while', 'switch', 'case', 'default', 'do', 'return']);

/** Replaces every comment with spaces, preserving newlines and length so offsets are unaffected. */
const blankComments = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));

/** Matches a function definition `type name(params) [: SEMANTIC] {`, capturing type, name and params. */
const SIGNATURE_RE =
    /\b([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*\(([^{}();]*)\)\s*(?::\s*[A-Za-z_]\w*\s*)?\{/g;

/** Parses one parameter declaration (`in float2 uv : TEXCOORD0`) into its type and name, or null. */
const parseParam = (part: string): ShaderParam | null => {
    // Drop a trailing HLSL semantic (`: TEXCOORD0`) and any default value, then the leading qualifiers.
    const withoutSemantic = part.replace(/:\s*[A-Za-z_]\w*.*$/, '');
    // A default value (`float limit = 1.0`) makes the parameter omittable at the call site.
    const optional = withoutSemantic.includes('=');
    const cleaned = withoutSemantic.replace(/=.*$/, '').trim();
    const tokens = cleaned.split(/\s+/).filter((t) => t && !/^(?:in|out|inout|uniform|const)$/.test(t));
    if (tokens.length < 2) return null; // a bare `void` or a malformed entry contributes no parameter
    return { type: tokens[0], name: tokens[tokens.length - 1], ...(optional ? { optional } : {}) };
};

/**
 * Extracts the full signatures of the functions a shader defines at file scope (return type and typed
 * parameters), for signature help and argument-count validation. Only definitions with a `{` body at
 * brace depth 0 are collected, so a call, a control statement, or a nested local function-like construct
 * is never mistaken for one. Unlike {@link parseShader} this reads the whole source (not line by line)
 * so a signature whose parameter list spans several lines is captured.
 *
 * @param source the shader text, optionally already concatenated with its includes.
 * @returns the file-scope function signatures found, in source order.
 */
export const parseShaderSignatures = (source: string): ShaderFunctionSignature[] => {
    const clean = blankComments(source);
    const signatures: ShaderFunctionSignature[] = [];
    let depth = 0;
    let lastIndex = 0;
    SIGNATURE_RE.lastIndex = 0;
    for (let m = SIGNATURE_RE.exec(clean); m !== null; m = SIGNATURE_RE.exec(clean)) {
        // Track brace depth up to this match so only file-scope (depth 0) definitions are taken.
        for (let i = lastIndex; i < m.index; i++) {
            if (clean[i] === '{') depth++;
            else if (clean[i] === '}') depth--;
        }
        const returnType = m[1];
        const name = m[2];
        const openedAtFileScope = depth === 0;
        // Advance depth past this definition's own opening brace before the next iteration.
        for (let i = m.index; i < SIGNATURE_RE.lastIndex; i++) {
            if (clean[i] === '{') depth++;
            else if (clean[i] === '}') depth--;
        }
        lastIndex = SIGNATURE_RE.lastIndex;
        if (!openedAtFileScope) continue;
        if (CONTROL_KEYWORDS.has(returnType) || CONTROL_KEYWORDS.has(name) || TYPE_KINDS[name]) continue;
        signatures.push({ name, returnType, params: parseParamList(m[3]) });
    }
    return signatures;
};

/** Parses a comma-separated parameter list into typed parameters, dropping bare/malformed entries. */
const parseParamList = (raw: string): ShaderParam[] =>
    raw
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)
        .map(parseParam)
        .filter((p): p is ShaderParam => p !== null);

/** The index of the `}` matching the `{` at `open` in `text`, or -1 when it does not close. */
const matchingBrace = (text: string, open: number): number => {
    let depth = 0;
    for (let i = open; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}' && --depth === 0) return i;
    }
    return -1;
};

/** The parameters and body-so-far of the function enclosing a cursor offset. */
export interface FunctionScope {
    /** The enclosing function's parameters, in order. */
    readonly params: readonly ShaderParam[];
    /** The body text from the opening brace up to the cursor, for scanning locals already in scope. */
    readonly bodyBeforeOffset: string;
}

/**
 * The scope of the function whose body contains `offset` (its parameters and the body text written
 * before the cursor), or null when the cursor is not inside a function body. Used to offer the
 * parameters and locals in scope for completion. An unterminated body (mid-edit, no closing brace yet)
 * still resolves, so completion works while the function is being written.
 *
 * @param source the shader text being edited.
 * @param offset the cursor byte offset.
 * @returns the enclosing function's parameters and preceding body text, or null.
 */
export const functionScopeAt = (source: string, offset: number): FunctionScope | null => {
    const clean = blankComments(source);
    SIGNATURE_RE.lastIndex = 0;
    for (let m = SIGNATURE_RE.exec(clean); m !== null; m = SIGNATURE_RE.exec(clean)) {
        const returnType = m[1];
        const name = m[2];
        if (CONTROL_KEYWORDS.has(returnType) || CONTROL_KEYWORDS.has(name) || TYPE_KINDS[name]) continue;
        const bodyOpen = SIGNATURE_RE.lastIndex - 1; // the `{` this match ends on
        if (offset <= bodyOpen) continue; // the cursor is before this function's body
        const bodyClose = matchingBrace(clean, bodyOpen);
        if (bodyClose >= 0 && offset > bodyClose) continue; // the cursor is past this function
        const end = Math.min(offset, source.length);
        return { params: parseParamList(m[3]), bodyBeforeOffset: source.slice(bodyOpen, end) };
    }
    return null;
};
