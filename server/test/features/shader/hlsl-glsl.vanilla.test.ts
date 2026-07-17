import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { expandShaderSource } from '../../../src/features/shader/shader-source';
import { translateToGlsl, type GlslTranslation } from '../../../src/features/shader/hlsl-to-glsl';
import { DEFAULT_ENTRY_DEFINES, PREVIEW_SHADER_DEFINES } from '../../../src/features/shader/shader-preview.service';

/**
 * Whole-corpus conformance: every vanilla shader must translate to GLSL with no HLSL construct left
 * in the output, in both the fragment path and (when synthesized) the vertex stage. This is the
 * shader-side equivalent of the whole-vanilla schema coverage tests: it needs the game install and
 * self-skips without it.
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
        [...PREVIEW_SHADER_DEFINES, ...DEFAULT_ENTRY_DEFINES],
        DATA_DIR
    );
    return translateToGlsl(withDefaults);
};

describe('HLSL → GLSL whole-vanilla conformance', () => {
    it.runIf(HAVE_DATA)('translates every vanilla shader cleanly, vertex stages included', async () => {
        const shaders = findShaders(DATA_DIR);
        expect(shaders.length).toBeGreaterThan(100);
        const failures: string[] = [];
        const kinds = new Map<string, number>();
        for (const path of shaders) {
            const rel = path.slice(DATA_DIR.length + 1).replace(/\\/g, '/');
            const result = await translateLikePreview(path);
            if (!result.ok) {
                failures.push(`${rel}: ${result.reason}`);
                continue;
            }
            if (hasHlslLeftovers(result.glsl!)) failures.push(`${rel}: fragment has HLSL leftovers`);
            if (!isBalanced(result.glsl!)) failures.push(`${rel}: fragment braces/parens unbalanced`);
            const kind = result.vertex?.kind ?? 'none';
            kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
            if (result.vertex) {
                if (hasHlslLeftovers(result.vertex.glsl)) failures.push(`${rel}: vertex stage has HLSL leftovers`);
                if (hasHlslLeftovers(result.vertex.fragment)) {
                    failures.push(`${rel}: varying fragment has HLSL leftovers`);
                }
                if (!isBalanced(result.vertex.glsl)) failures.push(`${rel}: vertex stage unbalanced`);
            }
        }
        // eslint-disable-next-line no-console
        console.log('vertex stage kinds:', Object.fromEntries(kinds));
        expect(failures, failures.join('\n')).toEqual([]);
    }, 120000);
});
