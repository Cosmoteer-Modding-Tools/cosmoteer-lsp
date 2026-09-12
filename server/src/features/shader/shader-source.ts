import { readFile } from 'fs/promises';
import { dirname, resolve as resolvePath } from 'path';

/**
 * Resolves a shader `#include` path to an absolute path. Cosmoteer shaders use two include forms, a
 * path relative to the including file (`"../base.shader"`) and a root-anchored path that names the game
 * data tree (`"./Data/base.shader"`). The latter is resolved against the game's `Data` directory, the
 * former against the including file's own directory, and there is no third rule: the engine's
 * `D3D11Shader.IncludeHandler.Open` resolves a relative include against the directory of the file that
 * wrote it and nothing else, so a mod include that only exists at the mirrored location in the game
 * tree throws when the game compiles the shader and must not quietly resolve here.
 *
 * @param fromFile the absolute path of the file that contains the include directive.
 * @param includePath the literal path written in the `#include "…"` directive.
 * @param dataDir the absolute path of the game's `Data` directory, used for root-anchored includes.
 * @returns the absolute path the include resolves to.
 */
export const resolveInclude = (fromFile: string, includePath: string, dataDir?: string): string => {
    const rooted = /^\.?[\\/]?[Dd]ata[\\/](.+)$/.exec(includePath);
    if (rooted && dataDir) return resolvePath(dataDir, rooted[1]);
    return resolvePath(dirname(fromFile), includePath);
};

/**
 * Expands a Cosmoteer `.shader` into a single preprocessed source string, ready for translation to
 * GLSL. It inlines `#include "…"` directives in place and resolves the C-style preprocessor subset the
 * shaders use (`#define`, `#undef`, `#ifdef`, `#ifndef`, `#if`/`#elif` with `defined(…)`, `#else`,
 * `#endif`) so the entry points gated behind `#ifdef USE_DEFAULT_PIX` and friends are present in the
 * output.
 *
 * It is intentionally a small preprocessor, not a full one. Object-like macros are substituted, but
 * function-like macros are not (the vanilla shaders do not use them, they prefer `static const`
 * functions). Anything it cannot resolve is passed through unchanged so the translator can decide.
 */

/** A frame of the conditional stack, tracking whether the current branch is emitting. */
interface CondFrame {
    /** True when lines in the current branch should be emitted. */
    readonly active: boolean;
    /** True once any branch of this `#if` chain has been taken (so `#else` knows to stay off). */
    readonly taken: boolean;
    /** The active state of the enclosing frame, so a closed branch never re-activates inside an off parent. */
    readonly parentActive: boolean;
}

/** Substitutes the defined object-like macros into a line of code (whole-word, single pass). */
const substituteMacros = (line: string, macros: Map<string, string>): string => {
    if (macros.size === 0) return line;
    return line.replace(/\b[A-Za-z_]\w*\b/g, (word) => (macros.has(word) ? macros.get(word)! : word));
};

/**
 * Evaluates a `#if`/`#elif` condition against the macro table. Supports the subset the shaders use:
 * `defined(NAME)` (and `defined NAME`), `!`, `&&`, `||`, parentheses, comparisons, and integer
 * literals; undefined identifiers evaluate to 0 and a defined-but-empty macro to 1, the C convention.
 * A condition that still contains anything else after substitution conservatively evaluates true, so
 * an unsupported expression keeps its branch rather than silently dropping code.
 */
