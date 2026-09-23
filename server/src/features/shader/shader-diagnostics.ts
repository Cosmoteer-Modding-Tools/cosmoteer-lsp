import { existsSync } from 'fs';
import { readdir } from 'fs/promises';
import { basename, dirname, join, relative } from 'path';
import { Diagnostic, DiagnosticSeverity, Position, Range } from 'vscode-languageserver';
import * as l10n from '@vscode/l10n';
import { parseShader, parseShaderSignatures, parseShaderTypes } from './shader-parser';
import { ParsedShader, ShaderFunctionSignature } from './shader-parser.types';
import { GAME_ANCHORED_INCLUDE_RE, resolveInclude } from './shader-source';
import { readIncludeChain, ReadOverride, ENGINE_BOUND_NAMES } from './shader-index';
import { HLSL_INTRINSICS, HLSL_INTRINSIC_NAMES, ENGINE_UNIFORMS, TEXTURE_METHODS } from './shader-intrinsics';
import { HLSL_TYPES, HLSL_KEYWORDS, lineStarts, positionOf } from '../semantic/shader-semantic-tokens';
import { closestMatch } from '../../utils/did-you-mean';
import type { ValidationErrorData } from '../diagnostics/validator';

/**
 * Conservative diagnostics for a `.shader` file itself, on by default (not the `_`-constants a `.rules`
 * material sets, which {@link file://./../diagnostics/validator.shader-constants.ts} handles). It is a
 * lexical check, not an HLSL type-checker, and is built to stay false-positive-free:
 *
 * - an `#include` whose target does not exist is flagged (skipped for a game-anchored `./Data/…` include
 *   when the game path is unknown, since it cannot be resolved then),
 * - a `_`-prefixed uniform read that no file in the include chain declares and the engine does not bind
 *   is flagged as a probable typo,
 * - a call to a function that is neither an HLSL intrinsic, a builtin constructor, a `#define`d macro,
 *   nor a function the shader or its includes define is flagged,
 * - a call whose argument count does not fit the one signature the name has, or the fixed shape of the
 *   HLSL intrinsic it names, is flagged.
 *
 * The last two run only when the whole include chain was readable. A missing include means the symbol
 * set is partial, so any "undeclared" verdict could be wrong and the check is skipped entirely.
 */

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
 * Stamps the shader findings with the rule id the table advertises for them. The rules passes are
 * tagged by their caller, which returns this check's findings untouched, so they carried no id at
 * all and any report grouped them under the untagged bucket.
 *
 * @param diagnostics the findings to stamp.
 * @returns the same findings.
 */
const withRuleId = (diagnostics: Diagnostic[]): Diagnostic[] => {
    for (const diagnostic of diagnostics) diagnostic.code = 'validateShaderCode';
    return diagnostics;
};

/**
 * Produces the in-shader diagnostics for a `.shader` file. Reads the include chain (open buffers
 * preferred) to learn the full symbol set before judging any name as undeclared.
 *
 * @param text the source of the shader being edited.
 * @param entryPath the absolute path of that shader.
 * @param dataDir the game `Data` directory, for game-anchored includes (empty when unknown).
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

    await reportUnresolvedIncludes(text, entryPath, dataDir, rangeAt, diagnostics, readOverride);

    const chain = await readIncludeChain(text, entryPath, dataDir, readOverride).catch(() => ({
        text: '',
        complete: false,
    }));
    // A partial include chain means an unknown symbol might simply live in the file we could not read.
    // Skip the undeclared checks entirely rather than risk a false positive.
    if (!chain.complete) return withRuleId(diagnostics);

    const scope = chain.text ? `${text}\n${chain.text}` : text;
    const parsed = parseShader(scope);
    const declared = parseShaderTypes(scope);
    const structNames = new Set<string>([
        ...declared.structs.map((s) => s.name),
        ...declared.typeAliases.map((a) => a.name),
    ]);
    const defines = collectGroup(scope, /#\s*define\s+(\w+)/g);

    // Function signatures for argument-count and return-type checks. A name defined more than once is
    // overloaded, so its calls cannot be argument-checked against a single arity. Drop those.
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

    checkTokenUses(
        text,
        knownUniforms,
        knownFunctions,
        signatures,
        intrinsicArity(parsed, nameCounts, defines, structNames),
        rangeAt,
        diagnostics
    );
    validateDeclarations(text, signatures, rangeAt, diagnostics);
    return withRuleId(diagnostics);
};

/**
 * Reports every `#include` in the file whose target cannot be read. An include is judged only when it
 * can actually be resolved, so a game-anchored (`./Data/…`) path with no known game directory is left
 * alone rather than guessed at.
 *
 * @param text the source of the shader being edited.
 * @param entryPath the absolute path of that shader.
 * @param dataDir the game `Data` directory (empty when unknown).
 * @param rangeAt builds a document range from an offset and length.
 * @param diagnostics the list to append to.
 * @param readOverride prefers an open buffer's text over disk for an included file.
 */
