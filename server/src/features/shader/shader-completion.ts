import { readdir } from 'fs/promises';
import { basename, dirname, resolve as resolvePath } from 'path';
import { CompletionItem, CompletionItemKind } from 'vscode-languageserver';
import { ENGINE_UNIFORMS, HLSL_INTRINSICS, TEXTURE_METHODS } from './shader-intrinsics';
import { HLSL_KEYWORDS, HLSL_TYPES } from '../semantic/shader-semantic-tokens';
import { functionScopeAt, parseShader } from './shader-parser';

/**
 * Completion for an open `.shader` file. Two modes:
 *
 *  - After a `.` (member access, `color.` / `input.` / `_noiseTex.`) it is context-aware: it offers the
 *    swizzles of a vector, the members of a struct, or the sampling methods of a texture, resolved from
 *    the base expression's type, nothing else, so the list is exactly what can follow the dot.
 *  - Otherwise it offers the HLSL builtins (types, keywords, intrinsic functions) plus the symbols the
 *    file and its includes declare (their `_`-uniforms, functions, and struct types).
 *
 * The client filters the returned set against the word being typed, so the whole set for the mode is
 * returned every time.
 *
 * @param text the full source of the file being edited.
 * @param offset the cursor byte offset, used to detect a member-access context in `text`.
 * @param includeText the concatenated text of the file's `#include` chain, so symbols declared in a
 * base shader (uniforms, structs, functions) resolve too. Empty when the file has no includes.
 * @returns the completion items for the context.
 */
export const shaderCompletions = (text: string, offset: number, includeText = ''): CompletionItem[] => {
    // File-scope symbols (uniforms, functions, structs) can come from an include, so look them up over
    // the widened scope. Member-access detection and local declarations stay on the edited file, where
    // the cursor offset and the enclosing function's locals actually live.
    const scope = includeText ? `${text}\n${includeText}` : text;
    // A preprocessor line gets directive/macro completion instead of HLSL symbols.
    const directive = directiveContext(text, offset);
    if (directive === 'directive') return DIRECTIVE_ITEMS;
    if (directive === 'macro' || directive === 'define' || directive === 'condition') {
        return macroCompletions(scope, directive);
    }
    if (directive === 'other') return [];
    const member = memberAccess(text, offset);
    if (member !== null) return memberCompletions(scope, text, member);
    // After a type at the start of a declaration (`float x`, `in float2 uv`) the identifier being typed
    // is a new variable name the user is inventing, so offering existing names would be noise.
    if (isDeclarationNameContext(text, offset, scope)) return [];
    return globalCompletions(scope, localSymbols(scope, text, offset));
};

/** The preprocessor directives the game's shader loader understands, with what each does. */
const DIRECTIVES: ReadonlyArray<readonly [string, string]> = [
    ['include', 'Inline another shader file: `#include "../base.shader"` or `#include "./Data/base.shader"`.'],
    ['define', 'Define a macro. Feature guards (`USE_DEFAULT_PIX`, `ENABLE_…`) are defined before the include that tests them.'],
    ['undef', 'Remove a macro definition.'],
    ['if', 'Conditional compilation on an expression, e.g. `#if defined(GTE_PS_4_0) || defined(GTE_VS_4_0)`.'],
    ['ifdef', 'Compile the block only when the macro is defined.'],
    ['ifndef', 'Compile the block only when the macro is NOT defined.'],
    ['elif', 'Else-if branch of an `#if`/`#ifdef` chain.'],
    ['else', 'Else branch of an `#if`/`#ifdef` chain.'],
    ['endif', 'Close an `#if`/`#ifdef` block.'],
    ['pragma', 'Compiler control, e.g. `#pragma warning( disable : 3571 )`.'],
];

const DIRECTIVE_ITEMS: CompletionItem[] = DIRECTIVES.map(([name, doc]) => ({
    label: name,
    kind: CompletionItemKind.Keyword,
    detail: `#${name}`,
    documentation: doc,
}));

/**
 * The feature-level macros the engine defines when compiling (`D3D11Shader.GetShaderMacros`): per
 * stage the exact profile macro plus the cumulative `GTE_…`/`LTE_…` range gates. On a modern GPU the
 * pixel stage sees `PS_5_0` and every `GTE_PS_…`; vanilla shaders switch their rich paths on these.
 */
