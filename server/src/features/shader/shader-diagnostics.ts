import { existsSync } from 'fs';
import { Diagnostic, DiagnosticSeverity, Position, Range } from 'vscode-languageserver';
import * as l10n from '@vscode/l10n';
import { parseShader, parseShaderSignatures, ShaderFunctionSignature } from './shader-parser';
import { resolveInclude } from './shader-source';
import { readIncludeChain, ReadOverride, ENGINE_BOUND_NAMES } from './shader-index';
import { HLSL_INTRINSIC_NAMES, ENGINE_UNIFORMS, TEXTURE_METHODS } from './shader-intrinsics';
import { HLSL_TYPES, HLSL_KEYWORDS, lineStarts, positionOf } from '../semantic/shader-semantic-tokens';

/**
 * Conservative, opt-in diagnostics for a `.shader` file itself (not the `_`-constants a `.rules`
 * material sets, which {@link file://./../diagnostics/validator.shader-constants.ts} handles). It is a
 * lexical check, not an HLSL type-checker, and is built to stay false-positive-free:
 *
 * - an `#include` whose target does not exist is flagged (skipped for a root-anchored `./Data/…` include
 *   when the game path is unknown, since it cannot be resolved then),
 * - a `_`-prefixed uniform read that no file in the include chain declares and the engine does not bind
 *   is flagged as a probable typo,
 * - a call to a function that is neither an HLSL intrinsic, a builtin constructor, a `#define`d macro,
 *   nor a function the shader or its includes define is flagged.
 *
 * The last two run only when the whole include chain was readable — a missing include means the symbol
 * set is partial, so any "undeclared" verdict could be wrong and the check is skipped entirely.
 */

/** Recognizes a root-anchored (`./Data/…`) include, which needs the game data path to resolve. */
const ROOTED_RE = /^\.?[\\/]?[Dd]ata[\\/]/;