const reportUnresolvedIncludes = async (
    text: string,
    entryPath: string,
    dataDir: string,
    rangeAt: (offset: number, length: number) => Range,
    diagnostics: Diagnostic[],
    readOverride?: ReadOverride
): Promise<void> => {
    const includeScan = /#\s*include\s+"([^"]+)"/g;
    for (let m = includeScan.exec(text); m !== null; m = includeScan.exec(text)) {
        const includePath = m[1];
        // A game-anchored (`./…`) include cannot be resolved without the game path.
        if (GAME_ANCHORED_INCLUDE_RE.test(includePath) && !dataDir) continue;
        const target = resolveInclude(entryPath, includePath, dataDir);
        const readable = readOverride?.(target) !== undefined || existsSync(target);
        if (readable) continue;
        const quoteStart = m.index + m[0].indexOf('"') + 1;
        const suggestion = await includeSuggestion(entryPath, includePath, dataDir);
        diagnostics.push({
            message: l10n.t("Cannot resolve include '{0}'.", includePath),
            range: rangeAt(quoteStart, includePath.length),
            severity: DiagnosticSeverity.Warning,
            source: 'cosmoteer-shader',
            ...didYouMeanData(suggestion),
        });
    }
};

/** The did-you-mean quick fix a finding carries, or nothing when no close candidate was found. */
const didYouMeanData = (suggestion: string | null): { data?: ValidationErrorData } =>
    suggestion ? { data: { quickFix: { title: l10n.t("Change to '{0}'", suggestion), newText: suggestion } } } : {};

/** Cache of shader file paths by lowercased file name, keyed by the root that was walked. */
const shaderTreeCache = new Map<string, Map<string, string[]>>();

/**
 * Every `.shader` file under a directory tree, grouped by lowercased file name. The result is cached
 * per root, since it is only ever built to answer an unresolved include.
 *
 * @param root the directory to walk.
 * @returns the absolute paths of the shaders found, keyed by lowercased file name.
 */
const shaderTreeIndex = async (root: string): Promise<ReadonlyMap<string, string[]>> => {
    const cached = shaderTreeCache.get(root);
    if (cached) return cached;
    const byName = new Map<string, string[]>();
    const walk = async (dir: string): Promise<void> => {
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) await walk(full);
            else if (entry.name.toLowerCase().endsWith('.shader')) {
                const key = entry.name.toLowerCase();
                byName.set(key, [...(byName.get(key) ?? []), full]);
            }
        }
    };
    await walk(root);
    shaderTreeCache.set(root, byName);
    return byName;
};

