import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { expandShaderSource } from '../../../src/features/shader/shader-source';
import { translateToGlsl, type GlslTranslation } from '../../../src/features/shader/hlsl-to-glsl';
import { defaultEntryDefinesFor, PREVIEW_SHADER_DEFINES } from '../../../src/features/shader/shader-preview.service';
import { compileGlslPrograms, findBrowser, type GlslProgram } from './glsl-compiler';

/**
 * Whole-corpus conformance: every vanilla shader must translate to GLSL and the GLSL must compile, in
 * both the fragment path and (when synthesized) the vertex stage. This is the shader-side equivalent of
 * the whole-vanilla schema coverage tests: it needs the game install and self-skips without it. The
 * compile half also needs a browser to borrow a GLSL compiler from and self-skips without one.
 */

const DATA_DIR =
    process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const HAVE_DATA = existsSync(DATA_DIR);

/** Every `.shader` file under a directory, recursively. */
const findShaders = (dir: string): string[] => {
    const found: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) found.push(...findShaders(path));
        else if (entry.name.endsWith('.shader')) found.push(path);
    }
    return found;
};

// True if any HLSL-only token survived translation, which would mean the GLSL would not compile.
const hasHlslLeftovers = (glsl: string): boolean =>
    /\bTexture2D\b|\bSamplerState\b|\bfloat[234]\s*\(|\bPIX_OUTPUT\b|\.Sample\s*\(|:\s*SV_TARGET|\bstatic\b|\bhalf\b|\(\s*u?int[234]?\s*\)|\bGetDimensions\b|\bSampleLevel\b|%|\bisinf\s*\(|\bnointerpolation\b|\bsincos\s*\(|\btypedef\b|\bcbuffer\b/.test(
        glsl
    );

/** True when every brace and parenthesis in the source pairs up, a cheap structural sanity check. */
const isBalanced = (src: string): boolean => {
    let brace = 0;
    let paren = 0;
    for (const c of src) {
        if (c === '{') brace++;
        else if (c === '}') brace--;
        else if (c === '(') paren++;
        else if (c === ')') paren--;
        if (brace < 0 || paren < 0) return false;
    }
    return brace === 0 && paren === 0;
};

/** Translates one shader the way the preview service does, including the default-entry retry. */
const translateLikePreview = async (path: string): Promise<GlslTranslation> => {
    const expanded = await expandShaderSource(path, [...PREVIEW_SHADER_DEFINES], DATA_DIR);
    const translation = translateToGlsl(expanded);
    if (translation.ok || translation.reason !== 'no recognizable pix entry point') return translation;
    const withDefaults = await expandShaderSource(
        path,
        [...PREVIEW_SHADER_DEFINES, ...defaultEntryDefinesFor(expanded)],
        DATA_DIR
    );
    return translateToGlsl(withDefaults);
};

/** Translates the whole vanilla tree, collecting the structural failures and the compilable programs. */
const translateVanilla = async (): Promise<{ failures: string[]; programs: GlslProgram[]; kinds: Map<string, number> }> => {
    const failures: string[] = [];
    const programs: GlslProgram[] = [];
    const kinds = new Map<string, number>();
    for (const path of findShaders(DATA_DIR)) {
        const rel = path.slice(DATA_DIR.length + 1).replace(/\\/g, '/');
        const result = await translateLikePreview(path);
        if (!result.ok) {
            failures.push(`${rel}: ${result.reason}`);
            continue;
        }
        if (hasHlslLeftovers(result.glsl!)) failures.push(`${rel}: fragment has HLSL leftovers`);
        if (!isBalanced(result.glsl!)) failures.push(`${rel}: fragment braces/parens unbalanced`);
        programs.push({ id: `${rel} [fragment]`, fragment: result.glsl! });
        kinds.set(result.vertex?.kind ?? 'none', (kinds.get(result.vertex?.kind ?? 'none') ?? 0) + 1);
        if (result.vertex) {
            if (hasHlslLeftovers(result.vertex.glsl)) failures.push(`${rel}: vertex stage has HLSL leftovers`);
            if (hasHlslLeftovers(result.vertex.fragment)) {
                failures.push(`${rel}: varying fragment has HLSL leftovers`);
            }
            if (!isBalanced(result.vertex.glsl)) failures.push(`${rel}: vertex stage unbalanced`);
            programs.push({
                id: `${rel} [vertex stage]`,
                fragment: result.vertex.fragment,
                vertex: result.vertex.glsl,
            });
        }
    }
    return { failures, programs, kinds };
};

describe('HLSL → GLSL whole-vanilla conformance', () => {
    it.runIf(HAVE_DATA)('translates every vanilla shader cleanly, vertex stages included', async () => {
        const { failures, programs, kinds } = await translateVanilla();
        expect(programs.length).toBeGreaterThan(100);
        console.log('vertex stage kinds:', Object.fromEntries(kinds));
        expect(failures, failures.join('\n')).toEqual([]);
    }, 120000);

    const browser = findBrowser();
    it.runIf(HAVE_DATA && browser)('compiles the translated GLSL of every vanilla shader', async () => {
        const { programs } = await translateVanilla();
        const failures = compileGlslPrograms(programs, browser!);
        const reported = Object.entries(failures).map(([id, error]) => `${id}: ${error}`);
        expect(reported, reported.join('\n')).toEqual([]);
    }, 300000);
});