export const ENGINE_MACROS: ReadonlyArray<readonly [string, string]> = (() => {
    const stages: ReadonlyArray<readonly [string, string]> = [
        ['VS', 'vertex'],
        ['PS', 'pixel'],
        ['GS', 'geometry'],
    ];
    const levels = ['4_0_level_9_1', '4_0_level_9_3', '4_0', '4_1', '5_0'];
    const macros: Array<readonly [string, string]> = [];
    for (const [prefix, stage] of stages) {
        for (const level of levels) {
            const pretty = level.replace(/_/g, '.').replace('.level.', ' level ');
            macros.push([`${prefix}_${level}`, `Engine macro: the ${stage} stage compiles exactly at shader model ${pretty}.`]);
            macros.push([`GTE_${prefix}_${level}`, `Engine macro: the ${stage} stage compiles at shader model ${pretty} or above.`]);
            macros.push([`LTE_${prefix}_${level}`, `Engine macro: the ${stage} stage compiles at shader model ${pretty} or below.`]);
        }
    }
    return macros;
})();

/** The directive completion context at the cursor, or null when the line is not a preprocessor line. */
const directiveContext = (
    text: string,
    offset: number
): 'directive' | 'macro' | 'define' | 'condition' | 'other' | null => {
    const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
    const prefix = text.slice(lineStart, offset);
    if (!/^\s*#/.test(prefix)) return null;
    if (/^\s*#\s*\w*$/.test(prefix)) return 'directive';
    // The macro-name position of the macro-taking directives, including `defined(NAME` inside an
    // `#if`/`#elif` expression.
    if (/^\s*#\s*(?:ifdef|ifndef|undef)\s+\w*$/.test(prefix)) return 'macro';
    if (/^\s*#\s*(?:if|elif)\b.*\bdefined\s*\(?\s*\w*$/.test(prefix)) return 'macro';
    if (/^\s*#\s*define\s+\w*$/.test(prefix)) return 'define';
    // Elsewhere in an `#if`/`#elif` expression macros are still what gets referenced.
    if (/^\s*#\s*(?:if|elif)\b/.test(prefix)) return 'condition';
    return 'other';
};

/**
 * Macro-name completion for `#ifdef`/`#ifndef`/`#undef`/`defined(…)`, `#define`, and `#if`
 * expressions: the macros the file and its include chain `#define`, the guards those files TEST
 * (`#ifdef ENABLE_STENCIL` in `base_atlas.shader` is exactly what a including shader defines first),
 * and the engine's feature-level macros. A `#define` position skips the engine macros (the engine
 * defines those itself) and an `#if` expression additionally offers `defined`.
 */
const macroCompletions = (scope: string, kind: 'macro' | 'define' | 'condition'): CompletionItem[] => {
    const items: CompletionItem[] = [];
    const seen = new Set<string>();
    const add = (label: string, detail: string, documentation?: string): void => {
        if (seen.has(label)) return;
        seen.add(label);
        items.push({ label, kind: CompletionItemKind.Constant, detail, documentation });
    };

    if (kind === 'condition') {
        items.push({
            label: 'defined',
            kind: CompletionItemKind.Function,
            detail: 'defined(MACRO)',
            documentation: 'True when the macro is defined, usable inside `#if`/`#elif` expressions.',
        });
    }
    for (const m of scope.matchAll(/^\s*#\s*define\s+([A-Za-z_]\w*)/gm)) {
        add(m[1], 'macro (defined in this shader or an include)');
    }
    for (const m of scope.matchAll(/#\s*(?:ifdef|ifndef)\s+([A-Za-z_]\w*)|\bdefined\s*\(\s*([A-Za-z_]\w*)\s*\)/g)) {
        add(m[1] ?? m[2], 'guard (tested in this shader or an include)');
    }
    if (kind !== 'define') {
        for (const [name, doc] of ENGINE_MACROS) add(name, 'engine feature-level macro', doc);
    }
    return items;
};

/**
 * Path completion inside an `#include "…"` string: the sibling directories and `.shader` files of the
 * directory the typed prefix resolves to. Both include forms work: a path relative to the edited
 * file and the root-anchored `./Data/…` form resolved against the game data directory.
 *
 * @param typedPath the part of the include path already written (may be empty or end mid-segment).
 * @param documentPath the absolute path of the `.shader` being edited.
 * @param dataDir the game `Data` directory, for root-anchored includes.
 * @returns folder and `.shader` file completions for the path's directory, empty when unresolvable.
 */
export const shaderIncludePathCompletions = async (
    typedPath: string,
    documentPath: string,
    dataDir?: string
): Promise<CompletionItem[]> => {
    // Complete within the directory part; the segment being typed is the client-side filter word.
    const lastSlash = Math.max(typedPath.lastIndexOf('/'), typedPath.lastIndexOf('\\'));
    const dirPart = lastSlash >= 0 ? typedPath.slice(0, lastSlash + 1) : '';
    const rooted = /^\.?[\\/]?[Dd]ata[\\/]/.exec(dirPart);
    const baseDir = rooted && dataDir ? resolvePath(dataDir, dirPart.slice(rooted[0].length)) : resolvePath(dirname(documentPath), dirPart);
    let entries;
    try {
        entries = await readdir(baseDir, { withFileTypes: true });
    } catch {
        return [];
    }
    const items: CompletionItem[] = [];
    for (const entry of entries) {
        if (entry.isDirectory()) {
            items.push({ label: entry.name, kind: CompletionItemKind.Folder, detail: 'folder', insertText: `${entry.name}/` });
        } else if (entry.name.toLowerCase().endsWith('.shader') && entry.name !== basename(documentPath)) {
            items.push({ label: entry.name, kind: CompletionItemKind.File, detail: 'shader file' });
        }
    }
    return items;
};

/** A parameter or local variable in scope at the cursor, with its type and whether it is a parameter. */
interface LocalSymbol {
    readonly name: string;
    readonly type: string;
    readonly parameter: boolean;
}

/**
 * The parameters and locals of the function enclosing the cursor, so completion offers `input`, `uv`,
 * and other in-scope names, not only file globals. Parameters come from the enclosing signature.
 * Locals are the typed declarations written in the body before the cursor. Returns an empty list when
 * the cursor is not inside a function body.
 *
 * @param scope the file plus its includes, for the struct type names a local may be declared with.
 * @param currentText the edited file, whose function bodies hold the locals.
 * @param offset the cursor byte offset.
 */
const localSymbols = (scope: string, currentText: string, offset: number): LocalSymbol[] => {
    const fnScope = functionScopeAt(currentText, offset);
    if (!fnScope) return [];
    const symbols: LocalSymbol[] = fnScope.params.map((p) => ({ name: p.name, type: p.type, parameter: true }));

    // Locals declared in the body so far: an optional qualifier, a known type (or a struct type from
    // scope), then the variable name (not a function, so not immediately followed by `(`).
    const structNames: string[] = [];
    const structRe = /\bstruct\s+(\w+)/g;
    for (let m = structRe.exec(scope); m !== null; m = structRe.exec(scope)) structNames.push(m[1]);
    const types = [...HLSL_TYPES, ...structNames].join('|');
    const declaration = new RegExp(
        `(?:^|[;{(,]|\\bin\\b|\\bout\\b|\\binout\\b|\\bconst\\b|\\bstatic\\b)\\s*(${types})\\b\\s+([A-Za-z_]\\w*)\\b(?!\\s*\\()`,
        'g'
    );
    for (let m = declaration.exec(fnScope.bodyBeforeOffset); m !== null; m = declaration.exec(fnScope.bodyBeforeOffset)) {
        symbols.push({ name: m[2], type: m[1], parameter: false });
    }
    return symbols;
};

/**
 * Whether the cursor is typing the *name* of a new variable in a declaration: a type token sits at a
 * statement or parameter-list start immediately before the word being typed (`float x`, `(float2 uv`,
 * `, float3 n`). In that position the user is naming a declaration, not referencing a symbol, so
 * completion should stay quiet. An initializer position (`… = float…`) is not a declaration name and is
 * excluded, so type/constructor completion on the right of an `=` still works.
 *
 * @param text the edited file.
 * @param offset the cursor byte offset.
 * @param scope the file plus its includes, for the struct type names a declaration may use.
 */
const isDeclarationNameContext = (text: string, offset: number, scope: string): boolean => {
    const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
    const prefix = text.slice(lineStart, offset);
    const structNames: string[] = [];
    const structRe = /\bstruct\s+(\w+)/g;
    for (let m = structRe.exec(scope); m !== null; m = structRe.exec(scope)) structNames.push(m[1]);
    const types = [...HLSL_TYPES, ...structNames].join('|');
    return new RegExp(`(?:^|[;{(,])\\s*(?:${types})\\b\\s+\\w*$`).test(prefix);
};

/** The HLSL builtins, the file's own uniforms and functions, plus the in-scope locals, for a non-member context. */
const globalCompletions = (text: string, locals: readonly LocalSymbol[] = []): CompletionItem[] => {
    const items: CompletionItem[] = [];
    const seen = new Set<string>();
    const add = (label: string, kind: CompletionItemKind, detail: string, documentation?: string): void => {
        if (seen.has(label)) return;
        seen.add(label);
        items.push({ label, kind, detail, documentation });
    };

    // In-scope parameters and locals first, so they rank above the builtins the client sorts after them.
    for (const local of locals) {
        add(local.name, CompletionItemKind.Variable, `${local.type} (${local.parameter ? 'parameter' : 'local'})`);
    }

    for (const [name, intrinsic] of Object.entries(HLSL_INTRINSICS)) {
        add(name, CompletionItemKind.Function, `${name}(${intrinsic.params.join(', ')})`, intrinsic.doc);
    }
    for (const type of HLSL_TYPES) add(type, CompletionItemKind.Struct, 'HLSL type');
    for (const keyword of HLSL_KEYWORDS) add(keyword, CompletionItemKind.Keyword, 'HLSL keyword');

    const shader = parseShader(text);
    for (const constant of shader.constants) add(constant.name, CompletionItemKind.Variable, `${constant.hlslType} (uniform)`);
    for (const fn of shader.functions) add(fn, CompletionItemKind.Function, 'shader function');
    // Engine-provided uniforms (`_texture`, `_time`, …) live in an include, so the file scan above
    // misses them. Offer them here so they still autocomplete. Added last so a file redeclaration wins.
    for (const [name, info] of Object.entries(ENGINE_UNIFORMS)) {
        add(name, CompletionItemKind.Variable, `${info.type} (engine uniform)`, info.doc);
    }
    return items;
};

/** The base identifier of a `base.` member access at `offset`, or null when the cursor is not after a `.`. */
const memberAccess = (text: string, offset: number): string | null => {
    const isWord = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_]/.test(c);
    // Skip back over the partial member word already typed after the dot.
    let i = offset;
    while (i > 0 && isWord(text[i - 1])) i--;
    if (text[i - 1] !== '.') return null;
    // The base is the identifier immediately before the dot (empty when the dot follows, say, a `)`).
    const dot = i - 1;
    let start = dot;
    while (start > 0 && isWord(text[start - 1])) start--;
    return text.slice(start, dot);
};

/**
 * Builds the member list for a `base.` access from the resolved type of `base`.
 *
 * @param scope the widened source (file plus includes), for uniforms and struct definitions.
 * @param currentText the edited file, for local/parameter declarations of the base identifier.
 * @param base the identifier before the dot.
 */
const memberCompletions = (scope: string, currentText: string, base: string): CompletionItem[] => {
    const type = base ? resolveType(scope, currentText, base) : undefined;

    if (type && /^Texture(2D|3D|Cube|2DArray)/.test(type)) {
        // Show the return type inline (`float4 Sample(sampler, uv)`) and the explanation on expand.
        return Object.entries(TEXTURE_METHODS).map(([name, method]) => ({
            label: name,
            kind: CompletionItemKind.Method,
            detail: `${method.returns} ${method.signature}`,
            documentation: method.doc,
        }));
    }

    const structMembers = type ? structMembersOf(scope, type) : undefined;
    if (structMembers) {
        return structMembers.map((m) => ({
            label: m.name,
            kind: CompletionItemKind.Field,
            detail: m.type,
            documentation: `Struct member of \`${type}\`, of type \`${m.type}\`.`,
        }));
    }

    // A vector gets its swizzles, limited to its component count; a scalar has no members; an unknown
    // type falls back to the full 4-component swizzle set (most dotted locals are vectors).
    const components = vectorComponentCount(type);
    if (type && components === 1) return [];
    return swizzleCompletions(components ?? 4, scalarOf(type));
};

/** The scalar element type of a vector type token (`float3` → `float`), defaulting to `float`. */
const scalarOf = (type: string | undefined): string => {
    const match = /^(float|half|int|uint|bool|double)/.exec(type ?? '');
    return match ? match[1] : 'float';
};

/** The component count of a vector type token (`float3` → 3, `float` → 1), or undefined when not numeric-vector. */
const vectorComponentCount = (type: string | undefined): number | undefined => {
    if (!type) return undefined;
    const match = /^(?:float|half|int|uint|bool|double)([2-4])?$/.exec(type);
    if (!match) return undefined;
    return match[1] ? Number(match[1]) : 1;
};

/**
 * Swizzle completions for an n-component vector of scalar element type `scalar`: each single channel
 * plus the common full groupings. Each item's detail is the resulting type (`.xyz` on a `float4` is a
 * `float3`, `.x` is a `float`) and its documentation names the channels it selects.
 */
const swizzleCompletions = (n: number, scalar: string): CompletionItem[] => {
    const positional = ['x', 'y', 'z', 'w'].slice(0, n);
    const colour = ['r', 'g', 'b', 'a'].slice(0, n);
    const labels = [...positional, ...colour];
    // Add the whole-vector groupings (`xy`, `xyz`, `xyzw`, and colour equivalents) as handy shortcuts.
    for (let k = 2; k <= n; k++) {
        labels.push(positional.slice(0, k).join(''));
        labels.push(colour.slice(0, k).join(''));
    }
    return labels.map((label) => {
        const resultType = label.length === 1 ? scalar : `${scalar}${label.length}`;
        const channels = label.split('').join(', ');
        const plural = label.length === 1 ? 'channel' : 'channels';
        return {
            label,
            kind: CompletionItemKind.Field,
            detail: resultType,
            documentation: `Swizzle — the ${channels} ${plural} as a \`${resultType}\`.`,
        };
    });
};

/**
 * Resolves the HLSL type of an identifier: a file-scope uniform's declared type, else the type token of
 * the nearest preceding declaration (`float3 color`, `in VERT_INPUT input`). Returns undefined when no
 * declaration is found.
 */
const resolveType = (scope: string, currentText: string, name: string): string | undefined => {
    // A uniform declared anywhere in scope (the file or one of its includes).
    const uniform = parseShader(scope).constants.find((c) => c.name === name);
    if (uniform) return uniform.hlslType;
    // An engine uniform declared in an include (`_texture`, …) that the file scan never sees.
    if (name in ENGINE_UNIFORMS) return ENGINE_UNIFORMS[name].type;

    // A local or parameter declaration: an optional qualifier, a type token, then the name (not a
    // function, so the name must not be immediately followed by `(`). These are function-body locals,
    // so scan only the edited file, not the includes (whose locals belong to their own functions).
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const declaration = new RegExp(
        `(?:^|[({,;]|\\bin\\b|\\bout\\b|\\binout\\b|\\bconst\\b|\\bstatic\\b|\\buniform\\b)\\s*([A-Za-z_]\\w*)\\s+${escaped}\\b(?!\\s*\\()`,
        'g'
    );
    let type: string | undefined;
    for (let m = declaration.exec(currentText); m !== null; m = declaration.exec(currentText)) {
        // The captured word must not itself be a qualifier that slipped through as the "type".
        if (!/^(?:in|out|inout|const|static|uniform|return)$/.test(m[1])) type = m[1];
    }
    return type;
};

/** A struct member (its type and name), read from a `struct` definition. */
interface StructMember {
    readonly type: string;
    readonly name: string;
}

/** The members of the struct named `typeName`, or undefined when no such struct is defined in the file. */
const structMembersOf = (text: string, typeName: string): StructMember[] | undefined => {
    const escaped = typeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const struct = new RegExp(`\\bstruct\\s+${escaped}\\s*\\{([^}]*)\\}`).exec(text);
    if (!struct) return undefined;
    const members: StructMember[] = [];
    for (const line of struct[1].split(';')) {
        const field = /^\s*(?:const\s+|static\s+)*([A-Za-z_]\w*)\s+([A-Za-z_]\w*)/.exec(line);
        if (field) members.push({ type: field[1], name: field[2] });
    }
    return members.length ? members : undefined;
};