/** The mod folder a file belongs to (the nearest ancestor holding a `mod.rules`), or null. */
const modRootOf = (from: string): string | null => {
    let dir = from;
    for (let depth = 0; depth < 12; depth++) {
        if (existsSync(join(dir, 'mod.rules'))) return dir;
        const parent = dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
    return null;
};

/**
 * A path that would make an unresolvable `#include` resolve: the one file of that name inside the
 * mod, written relative to the including file, else the one file of that name in the game data tree,
 * written in the game-anchored `./Data/…` form the engine needs for that. The mod's own copy wins, so
 * the fix never quietly repoints a mod at the vanilla file. Nothing is offered when the name is
 * ambiguous, since picking one of several files is the author's choice.
 *
 * @param entryPath the absolute path of the shader holding the include.
 * @param includePath the path as written in the directive.
 * @param dataDir the game `Data` directory (empty when unknown).
 * @returns the path to write instead, or null when there is no single obvious candidate.
 */
const includeSuggestion = async (entryPath: string, includePath: string, dataDir: string): Promise<string | null> => {
    const wanted = basename(includePath).toLowerCase();
    if (!wanted.endsWith('.shader')) return null;
    const fromDir = dirname(entryPath);

    const modRoot = modRootOf(fromDir);
    if (modRoot) {
        const local = (await shaderTreeIndex(modRoot)).get(wanted) ?? [];
        // A file-relative include must not carry a `./` prefix, which anchors it at the game folder.
        if (local.length === 1 && local[0] !== entryPath) {
            const written = relative(fromDir, local[0]).split('\\').join('/');
            if (written && written !== includePath) return written;
        }
    }

    if (!dataDir) return null;
    const vanilla = (await shaderTreeIndex(dataDir)).get(wanted) ?? [];
    if (vanilla.length !== 1) return null;
    const written = `./Data/${relative(dataDir, vanilla[0]).split('\\').join('/')}`;
    return written === includePath ? null : written;
};

/**
 * The argument count each documented HLSL intrinsic takes, for the intrinsics this shader can be
 * judged against. An intrinsic whose name the shader or one of its includes also declares is left
 * out, so a shader that defines its own `lerp` overloads is checked against its own definitions and
 * never against the table. The genuinely multi-form intrinsics are left out by the table itself.
 *
 * @param parsed the scanner's view of the shader plus its includes.
 * @param nameCounts how often each name is defined as a function in scope, overloads included.
 * @param defines the macro names in scope, any of which can stand in for a call.
 * @param structNames the struct and alias type names in scope.
 * @returns the fixed arity of every intrinsic the shader does not shadow, keyed by name.
 */
const intrinsicArity = (
    parsed: ParsedShader,
    nameCounts: ReadonlyMap<string, number>,
    defines: ReadonlySet<string>,
    structNames: ReadonlySet<string>
): ReadonlyMap<string, number> => {
    const shadowed = new Set<string>([...parsed.functions, ...nameCounts.keys(), ...defines, ...structNames]);
    const arity = new Map<string, number>();
    for (const [name, intrinsic] of Object.entries(HLSL_INTRINSICS)) {
        if (intrinsic.multiForm || shadowed.has(name)) continue;
        arity.set(name, intrinsic.params.length);
    }
    return arity;
};

/**
 * Scans the current file token by token and judges each name against the symbol set the whole include
 * chain declares: a `_`-prefixed read nothing declares, a call to a function nothing defines, and a
 * call whose argument count does not fit the one signature that name has or the fixed arity of the
 * HLSL intrinsic it names.
 *
 * @param text the current file source.
 * @param knownUniforms every `_`-name in scope, declared or engine-bound.
 * @param knownFunctions every callable name in scope, including types, keywords and macros.
 * @param signatures the file-and-include function signatures, keyed by name.
 * @param intrinsics the fixed argument count of every intrinsic this shader does not shadow.
 * @param rangeAt builds a document range from an offset and length.
 * @param diagnostics the list to append to.
 */
const checkTokenUses = (
    text: string,
    knownUniforms: ReadonlySet<string>,
    knownFunctions: ReadonlySet<string>,
    signatures: ReadonlyMap<string, ShaderFunctionSignature>,
    intrinsics: ReadonlyMap<string, number>,
    rangeAt: (offset: number, length: number) => Range,
    diagnostics: Diagnostic[]
): void => {
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
                    message: l10n.t(
                        "Unknown shader uniform '{0}'. Nothing in this shader or its includes declares it.",
                        token
                    ),
                    range: rangeAt(m.index, token.length),
                    severity: DiagnosticSeverity.Warning,
                    source: 'cosmoteer-shader',
                    ...didYouMeanData(closestMatch(token, knownUniforms)),
                });
            }
            continue;
        }
        if (isCall && !knownFunctions.has(token)) {
            diagnostics.push({
                message: l10n.t(
                    "Unknown function '{0}'. It is not an HLSL intrinsic and nothing in scope defines it.",
                    token
                ),
                range: rangeAt(m.index, token.length),
                severity: DiagnosticSeverity.Warning,
                source: 'cosmoteer-shader',
                ...didYouMeanData(closestMatch(token, knownFunctions)),
            });
            continue;
        }
        // A call to an HLSL intrinsic of one fixed shape: the compiler rejects any other count.
        const fixedArity = isCall && !signatures.has(token) ? intrinsics.get(token) : undefined;
        if (fixedArity !== undefined) {
            const argCount = countArguments(text, afterIndex);
            if (argCount !== null && argCount !== fixedArity) {
                diagnostics.push({
                    message: l10n.t("Function '{0}' expects {1} argument(s) but got {2}.", token, fixedArity, argCount),
                    range: rangeAt(m.index, token.length),
                    severity: DiagnosticSeverity.Warning,
                    source: 'cosmoteer-shader',
                });
            }
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
};

/**
 * Checks variable declarations in the current file for two mistakes: a type used as an assignment target
 * with no variable name (`float = f();`), and a declaration whose initializer is a single call to a
 * function whose return type does not fit the declared type (`float x = loadRawNormals(2, 2);` where the
 * function returns `float4`, a narrowing HLSL truncation). Only the safe, unambiguous shape (a lone
 * call as the whole initializer, both types being scalar/vector) is judged, so nothing else is flagged.
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
    const declaration = new RegExp(
        `(?:^|[;{}])\\s*(${typeTokens})\\b\\s+[A-Za-z_]\\w*\\s*=\\s*([A-Za-z_]\\w*)\\s*\\(`,
        'g'
    );
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
