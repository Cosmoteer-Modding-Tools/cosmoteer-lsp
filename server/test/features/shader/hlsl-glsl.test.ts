import { describe, expect, it } from 'vitest';
import { existsSync } from 'fs';
import { join } from 'path';
import { expandShaderSource } from '../../../src/features/shader/shader-source';
import { translateToGlsl } from '../../../src/features/shader/hlsl-to-glsl';

const DATA_DIR =
    process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const HAVE_DATA = existsSync(DATA_DIR);

// True if any HLSL-only token survived translation, which would mean the GLSL would not compile.
const hasHlslLeftovers = (glsl: string): boolean =>
    /\bTexture2D\b|\bSamplerState\b|\bfloat[234]\s*\(|\bPIX_OUTPUT\b|\.Sample\s*\(|:\s*SV_TARGET|\bstatic\b|\bhalf\b|\(\s*u?int[234]?\s*\)|\bGetDimensions\b/.test(
        glsl
    );

describe('HLSL → GLSL translation', () => {
    it('resolves #ifdef-gated entry points through includes', async () => {
        // A minimal stand-in for default.shader: define the guard, then the guarded pix appears.
        const glsl = translateToGlsl(`
#define USE_DEFAULT_PIX
struct VERT_OUTPUT { float4 location : SV_POSITION; float4 color : COLOR0; float2 uv : TEXCOORD0; };
typedef float4 PIX_OUTPUT;
Texture2D _texture;
SamplerState _texture_SS;
#ifdef USE_DEFAULT_PIX
PIX_OUTPUT pix(in VERT_OUTPUT input) : SV_TARGET
{
    float4 ret = _texture.Sample(_texture_SS, input.uv) * input.color;
    if (ret.a <= 0.0) discard;
    return ret;
}
#endif
`);
        expect(glsl.ok).toBe(true);
        expect(glsl.glsl).toContain('void main');
        expect(glsl.glsl).toContain('uniform sampler2D _texture');
        expect(glsl.glsl).toContain('texture2D(_texture');
        // `input` is reserved in GLSL ES, so the conventional parameter is renamed.
        expect(glsl.glsl).toContain('vsIn.uv = vUv');
        expect(glsl.glsl).not.toMatch(/\binput\b/);
        expect(hasHlslLeftovers(glsl.glsl!)).toBe(false);
    });

    it('strips comments so a `// comment` between `)` and `{` cannot break dead-code elimination', () => {
        // `unused` is unreachable from pix and calls `helper`. With comments intact, the `// note` after
        // `)` once hid `unused` from the function scan, so it was kept while `helper` was pruned — a
        // dangling call. Stripping comments first makes both prune together.
        const glsl = translateToGlsl(`
typedef float4 PIX_OUTPUT;
float helper(float x) { return x * 2; }
float4 unused(in float2 uv) // a trailing comment before the brace
{
    return float4(helper(uv.x), 0, 0, 1);
}
PIX_OUTPUT pix(in VERT_OUTPUT input) : SV_TARGET
{
    return float4(input.uv, 0, 1);
}
struct VERT_OUTPUT { float2 uv : TEXCOORD0; float4 color : COLOR0; };
`);
        expect(glsl.ok).toBe(true);
        expect(glsl.glsl).not.toMatch(/\bunused\b/);
        expect(glsl.glsl).not.toMatch(/\bhelper\b/);
    });

    it('rewrites HLSL C-style integer casts into float-domain floor calls', () => {
        // `(int2)(…)` quantises a value that stays in float maths, so it becomes `floor(…)` rather than
        // an `ivec2`, which would illegally mix `int` and `float` in the surrounding arithmetic.
        const glsl = translateToGlsl(`
typedef float4 PIX_OUTPUT;
struct VERT_OUTPUT { float2 uv : TEXCOORD0; float4 color : COLOR0; };
PIX_OUTPUT pix(in VERT_OUTPUT input) : SV_TARGET
{
    float2 uv = (int2)(input.uv * 8 + 0.5) / 8;
    return float4(uv, 0, 1);
}
`);
        expect(glsl.ok).toBe(true);
        expect(glsl.glsl).toContain('floor(vsIn.uv');
        expect(glsl.glsl).not.toMatch(/\(int2\)|\bint2\b/);
    });

    it('renames identifiers that collide with the reserved `half` keyword', () => {
        // `half` is reserved in GLSL ES 1.00, so a variable named `half` must be renamed to compile.
        const glsl = translateToGlsl(`
typedef float4 PIX_OUTPUT;
struct VERT_OUTPUT { float2 uv : TEXCOORD0; float4 color : COLOR0; };
PIX_OUTPUT pix(in VERT_OUTPUT input) : SV_TARGET
{
    float2 half = float2(0.5, 0.5);
    return float4(input.uv - half, 0, 1);
}
`);
        expect(glsl.ok).toBe(true);
        expect(glsl.glsl).not.toMatch(/\bhalf\b/);
        expect(glsl.glsl).toContain('half_');
    });

    it('lowers SampleLevel, GetDimensions and texture parameters (the decals shader pattern)', () => {
        // Explicit-LOD sampling and texture-size queries have no fragment-stage equivalent in GLSL ES
        // 1.00, so the LOD argument is dropped and the dimensions are stubbed, leaving compilable code.
        const glsl = translateToGlsl(`
typedef float4 PIX_OUTPUT;
struct VERT_OUTPUT { float2 uv : TEXCOORD0; float4 color : COLOR0; };
Texture2D _texture;
SamplerState _texture_SS;
float mip(Texture2D tex, float2 uv)
{
    float w, h;
    tex.GetDimensions(w, h);
    return ddx(uv).x * w + ddy(uv).y * h;
}
PIX_OUTPUT pix(in VERT_OUTPUT input) : SV_TARGET
{
    float lod = mip(_texture, input.uv);
    return _texture.SampleLevel(_texture_SS, input.uv, lod);
}
`);
        expect(glsl.ok).toBe(true);
        expect(glsl.glsl).toContain('float mip(sampler2D tex');
        expect(glsl.glsl).toContain('texture2D(_texture, vsIn.uv)');
        expect(glsl.glsl).toContain('w = 256.0; h = 256.0;');
        expect(glsl.glsl).not.toMatch(/GetDimensions|SampleLevel|\bTexture2D\b/);
        // Screen-space derivatives need their WebGL1 extension declared ahead of everything else.
        expect(glsl.glsl!.startsWith('#extension GL_OES_standard_derivatives : enable')).toBe(true);
    });

    it.runIf(HAVE_DATA)('translates real vanilla shaders without leaving HLSL constructs', async () => {
        const shaders = [
            'default.shader',
            'sprite_lit.shader',
            'common_effects/particles/particle_lit.shader',
            'common_effects/particles/particle_light_emissive.shader',
            // A geometry-origin beam shader: its vertex/geometry helpers (with trailing-comment
            // signatures and `[maxvertexcount]` attributes) must be pruned, leaving a clean pixel stage.
            'common_effects/basic_beam.shader',
            // A post-process shader whose pix is written `float4 pix(…)` rather than `PIX_OUTPUT pix(…)`.
            'gui/blur.shader',
            // A decal shader exercising texture-parameter, SampleLevel and GetDimensions lowering.
            'ships/common/decals.shader',
            // A post shader using HLSL C-style integer casts for pixelation and colour-depth reduction.
            'post_shaders/apple2.shader',
        ];
        for (const rel of shaders) {
            const path = join(DATA_DIR, rel);
            if (!existsSync(path)) continue;
            // default.shader pre-defines the entry guards, the rest define pix directly.
            const predefined = rel === 'default.shader' ? ['USE_DEFAULT_PIX', 'USE_DEFAULT_VERT'] : [];
            const expanded = await expandShaderSource(path, predefined, DATA_DIR);
            const result = translateToGlsl(expanded);
            expect(result.ok, `${rel}: ${result.reason}`).toBe(true);
            expect(hasHlslLeftovers(result.glsl!), `${rel} has HLSL leftovers`).toBe(false);
            expect(result.glsl).toContain('void main');
        }
    });
});
