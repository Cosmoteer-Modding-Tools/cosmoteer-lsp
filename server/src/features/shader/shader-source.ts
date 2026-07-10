import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { dirname, relative as relativePath, resolve as resolvePath } from 'path';
import { findModRoot } from '../../mod/mod-root';

/**
 * Resolves a shader `#include` path to an absolute path. Cosmoteer shaders use two include forms, a
 * path relative to the including file (`"../base.shader"`) and a root-anchored path that names the game
 * data tree (`"./Data/base.shader"`). The latter is resolved against the game's `Data` directory, the
 * former against the including file's own directory. A relative include that does not exist on disk is
 * also tried at the same mod-relative location inside the game tree: a mod mirrors the `Data` layout
 * and the game merges the two at load, so a mod's `common_effects/x.shader` can include vanilla's
 * sibling `base_particle.shader` even though the mod folder holds no such file.
 *
 * @param fromFile the absolute path of the file that contains the include directive.
 * @param includePath the literal path written in the `#include "…"` directive.
 * @param dataDir the absolute path of the game's `Data` directory, used for root-anchored includes.
 * @returns the absolute path the include resolves to.
 */
export const resolveInclude = (fromFile: string, includePath: string, dataDir?: string): string => {
    const rooted = /^\.?[\\/]?[Dd]ata[\\/](.+)$/.exec(includePath);
    if (rooted && dataDir) return resolvePath(dataDir, rooted[1]);
    const relative = resolvePath(dirname(fromFile), includePath);
    if (!dataDir || existsSync(relative)) return relative;
    const modRoot = findModRoot(fromFile);
    if (!modRoot) return relative;
    const withinMod = relativePath(resolvePath(modRoot), relative);
    if (withinMod.startsWith('..')) return relative;
    const inGameTree = resolvePath(dataDir, withinMod);
    return existsSync(inGameTree) ? inGameTree : relative;
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

/**
 * Reads a shader file and its includes into a single preprocessed source string.
 *
 * @param entryPath the absolute path of the shader to expand.
 * @param predefined macros considered already defined before processing (rarely needed).
 * @param dataDir the absolute path of the game's `Data` directory, for root-anchored includes.
 * @returns the expanded, preprocessed source, or an empty string when the entry file cannot be read.
 */
export const expandShaderSource = async (
    entryPath: string,
    predefined: readonly string[] = [],
    dataDir?: string,
    // Prefer an open editor buffer's text over the on-disk file, so a live preview reflects unsaved
    // shader edits. Returns undefined for a path that is not open, which falls back to reading disk.
    readOverride?: (absPath: string) => string | undefined
): Promise<string> => {
    const macros = new Map<string, string>();
    for (const name of predefined) macros.set(name, '');
    const stack: CondFrame[] = [];
    const out: string[] = [];
    const visiting = new Set<string>();

    /** True when every enclosing conditional branch is currently emitting. */
    const emitting = (): boolean => stack.every((frame) => frame.active);

    const process = async (path: string): Promise<void> => {
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
                visiting.delete(key);
                return;
            }
        }

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
                    if (frame) stack.push({ active: frame.parentActive && !frame.taken, taken: true, parentActive: frame.parentActive });
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
                    if (inc) await process(resolveInclude(key, inc[1], dataDir));
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
    return out.join('\n');
};
