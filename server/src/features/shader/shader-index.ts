import { readFile, stat } from 'fs/promises';
import { resolve as resolvePath } from 'path';
import { parseShader, parseShaderTypes } from './shader-parser';
import { DeclarationPosition, ParsedShader, ShaderConstant } from './shader-parser.types';
import { resolveInclude } from './shader-source';
import { CosmoteerWorkspaceService } from '../../workspace/cosmoteer-workspace.service';

/**
 * Resolves a `.shader` file to the set of `_`-prefixed constants a material can set from its `.rules`,
 * following `#include` directives across files and filtering out the constants the engine binds itself.
 *
 * The list of settable constants for a shader is the union of every uniform declared in the shader and
 * all of its includes, minus the engine-bound ones. A material in a `.rules` file then writes any of
 * these as a sibling `_name = value` key, so this set is exactly what field-name completion offers and
 * what hover documents.
 */

/**
 * Constants the rendering engine binds every frame, so a material never sets them and completion must
 * not offer them. The first group is `Halfling.Graphics.BuiltinShaderConstantIDs`, the rest are the
 * pipeline-managed uniforms declared in `base.shader` (the per-frame cbuffer, the camera transform,
 * the render targets, and the global lighting values). Sampler-state companions (`*_SS`) are dropped
 * separately because they are paired with a texture automatically.
 */
export const ENGINE_BOUND_NAMES: ReadonlySet<string> = new Set([
    '_texture',
    '_color',
    '_transform',
    '_screenSize',
    '_time',
    '_gameTime',
    '_innerRadius',
    '_thickness',
    '_baseSize',
    '_mode',
    '_viewportScale',
    '_stencilTarget',
    '_diffuseTarget',
    '_normalsTarget',
    '_globalAmbientLight',
    '_globalDiffuseLight',
    '_globalMinDiffuseLight',
    '_globalSpecularLight',
    '_lightNormal',
]);

/** True if a constant is bound by the engine rather than set by a material. */
const isEngineBound = (constant: ShaderConstant): boolean =>
    constant.kind === 'sampler' || constant.name.endsWith('_SS') || ENGINE_BOUND_NAMES.has(constant.name);

/** A source of open-buffer text for a path, so a live preview can read unsaved edits. */
export type ReadOverride = (absPath: string) => string | undefined;

/** Reads a file as text, preferring an open-buffer override, returning null when it cannot be read. */
const readText = async (path: string, readOverride?: ReadOverride): Promise<string | null> => {
    const override = readOverride?.(path);
    if (override !== undefined) return override;
    try {
        return await readFile(path, 'utf8');
    } catch {
        return null;
    }
};

/** The on-disk identity of every file an include walk read, for later freshness checks. */
type ChainStamp = ReadonlyArray<{ readonly path: string; readonly mtimeMs: number }>;

/** A cache entry keyed by absolute shader path, invalidated when any file in the chain changes. */
interface CacheEntry {
    /** The identity of every file the result was derived from. */
    readonly chain: ChainStamp;
    /** The resolved settable constants, ready to serve. */
    readonly constants: readonly ShaderConstant[];
}

const cache = new Map<string, CacheEntry>();

/** The mtime of a file in milliseconds, or 0 when it cannot be stat-ed. */
const mtimeOf = async (path: string): Promise<number> => {
    try {
        return (await stat(path)).mtimeMs;
    } catch {
        return 0;
    }
};

/**
 * Whether every file a cached result was derived from is unchanged on disk. The whole chain is
 * checked, not just the root shader: an edit to an included file must invalidate the result even
 * when the root file is untouched.
 *
 * @param chain the file identities recorded when the result was computed.
 * @returns true when every chain file still has its recorded mtime.
 */
const chainIsFresh = async (chain: ChainStamp): Promise<boolean> => {
    if (chain.length === 0) return false;
    for (const file of chain) {
        if ((await mtimeOf(file.path)) !== file.mtimeMs) return false;
    }
    return true;
};