const evalCondition = (expr: string, macros: Map<string, string>): boolean => {
    let s = expr.replace(/\/\/.*$|\/\*.*?\*\//g, ' ');
    s = s.replace(/\bdefined\s*\(\s*([A-Za-z_]\w*)\s*\)|\bdefined\s+([A-Za-z_]\w*)/g, (_m, a, b) =>
        macros.has(a ?? b) ? '1' : '0'
    );
    s = s.replace(/\b[A-Za-z_]\w*\b/g, (word) => {
        if (!macros.has(word)) return '0';
        const value = macros.get(word)!.trim();
        return /^\d+$/.test(value) ? value : '1';
    });
    if (!/^[\d\s!&|()<>=+*/%-]*$/.test(s) || !s.trim()) return true;
    try {
        return Boolean(Function(`"use strict"; return (${s});`)());
    } catch {
        return true;
    }
};

/** An expanded shader source together with the files it was built from and the includes that failed. */
export interface ExpandedShader {
    /** The expanded, preprocessed source. */
    readonly text: string;
    /** The include paths, as written, that resolved to nothing readable. */
    readonly unresolved: readonly string[];
    /** The absolute path of every file that was read, the entry file first. */
    readonly files: readonly string[];
}

/**
 * Reads a shader file and its includes into a single preprocessed source string.
 *
 * @param entryPath the absolute path of the shader to expand.
 * @param predefined macros considered already defined before processing (rarely needed).
 * @param dataDir the absolute path of the game's `Data` directory, for root-anchored includes.
 * @param readOverride prefers an open buffer's text over disk for a given path.
 * @returns the expanded, preprocessed source, or an empty string when the entry file cannot be read.
 */
export const expandShaderSource = async (
    entryPath: string,
    predefined: readonly string[] = [],
    dataDir?: string,
    readOverride?: (absPath: string) => string | undefined
): Promise<string> => (await expandShaderSourceDetailed(entryPath, predefined, dataDir, readOverride)).text;

/**
 * Reads a shader file and its includes into a single preprocessed source string, and reports the
 * includes that resolved to nothing. A caller that renders the result needs the second half: an
 * expansion missing a base library compiles into nonsense, so the honest answer is the unresolved
 * include, not whatever the compiler says about the structs the missing file declares.
 *
 * @param entryPath the absolute path of the shader to expand.
 * @param predefined macros considered already defined before processing (rarely needed).
 * @param dataDir the absolute path of the game's `Data` directory, for root-anchored includes.
 * @param readOverride prefers an open buffer's text over disk for a given path.
 * @returns the expanded source and the include paths that could not be read.
 */
export const expandShaderSourceDetailed = async (
    entryPath: string,
    predefined: readonly string[] = [],
    dataDir?: string,
    // Prefer an open editor buffer's text over the on-disk file, so a live preview reflects unsaved
    // shader edits. Returns undefined for a path that is not open, which falls back to reading disk.
    readOverride?: (absPath: string) => string | undefined
): Promise<ExpandedShader> => {
    const macros = new Map<string, string>();
    for (const name of predefined) macros.set(name, '');
    const stack: CondFrame[] = [];
    const out: string[] = [];
    const visiting = new Set<string>();
    const unresolved: string[] = [];
    const files: string[] = [];

    /** True when every enclosing conditional branch is currently emitting. */
    const emitting = (): boolean => stack.every((frame) => frame.active);

    const process = async (path: string, writtenAs?: string): Promise<void> => {
        const key = resolvePath(path);
        if (visiting.has(key)) return; // guard against an include cycle
        visiting.add(key);
        let text: string;
        const override = readOverride?.(key);
        if (override !== undefined) {
            text = override;
        } else {
            try {
                text = await readFile(key, 'utf8');
            } catch {
                if (writtenAs !== undefined) unresolved.push(writtenAs);
                visiting.delete(key);
                return;
            }
        }

        files.push(key);
        for (const raw of text.split(/\r?\n/)) {
            const directive = /^\s*#\s*(\w+)\b\s*(.*)$/.exec(raw);
            if (directive) {
                const [, keyword, rest] = directive;
                if (keyword === 'ifdef' || keyword === 'ifndef') {
                    const has = macros.has(rest.trim());
                    const active = emitting() && (keyword === 'ifdef' ? has : !has);
                    stack.push({ active, taken: active, parentActive: emitting() });
                    continue;
                }
                if (keyword === 'if') {
                    const active = emitting() && evalCondition(rest, macros);
                    stack.push({ active, taken: active, parentActive: emitting() });
                    continue;
                }
                if (keyword === 'elif') {
                    const frame = stack.pop();
                    if (frame) {
                        const active = frame.parentActive && !frame.taken && evalCondition(rest, macros);
                        stack.push({ active, taken: frame.taken || active, parentActive: frame.parentActive });
                    }
                    continue;
                }
                if (keyword === 'else') {
                    const frame = stack.pop();
                    if (frame)
                        stack.push({
                            active: frame.parentActive && !frame.taken,
                            taken: true,
                            parentActive: frame.parentActive,
                        });
                    continue;
                }
                if (keyword === 'endif') {
                    stack.pop();
                    continue;
                }
                if (!emitting()) continue;
                if (keyword === 'define') {
                    const def = /^(\w+)(?:\s+(.*))?$/.exec(rest.trim());
                    if (def) macros.set(def[1], (def[2] ?? '').trim());
                    continue;
                }
                if (keyword === 'undef') {
                    macros.delete(rest.trim());
                    continue;
                }
                if (keyword === 'include') {
                    const inc = /"([^"]+)"/.exec(rest);
                    // A root-anchored include cannot be judged without the game path, so it is read
                    // but never reported, the same rule the include diagnostic applies.
                    if (inc) {
                        const judgeable = dataDir || !/^\.?[\\/]?[Dd]ata[\\/]/.test(inc[1]);
                        await process(resolveInclude(key, inc[1], dataDir), judgeable ? inc[1] : undefined);
                    }
                    continue;
                }
                // Any other directive (`#pragma`, …) is dropped, it has no GLSL meaning here.
                continue;
            }
            if (emitting()) out.push(substituteMacros(raw, macros));
        }

        visiting.delete(key);
    };

    await process(entryPath);
    return { text: out.join('\n'), unresolved, files };
};