// One master tokenizer: block comment, line comment, string, preprocessor keyword, number, identifier.
// Matching (and discarding) comments and strings keeps the scan from reading a `_name` or call inside
// one. Mirrors the semantic-token scanner so both see the same tokens.
const TOKENS =
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:[^"\\]|\\.)*"|#[A-Za-z]+|\b\d+\.?\d*(?:[eE][+-]?\d+)?[fFhHuU]?\b|[A-Za-z_]\w*/g;

/** Preprocessor operators that read like a call but are not functions. */
const PREPROCESSOR_CALLS: ReadonlySet<string> = new Set(['defined']);

/** Collects every name captured by a global regex's first group over the text. */
const collectGroup = (text: string, re: RegExp): Set<string> => {
    const names = new Set<string>();
    for (let m = re.exec(text); m !== null; m = re.exec(text)) names.add(m[1]);
    return names;
};

/** The set of `_`-names that appear in a typed declaration anywhere in the scope (uniforms, locals, params). */
const declaredUnderscoreNames = (scope: string, structNames: ReadonlySet<string>): Set<string> => {
    const typeTokens = [...HLSL_TYPES, ...structNames].join('|');
    const re = new RegExp(`\\b(?:${typeTokens})\\b\\s+(_[A-Za-z0-9_]+)`, 'g');
    return collectGroup(scope, re);
};

/**
 * The offset just past a preprocessor directive that starts at `hashIndex`: the end of its line,
 * extended across `\` line continuations.
 */
const endOfDirective = (text: string, hashIndex: number): number => {
    let i = hashIndex;
    while (i < text.length) {
        const newline = text.indexOf('\n', i);
        if (newline < 0) return text.length;
        const lineEnd = text[newline - 1] === '\r' ? newline - 1 : newline;
        if (text[lineEnd - 1] === '\\') {
            i = newline + 1;
            continue;
        }
        return newline;
    }
    return text.length;
};

/** Whether the last non-whitespace character before `index` is `[` (an HLSL attribute context). */
const precededByBracket = (text: string, index: number): boolean => {
    let i = index - 1;
    while (i >= 0 && /\s/.test(text[i])) i--;
    return i >= 0 && text[i] === '[';
};

/** The index of the next non-whitespace character at or after `from`, or -1 when the rest is blank. */
const nextNonSpace = (text: string, from: number): number => {
    let i = from;
    while (i < text.length && /\s/.test(text[i])) i++;
    return i < text.length ? i : -1;
};

/**
 * Counts the arguments of a call whose `(` is at `openParen`, by scanning to the matching `)` and
 * counting the commas at the call's own paren depth. Returns null for an unterminated call (so an
 * incomplete line mid-edit is never validated).
 *
 * @param text the source being scanned.
 * @param openParen the index of the call's opening `(`.
 * @returns the argument count, or null when the parentheses do not close.
 */
const countArguments = (text: string, openParen: number): number | null => {
    let depth = 0;
    let commas = 0;
    let hasContent = false;
    for (let i = openParen; i < text.length; i++) {
        const c = text[i];
        if (c === '(') depth++;
        else if (c === ')') {
            depth--;
            if (depth === 0) return hasContent || commas > 0 ? commas + 1 : 0;
        } else if (c === ',' && depth === 1) commas++;
        else if (depth >= 1 && !/\s/.test(c)) hasContent = true;
    }
    return null;
};

/** The component count of a scalar/vector HLSL type (`float`→1, `float3`→3), or null for other types. */
const componentsOf = (type: string): number | null => {
    const match = /^(?:float|half|int|uint|bool|double)([2-4])?$/.exec(type);
    if (!match) return null;
    return match[1] ? Number(match[1]) : 1;
};

/**
 * Produces the in-shader diagnostics for a `.shader` file. Reads the include chain (open buffers
 * preferred) to learn the full symbol set before judging any name as undeclared.
 *
 * @param text the source of the shader being edited.
 * @param entryPath the absolute path of that shader.
 * @param dataDir the game `Data` directory, for root-anchored includes (empty when unknown).
 * @param readOverride prefers an open buffer's text over disk for an included file.
 * @returns the diagnostics, empty when nothing is wrong.
 */
export const validateShaderDocument = async (
    text: string,
    entryPath: string,
    dataDir: string,
    readOverride?: ReadOverride
): Promise<Diagnostic[]> => {
    const diagnostics: Diagnostic[] = [];
    const starts = lineStarts(text);
    const rangeAt = (offset: number, length: number): Range => {
        const from = positionOf(starts, offset);
        return Range.create(Position.create(from.line, from.char), Position.create(from.line, from.char + length));
    };

    // Unresolvable includes, judged only when the include can actually be resolved (a root-anchored
    // include with no game path is left alone). Reported per directive in this file, with its range.
    const includeScan = /#\s*include\s+"([^"]+)"/g;
    for (let m = includeScan.exec(text); m !== null; m = includeScan.exec(text)) {
        const includePath = m[1];
        if (ROOTED_RE.test(includePath) && !dataDir) continue; // cannot resolve without the game path
        const target = resolveInclude(entryPath, includePath, dataDir);
        const readable = readOverride?.(target) !== undefined || existsSync(target);
        if (readable) continue;
        const quoteStart = m.index + m[0].indexOf('"') + 1;
        diagnostics.push({
            message: l10n.t("Cannot resolve include '{0}'.", includePath),
            range: rangeAt(quoteStart, includePath.length),
            severity: DiagnosticSeverity.Warning,
            source: 'cosmoteer-shader',
        });
    }

    const chain = await readIncludeChain(text, entryPath, dataDir, readOverride).catch(() => ({ text: '', complete: false }));
    // A partial include chain means an unknown symbol might simply live in the file we could not read.
    // Skip the undeclared checks entirely rather than risk a false positive.
    if (!chain.complete) return diagnostics;

    const scope = chain.text ? `${text}\n${chain.text}` : text;
    const parsed = parseShader(scope);
    const structNames = collectGroup(scope, /\bstruct\s+(\w+)/g);
    const defines = collectGroup(scope, /#\s*define\s+(\w+)/g);

    // Function signatures for argument-count and return-type checks. A name defined more than once is
    // overloaded, so its calls cannot be argument-checked against a single arity — drop those.
    const signatureList = parseShaderSignatures(scope);
    const nameCounts = new Map<string, number>();
    for (const sig of signatureList) nameCounts.set(sig.name, (nameCounts.get(sig.name) ?? 0) + 1);
    const signatures = new Map<string, ShaderFunctionSignature>();
    for (const sig of signatureList) if (nameCounts.get(sig.name) === 1) signatures.set(sig.name, sig);

    const knownUniforms = new Set<string>([
        ...parsed.constants.map((c) => c.name),
        ...declaredUnderscoreNames(scope, structNames),
        ...Object.keys(ENGINE_UNIFORMS),
        ...ENGINE_BOUND_NAMES,
    ]);
    const knownFunctions = new Set<string>([
        ...parsed.functions,
        ...HLSL_INTRINSIC_NAMES,
        ...HLSL_TYPES,
        ...HLSL_KEYWORDS,
        ...Object.keys(TEXTURE_METHODS),
        ...structNames,
        ...defines,
        ...PREPROCESSOR_CALLS,
    ]);

    for (let m = TOKENS.exec(text); m !== null; m = TOKENS.exec(text)) {
        const token = m[0];
        const first = token[0];
        if (first === '/' || first === '"' || (first >= '0' && first <= '9')) continue;
        // The rest of a preprocessor directive line is directive syntax, not shader code: `#pragma
        // warning( disable : 3571 )` must not read as a call to `warning`, and a `#define` body is
        // only judged where it is expanded. Skips past line continuations (`\` at end of line).
        if (first === '#') {
            TOKENS.lastIndex = endOfDirective(text, m.index);
            continue;
        }
        // A member after a `.` (`_tex.Sample`) is resolved by its object, not a standalone symbol.
        if (m.index > 0 && text[m.index - 1] === '.') continue;
        // An HLSL attribute (`[maxvertexcount(4)]`, `[unroll]`) is compiler metadata, not a call.
        if (precededByBracket(text, m.index)) continue;

        const afterIndex = nextNonSpace(text, m.index + token.length);
        const isCall = afterIndex >= 0 && text[afterIndex] === '(';

        if (token.startsWith('_')) {
            if (!knownUniforms.has(token)) {
                diagnostics.push({
                    message: l10n.t("Unknown shader uniform '{0}'. Nothing in this shader or its includes declares it.", token),
                    range: rangeAt(m.index, token.length),
                    severity: DiagnosticSeverity.Warning,
                    source: 'cosmoteer-shader',
                });
            }
            continue;
        }
        if (isCall && !knownFunctions.has(token)) {
            diagnostics.push({
                message: l10n.t("Unknown function '{0}'. It is not an HLSL intrinsic and nothing in scope defines it.", token),
                range: rangeAt(m.index, token.length),
                severity: DiagnosticSeverity.Warning,
                source: 'cosmoteer-shader',
            });
            continue;
        }
        // A call to a function we have the signature of: check the argument count. Parameters with a
        // default value may be omitted, so any count between the required and full arity is fine.
        const signature = isCall ? signatures.get(token) : undefined;
        if (signature) {
            const argCount = countArguments(text, afterIndex);
            const required = signature.params.filter((param) => !param.optional).length;
            if (argCount !== null && (argCount < required || argCount > signature.params.length)) {
                diagnostics.push({
                    message: l10n.t(
                        "Function '{0}' expects {1} argument(s) but got {2}.",
                        token,
                        required === signature.params.length ? required : `${required}-${signature.params.length}`,
                        argCount
                    ),
                    range: rangeAt(m.index, token.length),
                    severity: DiagnosticSeverity.Warning,
                    source: 'cosmoteer-shader',
                });
            }
        }
    }

    validateDeclarations(text, signatures, rangeAt, diagnostics);
    return diagnostics;
};

/**
 * Checks variable declarations in the current file for two mistakes: a type used as an assignment target
 * with no variable name (`float = f();`), and a declaration whose initializer is a single call to a
 * function whose return type does not fit the declared type (`float x = loadRawNormals(2, 2);` where the
 * function returns `float4`, a narrowing HLSL truncation). Only the safe, unambiguous shape — a lone
 * call as the whole initializer, both types being scalar/vector — is judged, so nothing else is flagged.
 *
 * @param text the current file source.
 * @param signatures the file-and-include function signatures, keyed by name.
 * @param rangeAt builds a document range from an offset and length.
 * @param diagnostics the list to append to.
 */
const validateDeclarations = (
    text: string,
    signatures: ReadonlyMap<string, ShaderFunctionSignature>,
    rangeAt: (offset: number, length: number) => Range,
    diagnostics: Diagnostic[]
): void => {
    const typeTokens = [...HLSL_TYPES].join('|');

    // A type immediately followed by `=` is missing its variable name (`float = …`).
    const missingName = new RegExp(`(?:^|[;{}])\\s*(${typeTokens})\\b\\s*=`, 'g');
    for (let m = missingName.exec(text); m !== null; m = missingName.exec(text)) {
        const at = m.index + m[0].indexOf(m[1]);
        diagnostics.push({
            message: l10n.t("Expected a variable name after '{0}'.", m[1]),
            range: rangeAt(at, m[1].length),
            severity: DiagnosticSeverity.Warning,
            source: 'cosmoteer-shader',
        });
    }

    // A declaration whose initializer is exactly one function call: `TYPE name = fn(`.
    const declaration = new RegExp(`(?:^|[;{}])\\s*(${typeTokens})\\b\\s+[A-Za-z_]\\w*\\s*=\\s*([A-Za-z_]\\w*)\\s*\\(`, 'g');
    for (let m = declaration.exec(text); m !== null; m = declaration.exec(text)) {
        const signature = signatures.get(m[2]);
        if (!signature) continue;
        const openParen = m.index + m[0].length - 1;
        // Only judge when the call is the entire right-hand side (nothing but `;` after its `)`).
        const closeParen = matchingParen(text, openParen);
        if (closeParen < 0) continue;
        const tail = nextNonSpace(text, closeParen + 1);
        if (tail < 0 || text[tail] !== ';') continue;
        const target = componentsOf(m[1]);
        const source = componentsOf(signature.returnType);
        if (target === null || source === null || target === source) continue;
        // A scalar initializer splats into a vector, which HLSL allows; anything else that changes the
        // component count (a truncation, or a widening of a vector) is the mistake worth flagging.
        if (source === 1 && target > 1) continue;
        const callName = m.index + m[0].lastIndexOf(m[2]);
        diagnostics.push({
            message: l10n.t("Cannot assign '{0}' (returned by '{1}') to '{2}'.", signature.returnType, m[2], m[1]),
            range: rangeAt(callName, m[2].length),
            severity: DiagnosticSeverity.Warning,
            source: 'cosmoteer-shader',
        });
    }
};

/** The index of the `)` matching the `(` at `openParen`, or -1 when it does not close. */
const matchingParen = (text: string, openParen: number): number => {
    let depth = 0;
    for (let i = openParen; i < text.length; i++) {
        if (text[i] === '(') depth++;
        else if (text[i] === ')' && --depth === 0) return i;
    }
    return -1;
};