/**
 * Walks a shader and its include chain, parsing each file once and merging the results. Returns the
 * parsed files in resolution order along with each read file's identity, so the caller can both
 * build the constant set and later decide whether a cached result is still fresh.
 *
 * @param entryPath the absolute path of the shader the material references.
 * @returns the parsed files visited and the identity of every file read.
 */
const walkIncludes = async (
    entryPath: string,
    dataDir?: string,
    readOverride?: ReadOverride
): Promise<{ parsed: ParsedShader[]; chain: ChainStamp }> => {
    const parsed: ParsedShader[] = [];
    const visited = new Set<string>();
    const chain: Array<{ path: string; mtimeMs: number }> = [];

    const visit = async (path: string): Promise<void> => {
        const key = resolvePath(path);
        if (visited.has(key)) return;
        visited.add(key);
        const text = await readText(key, readOverride);
        if (text === null) return;
        chain.push({ path: key, mtimeMs: await mtimeOf(key) });
        const shader = parseShader(text);
        parsed.push(shader);
        for (const include of shader.includes) {
            await visit(resolveInclude(key, include, dataDir));
        }
    };

    await visit(entryPath);
    return { parsed, chain };
};

/**
 * The constants a material can set on the shader at `shaderPath`, following includes and dropping the
 * engine-bound uniforms. The result is cached per absolute path and refreshed when any file in the
 * include chain is modified.
 *
 * @param shaderPath the absolute on-disk path of the `.shader` file the material references.
 * @returns the settable constants in declaration order with duplicates removed, or an empty array when
 * the shader cannot be read.
 */
export const shaderConstants = async (
    shaderPath: string,
    dataDir: string = CosmoteerWorkspaceService.instance.CosmoteerWorkspacePath,
    readOverride?: ReadOverride
): Promise<readonly ShaderConstant[]> => {
    const key = resolvePath(shaderPath);
    // The mtime cache tracks the on-disk files only. When an open-buffer override is in play (a live
    // preview reading unsaved edits) skip the cache entirely and recompute, since the buffer content is
    // not reflected by any file mtime.
    const cached = readOverride ? undefined : cache.get(key);
    if (cached && (await chainIsFresh(cached.chain))) return cached.constants;

    const { parsed, chain } = await walkIncludes(key, dataDir, readOverride);
    const byName = new Map<string, ShaderConstant>();
    for (const shader of parsed) {
        for (const constant of shader.constants) {
            if (isEngineBound(constant)) continue;
            if (!byName.has(constant.name)) byName.set(constant.name, constant);
        }
    }
    const constants = [...byName.values()];
    if (!readOverride && chain.length > 0) cache.set(key, { chain, constants });
    return constants;
};

/**
 * Every `_`-prefixed uniform name declared anywhere in a shader and its includes, including the
 * engine-bound ones, excluding only the `*_SS` sampler companions. This is the authoritative set of
 * names a material may legally write: a `_`-key not in it is unknown to the shader. It is the full set
 * (not the settable subset {@link shaderConstants} offers) because writing an engine-bound name is
 * pointless but not an error, and flagging it would be a false positive.
 *
 * @param shaderPath the absolute on-disk path of the `.shader` file the material references.
 * @param dataDir the game's `Data` directory, for root-anchored includes.
 * @returns the set of declared uniform names, or null when the shader cannot be read.
 */
/** Cache of {@link allShaderUniformNames} keyed by absolute shader path, chain-validated like the
 *  settable-constants cache above. A whole-workspace scan asks for the same few shaders' names once
 *  per material-bearing file, which uncached re-read and re-parsed the include chain every time. */
const uniformNamesCache = new Map<string, { chain: ChainStamp; names: ReadonlySet<string> }>();

