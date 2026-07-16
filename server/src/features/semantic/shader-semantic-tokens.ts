import { SemanticTokens, SemanticTokensBuilder } from 'vscode-languageserver';
import { TokenType, typeIndex } from './legend';

/**
 * Semantic-token highlighting for `.shader` files (HLSL with Cosmoteer's small preprocessor).
 *
 * The TextMate grammar (`syntaxes/shader.tmLanguage.json`) is the synchronous base layer that colours
 * comments, strings, and structure. These tokens are the overlay that paints the things a static
 * grammar can't tell apart: a `_uniform` (the constants a `.rules` material sets) versus an ordinary
 * local, an HLSL builtin type, a control keyword, an entry-point function, and a preprocessor
 * directive, coloured uniformly across every occurrence. Drives VS Code and the native IntelliJ LSP.
 */

/** HLSL builtin types Cosmoteer shaders use, coloured as `type`. */
export const HLSL_TYPES = new Set([
    'void',
    'bool',
    'int',
    'uint',
    'half',
    'float',
    'double',
    'float2',
    'float3',
    'float4',
    'float2x2',
    'float3x3',
    'float4x4',
    'half2',
    'half3',
    'half4',
    'int2',
    'int3',
    'int4',
    'uint2',
    'uint3',
    'uint4',
    'bool2',
    'bool3',
    'bool4',
    'matrix',
    'vector',
    'Texture2D',
    'Texture3D',
    'TextureCube',
    'Texture2DArray',
    'SamplerState',
    'SamplerComparisonState',
    'cbuffer',
    'struct',
]);

/** HLSL keywords/qualifiers/control flow, coloured as `keyword`. */
export const HLSL_KEYWORDS = new Set([
    'return',
    'if',
    'else',
    'for',
    'while',
    'do',
    'switch',
    'case',
    'default',
    'break',
    'continue',
    'discard',
    'in',
    'out',
    'inout',
    'static',
    'const',
    'uniform',
    'register',
    'packoffset',
    'true',
    'false',
    'typedef',
    'namespace',
]);

/** A token captured before delta-encoding so the full set can be position-sorted first. */
interface RawToken {
    readonly line: number;
    readonly char: number;
    readonly length: number;
    readonly type: number;
    readonly modifiers: number;
}

// One master tokenizer regex: block comment, line comment, string, preprocessor directive, number,
// identifier. Matching comments and strings (and discarding them) keeps the scanner from colouring a
// keyword or `_name` that lives inside one. `g` + `lastIndex` walks the whole source in order.
const SCANNER =
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:[^"\\]|\\.)*"|#[A-Za-z]+|\b\d+\.?\d*(?:[eE][+-]?\d+)?[fFhHuU]?\b|[A-Za-z_]\w*/g;

/** A simple cursor → (line, character) mapping built once from the source's newline offsets. */
export const lineStarts = (source: string): number[] => {
    const starts = [0];
    for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1);
    return starts;
};

/** Binary-search the line index for a byte offset, then derive its column from the line's start. */
export const positionOf = (starts: number[], offset: number): { line: number; char: number } => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= offset) lo = mid;
        else hi = mid - 1;
    }
    return { line: lo, char: offset - starts[lo] };
};

/**
 * Classifies a bare identifier match into a token type, or null to leave it to the grammar.
 *
 * @param word the identifier text.
 * @param followedByParen whether a `(` follows it (a function call/definition).
 */
const classifyIdentifier = (word: string, followedByParen: boolean): TokenType | null => {
    if (HLSL_TYPES.has(word)) return 'type';
    if (HLSL_KEYWORDS.has(word)) return 'keyword';
    // A leading underscore is Cosmoteer's convention for a settable uniform. The whole point of the
    // overlay is to colour these the same wherever they appear (declaration and every use).
    if (word.startsWith('_')) return 'variable';
    if (followedByParen) return 'function';
    return null;
};

/**
 * Produces the semantic tokens for a shader's source text.
 *
 * @param source the full `.shader` text.
 * @returns the delta-encoded tokens for `textDocument/semanticTokens/full`.
 */
export const buildShaderSemanticTokens = (source: string): SemanticTokens => {
    const starts = lineStarts(source);
    const tokens: RawToken[] = [];

    for (let match = SCANNER.exec(source); match !== null; match = SCANNER.exec(source)) {
        const text = match[0];
        const first = text[0];
        // Comments and strings are dropped (the grammar colours them; matching here only excludes
        // their contents from identifier classification).
        if (first === '/' || first === '"') continue;

        let type: TokenType | null;
        if (first === '#') {
            type = 'macro';
        } else if (first >= '0' && first <= '9') {
            type = 'number';
        } else {
            const after = source[match.index + text.length];
            type = classifyIdentifier(text, after === '(');
        }
        if (!type) continue;

        const { line, char } = positionOf(starts, match.index);
        tokens.push({ line, char, length: text.length, type: typeIndex(type), modifiers: 0 });
    }

    const builder = new SemanticTokensBuilder();
    for (const token of tokens) builder.push(token.line, token.char, token.length, token.type, token.modifiers);
    return builder.build();
};