export const allShaderUniformNames = async (
    shaderPath: string,
    dataDir: string = CosmoteerWorkspaceService.instance.CosmoteerWorkspacePath
): Promise<ReadonlySet<string> | null> => {
    const key = resolvePath(shaderPath);
    const cached = uniformNamesCache.get(key);
    if (cached && (await chainIsFresh(cached.chain))) return cached.names;
    const { parsed, chain } = await walkIncludes(key, dataDir);
    if (chain.length === 0) return null; // nothing read, the shader does not exist on disk
    const names = new Set<string>();
    for (const shader of parsed) {
        for (const constant of shader.constants) {
            if (constant.kind === 'sampler' || constant.name.endsWith('_SS')) continue;
            names.add(constant.name);
        }
    }
    uniformNamesCache.set(key, { chain, names });
    return names;
};

/**
 * The concatenated raw text of every file reachable through a shader's `#include` chain, starting from
 * the includes written in `entryText` (so unsaved `#include` lines are honoured) and excluding the
 * entry file itself (the caller already has it). Open buffers are preferred over disk via
 * `readOverride`. Unlike {@link expandShaderSource} this does no preprocessing, so uniforms and structs
 * behind an `#ifdef` are still present. Completion and type-resolution want the permissive view.
 *
 * @param entryText the source of the shader being edited (the open buffer).
 * @param entryPath the absolute path of that shader, the base for resolving its includes.
 * @param dataDir the game `Data` directory, for root-anchored includes.
 * @param readOverride prefers an open buffer's text over disk for a given path.
 * @returns the joined text of the included files, or an empty string when there are none.
 */
export const collectIncludeText = async (
    entryText: string,
    entryPath: string,
    dataDir: string = CosmoteerWorkspaceService.instance.CosmoteerWorkspacePath,
    readOverride?: ReadOverride
): Promise<string> => (await readIncludeChain(entryText, entryPath, dataDir, readOverride)).text;

/** The concatenated include text plus whether every include in the chain could be read. */
interface IncludeChain {
    /** The joined raw text of every readable file in the `#include` chain (the entry file excluded). */
    readonly text: string;
    /** True when every include resolved and was readable, so the symbol set is known to be complete. */
    readonly complete: boolean;
}

/**
 * Reads a shader's whole `#include` chain, like {@link collectIncludeText}, but also reports whether the
 * chain is complete (every include resolved and was readable). A caller that flags undeclared symbols
 * needs this: with a missing include the symbol set is partial, so any "undeclared" verdict could be a
 * false positive and the check must be skipped.
 *
 * @param entryText the source of the shader being edited.
 * @param entryPath the absolute path of that shader.
 * @param dataDir the game `Data` directory, for root-anchored includes.
 * @param readOverride prefers an open buffer's text over disk for a given path.
 * @returns the joined include text and whether the chain was fully readable.
 */
export const readIncludeChain = async (
    entryText: string,
    entryPath: string,
    dataDir: string = CosmoteerWorkspaceService.instance.CosmoteerWorkspacePath,
    readOverride?: ReadOverride
): Promise<IncludeChain> => {
    const parts: string[] = [];
    const visited = new Set<string>();
    let complete = true;
    const visit = async (fromPath: string, includes: readonly string[]): Promise<void> => {
        for (const include of includes) {
            const target = resolvePath(resolveInclude(fromPath, include, dataDir));
            if (visited.has(target)) continue;
            visited.add(target);
            const text = await readText(target, readOverride);
            if (text === null) {
                complete = false;
                continue;
            }
            parts.push(text);
            await visit(target, parseShader(text).includes);
        }
    };
    await visit(resolvePath(entryPath), parseShader(entryText).includes);
    return { text: parts.join('\n'), complete };
};

/** The on-disk location of a declaration in a shader or one of its includes. */
interface ShaderDeclarationLocation {
    /** The absolute path of the file the name is declared in. */
    readonly path: string;
    /** The 0-based line of the name. */
    readonly line: number;
    /** The 0-based column of the name. */
    readonly column: number;
    /** The length of the name, for the selection range. */
    readonly length: number;
}

/** A `#define` line, with the macro's own name as the last group so its column follows from the match. */
const DEFINE_RE = /^[ \t]*#[ \t]*define[ \t]+([A-Za-z_]\w*)/;

/**
 * Where a `#define` gives a macro its name, or null.
 *
 * Feature guards are how a Cosmoteer shader is configured: `#define ENABLE_TANGENT` above the
 * `#include` switches on a branch the base shader writes behind `#ifdef`. Hover already reads them,
 * so the guard a shader tests navigates to the line that turns it on. A name only ever tested has
 * no definition to find, which is the honest answer: any of a base shader's includers may define
 * it, and the tested line is a use rather than a declaration.
 *
 * @param text the shader source to scan.
 * @param name the macro name.
 * @returns the 0-based position of the name, or null.
 */
const macroDefinition = (text: string, name: string): DeclarationPosition | null => {
    const lines = text.split(/\r?\n/);
    for (let line = 0; line < lines.length; line++) {
        const match = DEFINE_RE.exec(lines[line]);
        if (match?.[1] === name) return { line, column: match[0].length - name.length };
    }
    return null;
};

/**
 * Finds where a name is declared, searching the file being edited first and then its `#include` chain
 * (open buffers preferred via `readOverride`). Uniforms, functions, structs, `typedef` aliases and
 * `static const` values are all navigable. The entry file's own text is passed in (not read from disk)
 * so an unsaved declaration is found too.
 *
 * @param entryText the source of the shader being edited.
 * @param entryPath the absolute path of that shader, the base for resolving its includes.
 * @param name the identifier to locate.
 * @param dataDir the game `Data` directory, for root-anchored includes.
 * @param readOverride prefers an open buffer's text over disk for a given path.
 * @returns the declaration's file and position, or null when it is declared nowhere in the chain.
 */
export const findShaderDeclaration = async (
    entryText: string,
    entryPath: string,
    name: string,
    dataDir: string = CosmoteerWorkspaceService.instance.CosmoteerWorkspacePath,
    readOverride?: ReadOverride
): Promise<ShaderDeclarationLocation | null> => {
    const visited = new Set<string>();

    const at = (path: string, position: DeclarationPosition): ShaderDeclarationLocation => ({
        path,
        line: position.line,
        column: position.column,
        length: name.length,
    });

    const locate = (path: string, shader: ParsedShader, text: string): ShaderDeclarationLocation | null => {
        const constant = shader.constants.find((c) => c.name === name && c.position);
        if (constant?.position) return at(path, constant.position);
        const fn = shader.functionDecls.find((f) => f.name === name);
        if (fn) return at(path, fn.position);
        // The named types and values live outside the uniform and function lists, and a shader names
        // one of them in nearly every entry-point signature, so they are navigable too.
        const declared = parseShaderTypes(text);
        const struct = declared.structs.find((s) => s.name === name);
        if (struct) return at(path, struct.position);
        const alias = declared.typeAliases.find((a) => a.name === name);
        if (alias) return at(path, alias.position);
        const staticConstant = declared.staticConstants.find((c) => c.name === name);
        if (staticConstant) return at(path, staticConstant.position);
        // Last, so a name that is both a macro and a real declaration navigates to the declaration.
        const macro = macroDefinition(text, name);
        if (macro) return at(path, macro);
        return null;
    };

    const visit = async (path: string, text: string): Promise<ShaderDeclarationLocation | null> => {
        const key = resolvePath(path);
        if (visited.has(key)) return null;
        visited.add(key);
        const shader = parseShader(text);
        const here = locate(key, shader, text);
        if (here) return here;
        for (const include of shader.includes) {
            const target = resolveInclude(key, include, dataDir);
            const includeText = await readText(resolvePath(target), readOverride);
            if (includeText === null) continue;
            const found = await visit(target, includeText);
            if (found) return found;
        }
        return null;
    };

    return visit(resolvePath(entryPath), entryText);
};

/** Clears the in-memory shader cache. Intended for tests. */
export const clearShaderCache = (): void => cache.clear();
