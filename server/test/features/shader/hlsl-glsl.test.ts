import { describe, expect, it } from 'vitest';
import { existsSync } from 'fs';
import { join } from 'path';
import { expandShaderSource } from '../../../src/features/shader/shader-source';
import { translateToGlsl } from '../../../src/features/shader/hlsl-to-glsl';
import { PREVIEW_SHADER_DEFINES } from '../../../src/features/shader/shader-preview.service';

const DATA_DIR =
    process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const HAVE_DATA = existsSync(DATA_DIR);

// True if any HLSL-only token survived translation, which would mean the GLSL would not compile.
const hasHlslLeftovers = (glsl: string): boolean =>
    /\bTexture2D\b|\bSamplerState\b|\bfloat[234]\s*\(|\bPIX_OUTPUT\b|\.Sample\s*\(|:\s*SV_TARGET|\bstatic\b|\bhalf\b|\(\s*u?int[234]?\s*\)|\bGetDimensions\b|\bSampleLevel\b|%|\bisinf\s*\(|\bnointerpolation\b|\bsincos\s*\(/.test(
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
        // 1.00, so both route through the pvTexLod/pvTexSize helpers, whose ES 1.00 fallback bodies
        // the webview swaps for textureLod/textureSize when it runs on WebGL2.
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
        expect(glsl.glsl).toContain('pvTexLod(_texture, vsIn.uv, lod)');
        expect(glsl.glsl).toContain('w = pvTexSize(tex).x; h = pvTexSize(tex).y;');
        // The helpers carry the ES 1.00 fallback bodies the webview swaps on WebGL2.
        expect(glsl.glsl).toContain('vec4 pvTexLod(sampler2D t, vec2 uv, float lod) { return texture2D(t, uv); }');
        expect(glsl.glsl).toContain('vec2 pvTexSize(sampler2D t) { return vec2(256.0, 256.0); }');
        expect(glsl.glsl).not.toMatch(/GetDimensions|SampleLevel|\bTexture2D\b/);
        // Screen-space derivatives need their WebGL1 extension declared ahead of everything else.
        expect(glsl.glsl!.startsWith('#extension GL_OES_standard_derivatives : enable')).toBe(true);
    });

    it('covers HLSL scalar promotion in lerp calls (the saturation post-shader pattern)', () => {
        // `lerp(luminance, rgb, t)` promotes the scalar to a vector in HLSL; GLSL has no promotion, so
        // the prelude must supply the mixed-signature overloads (and the plain set too when the shader
        // never included base.shader, whose overloads would otherwise define lerp_).
        const glsl = translateToGlsl(`
typedef float4 PIX_OUTPUT;
struct VERT_OUTPUT { float2 uv : TEXCOORD0; float4 color : COLOR0; };
Texture2D _texture;
SamplerState _texture_SS;
PIX_OUTPUT pix(in VERT_OUTPUT input) : SV_TARGET
{
    float4 ret = _texture.Sample(_texture_SS, input.uv) * input.color;
    float luminance = dot(ret.rgb, float3(0.299, 0.587, 0.114));
    ret.rgb = lerp(luminance, ret.rgb, 1.08);
    return ret;
}
`);
        expect(glsl.ok).toBe(true);
        expect(glsl.glsl).toContain('vec3 lerp_(float a, vec3 b, float t)');
        expect(glsl.glsl).toContain('float lerp_(float a, float b, float t)');
    });

    it('covers HLSL scalar promotion in pow calls (the thruster plume pattern)', () => {
        // `pow(col2, 1.85)` promotes the scalar exponent to match a float4 base in HLSL; GLSL's `pow`
        // has only the all-matching-type overload, so it fails to compile without a helper.
        const glsl = translateToGlsl(`
typedef float4 PIX_OUTPUT;
struct VERT_OUTPUT { float2 uv : TEXCOORD0; float4 color : COLOR0; };
Texture2D _texture;
SamplerState _texture_SS;
PIX_OUTPUT pix(in VERT_OUTPUT input) : SV_TARGET
{
    float4 col2 = _texture.Sample(_texture_SS, input.uv) * input.color;
    col2 = saturate(pow(col2, 1.85));
    return col2;
}
`);
        expect(glsl.ok).toBe(true);
        expect(glsl.glsl).toContain('vec4 pow_(vec4 x, float y)');
        expect(glsl.glsl).toContain('pow_(col2, 1.85)');
    });

    it('expands default parameter values into arity overloads (the SW plume-light pattern)', () => {
        // base.shader declares `multiplyAdditiveLightValue(…, float nrmlStrengthLimit = 1.0)`. GLSL
        // forbids parameter initializers, so the definition loses them and a forwarding overload per
        // omitted trailing suffix covers call sites that rely on the default.
        const glsl = translateToGlsl(`
typedef float4 PIX_OUTPUT;
struct VERT_OUTPUT { float2 uv : TEXCOORD0; float4 color : COLOR0; };
float3 lightValue(inout float3 color, float2 uv, float strengthLimit = 1.0)
{
    color *= min(uv.x, strengthLimit);
    return color;
}
PIX_OUTPUT pix(in VERT_OUTPUT input) : SV_TARGET
{
    float3 a = input.color.rgb;
    float3 b = input.color.rgb;
    lightValue(a, input.uv);
    lightValue(b, input.uv, 0.5);
    return float4(a + b, 1);
}
`);
        expect(glsl.ok).toBe(true);
        expect(glsl.glsl).not.toMatch(/=[^;{]*\)\s*\r?\n?\s*\{/);
        expect(glsl.glsl).toContain('vec3 lightValue(inout vec3 color, vec2 uv, float strengthLimit)');
        expect(glsl.glsl).toContain(
            'vec3 lightValue(inout vec3 color, vec2 uv) { return lightValue(color, uv, 1.0); }'
        );
    });

    it('keeps helpers called only by an overload-shadowed definition (the default-param DCE trap)', () => {
        // `scale` has two definitions after default expansion (the full one and the arity overload).
        // Reachability must scan every same-named body, or `helper` (called only from the full
        // definition) would be pruned while its call survives.
        const glsl = translateToGlsl(`
typedef float4 PIX_OUTPUT;
struct VERT_OUTPUT { float2 uv : TEXCOORD0; float4 color : COLOR0; };
float helper(float x) { return x * 2; }
float scale(float a, float b = 1.0) { return helper(a) * b; }
PIX_OUTPUT pix(in VERT_OUTPUT input) : SV_TARGET
{
    return float4(scale(input.uv.x), 0, 0, 1);
}
`);
        expect(glsl.ok).toBe(true);
        expect(glsl.glsl).toContain('float helper(float x)');
    });

    it('lowers sincos statements into sin and cos assignments', () => {
        const glsl = translateToGlsl(`
typedef float4 PIX_OUTPUT;
struct VERT_OUTPUT { float2 uv : TEXCOORD0; float4 color : COLOR0; };
PIX_OUTPUT pix(in VERT_OUTPUT input) : SV_TARGET
{
    float2 dir;
    sincos(input.uv.x, dir.y, dir.x);
    return float4(dir, 0, 1);
}
`);
        expect(glsl.ok).toBe(true);
        expect(glsl.glsl).not.toContain('sincos');
        expect(glsl.glsl).toContain('dir.y = sin(vsIn.uv.x); dir.x = cos(vsIn.uv.x);');
    });

    it('builds a vertex stage for a shader defining its own vert (the point-light pattern)', () => {
        const glsl = translateToGlsl(`
typedef float4 PIX_OUTPUT;
struct VERT_INPUT { float4 location : POSITION; float4 color : COLOR0; float2 uv : TEXCOORD0; };
struct VERT_OUTPUT_LIGHT { float4 location : SV_POSITION; float4 color : COLOR0; float2 uv : TEXCOORD0; float2 uv2 : TEXCOORD1; };
float4x4 _transform;
float4 _color;
VERT_OUTPUT_LIGHT vert(in VERT_INPUT input)
{
    VERT_OUTPUT_LIGHT output;
    output.location = mul(input.location, _transform);
    output.color = input.color * _color;
    output.uv = input.uv;
    output.uv2.x = (output.location.x + 1) / 2;
    output.uv2.y = (output.location.y - 1) / -2;
    return output;
}
PIX_OUTPUT pix(in VERT_OUTPUT_LIGHT input) : SV_TARGET
{
    return input.color * float4(input.uv, input.uv2.x, 1);
}
`);
        expect(glsl.ok).toBe(true);
        expect(glsl.vertex).toBeDefined();
        expect(glsl.vertex!.kind).toBe('sprite');
        // The vertex stage synthesizes the input from the quad, runs the real vert, and forwards
        // every output field as a varying; the fragment main reads those varyings.
        expect(glsl.vertex!.glsl).toContain('attribute vec2 aPos');
        expect(glsl.vertex!.glsl).toContain('vin.location = vec4(aPos * 50.0, 0.0, 1.0);');
        expect(glsl.vertex!.glsl).toContain('vOut_uv2 = vout.uv2;');
        expect(glsl.vertex!.glsl).toContain('gl_Position = vout.location;');
        expect(glsl.vertex!.fragment).toContain('vsIn.uv2 = vOut_uv2;');
        // The plain fragment path is still produced for the fallback.
        expect(glsl.glsl).toContain('void main');
    });

    it('skips the vertex stage when vert inputs cannot be synthesized or structs mismatch', () => {
        // `velocity` has no quad stand-in, so the preview must keep the generic stand-in path.
        const glsl = translateToGlsl(`
typedef float4 PIX_OUTPUT;
struct VERT_INPUT_X { float4 location : POSITION; float3 velocity : POSITION1; };
struct VERT_OUTPUT { float4 location : SV_POSITION; float4 color : COLOR0; float2 uv : TEXCOORD0; };
VERT_OUTPUT vert(in VERT_INPUT_X input)
{
    VERT_OUTPUT output;
    output.location = input.location;
    output.color = float4(input.velocity, 1);
    output.uv = input.location.xy;
    return output;
}
PIX_OUTPUT pix(in VERT_OUTPUT input) : SV_TARGET
{
    return input.color;
}
`);
        expect(glsl.ok).toBe(true);
        expect(glsl.vertex).toBeUndefined();
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
            // Feature-level-gated shaders whose rich branch (the one the game renders on a modern GPU)
            // only appears with the preview defines, and whose pix structs re-type shared field names
            // (nebula's worldLoc is a float2, particles use a float4).
            'nebulas/nebula.shader',
            'planets/planet.shader',
            'planets/waves.shader',
            'statuses/fire/particles/fire.shader',
            // Exercises HLSL scalar promotion in `pow` (`pow(col2, 1.85)` with `col2` a float4), which
            // GLSL's `pow` has no overload for.
            'ships/terran/thruster_small/particles/thruster_plume.shader',
        ];
        for (const rel of shaders) {
            const path = join(DATA_DIR, rel);
            if (!existsSync(path)) continue;
            // default.shader pre-defines the entry guards, the rest define pix directly. The preview's
            // feature-level defines are always on, the way the engine compiles on a modern GPU.
            const guards = rel === 'default.shader' ? ['USE_DEFAULT_PIX', 'USE_DEFAULT_VERT'] : [];
            const expanded = await expandShaderSource(path, [...guards, ...PREVIEW_SHADER_DEFINES], DATA_DIR);
            const result = translateToGlsl(expanded);
            expect(result.ok, `${rel}: ${result.reason}`).toBe(true);
            expect(hasHlslLeftovers(result.glsl!), `${rel} has HLSL leftovers`).toBe(false);
            expect(result.glsl).toContain('void main');
        }
    });

    it('resolves #if defined(…) chains the way crew_lit gates its animated UVs', async () => {
        // crew_lit.shader opens with `#if defined(GTE_PS_4_0) || defined(GTE_VS_4_0)`. The expansion
        // must evaluate the condition (not skip it) so the guarded define lands exactly when a branch
        // is truly active, and `#elif`/`#else` pick the right alternative.
        const { writeFile, mkdtemp, rm } = await import('fs/promises');
        const { tmpdir } = await import('os');
        const dir = await mkdtemp(join(tmpdir(), 'shader-if-'));
        const path = join(dir, 'cond.shader');
        try {
            await writeFile(
                path,
                [
                    '#if defined(GTE_PS_4_0) || defined(NEVER_DEFINED)',
                    '#define TAKEN_OR',
                    '#endif',
                    '#if defined(NEVER_DEFINED) && defined(GTE_PS_4_0)',
                    'float wrongAnd;',
                    '#elif defined(GTE_PS_4_0)',
                    'float takenElif;',
                    '#else',
                    'float wrongElse;',
                    '#endif',
                    '#if !defined(NEVER_DEFINED)',
                    'float takenNot;',
                    '#endif',
                    '#ifdef TAKEN_OR',
                    'float sawGuardedDefine;',
                    '#endif',
                ].join('\n')
            );
            const expanded = await expandShaderSource(path, [...PREVIEW_SHADER_DEFINES]);
            expect(expanded).toContain('takenElif');
            expect(expanded).toContain('takenNot');
            expect(expanded).toContain('sawGuardedDefine');
            expect(expanded).not.toContain('wrongAnd');
            expect(expanded).not.toContain('wrongElse');
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('lowers the HLSL % operator with multiplicative-chain precedence (the crew drop-shadow pattern)', () => {
        const glsl = translateToGlsl(`
typedef float4 PIX_OUTPUT;
struct VERT_OUTPUT { float2 uv : TEXCOORD0; float4 color : COLOR0; };
float _time;
PIX_OUTPUT pix(in VERT_OUTPUT input) : SV_TARGET
{
    float2 spriteUV = abs(input.uv - 0.25) / 0.5 % 1;
    float cycle = _time % 3.5;
    return float4(spriteUV, cycle, 1);
}
`);
        expect(glsl.ok).toBe(true);
        // `a / b % 1` binds the whole multiplicative chain as the left operand, like HLSL.
        expect(glsl.glsl).toContain('pvMod(abs(vsIn.uv - 0.25) / 0.5, 1.0)');
        expect(glsl.glsl).toContain('pvMod(_time, 3.5)');
        expect(glsl.glsl).not.toContain('%');
    });

    it('lowers int locals, int casts of calls, and isinf (the atlas animation pattern)', () => {
        const glsl = translateToGlsl(`
typedef float4 PIX_OUTPUT;
struct VERT_OUTPUT { float2 uv : TEXCOORD0; float4 color : COLOR0; };
float wrap(float val, float interval) { return frac(val / interval) * interval; }
float _gameTime;
PIX_OUTPUT pix(in VERT_OUTPUT input) : SV_TARGET
{
    int frame;
    if (isinf(input.uv.x))
        frame = (int)min(input.uv.y, 3);
    else
        frame = (int)wrap(_gameTime, 4);
    int framesPerRow = (int)input.uv.y;
    int col = frame % framesPerRow;
    int row = frame / framesPerRow;
    return float4(col, row, 0, 1);
}
`);
        expect(glsl.ok).toBe(true);
        // int locals become floored floats so mixed arithmetic stays legal and truncation survives.
        expect(glsl.glsl).toContain('float frame;');
        expect(glsl.glsl).toContain('frame = floor(min(vsIn.uv.y, 3.0))');
        expect(glsl.glsl).toContain('frame = floor(wrap(_gameTime, 4.0))');
        expect(glsl.glsl).toContain('float col = floor(pvMod(frame, framesPerRow));');
        expect(glsl.glsl).toContain('float row = floor(frame / framesPerRow);');
        expect(glsl.glsl).toContain('pvIsInf(vsIn.uv.x)');
        expect(hasHlslLeftovers(glsl.glsl!)).toBe(false);
    });

    it.runIf(HAVE_DATA)('translates crew_lit with its drop shadow and builds the crew vertex stage', async () => {
        const expanded = await expandShaderSource(
            join(DATA_DIR, 'crew/crew_lit.shader'),
            [...PREVIEW_SHADER_DEFINES],
            DATA_DIR
        );
        const result = translateToGlsl(expanded);
        expect(result.ok, result.reason).toBe(true);
        expect(hasHlslLeftovers(result.glsl!), 'crew_lit has HLSL leftovers').toBe(false);
        // The GTE_PS_4_0 drop-shadow branch is active and its float modulo is lowered.
        expect(result.glsl).toContain('pvMod(');
        // The crew vert is synthesizable: its inputs (including the nested animation struct) all have
        // stand-ins, and the interpolation modifiers on the outputs are stripped.
        expect(result.vertex).toBeDefined();
        expect(result.vertex!.kind).toBe('crew');
        expect(result.vertex!.glsl).toContain('vin.animInfo.uv =');
        expect(result.vertex!.glsl).toContain('vin.shirtColor =');
        expect(result.vertex!.glsl).toContain('vin.vertexOffset = aPos * 0.5;');
        expect(result.vertex!.fragment).not.toContain('nointerpolation');
    });

    it.runIf(HAVE_DATA)('builds a shipPart vertex stage for the atlas default vert (roof_light)', async () => {
        const expanded = await expandShaderSource(
            join(DATA_DIR, 'ships/common/roof_light.shader'),
            [...PREVIEW_SHADER_DEFINES],
            DATA_DIR
        );
        const result = translateToGlsl(expanded);
        expect(result.ok, result.reason).toBe(true);
        expect(result.vertex).toBeDefined();
        expect(result.vertex!.kind).toBe('shipPart');
        // The nested animation block is initialized field by field for the real atlas vert to read.
        expect(result.vertex!.glsl).toContain('vin.animInfo.animationFrames = vec2(1.0, 1.0);');
        expect(result.vertex!.glsl).toContain('vin.rotateAround = vec4(0.0, 0.0, 0.0, 1.0);');
        expect(hasHlslLeftovers(result.vertex!.glsl), 'atlas vertex stage has HLSL leftovers').toBe(false);
        expect(hasHlslLeftovers(result.vertex!.fragment), 'atlas fragment has HLSL leftovers').toBe(false);
    });

    it.runIf(HAVE_DATA)('builds a type-correct main for the nebula pix struct (vec2 worldLoc)', async () => {
        const expanded = await expandShaderSource(
            join(DATA_DIR, 'nebulas/nebula.shader'),
            [...PREVIEW_SHADER_DEFINES],
            DATA_DIR
        );
        const result = translateToGlsl(expanded);
        expect(result.ok).toBe(true);
        // The stand-in must match the declared field type: nebula's worldLoc is a float2 of world
        // units, so it gets the scaled vUv, not the vec4 form the particle shaders use.
        expect(result.glsl).toContain('vsIn.worldLoc = vUv * 100.0;');
        expect(result.glsl).toContain('vsIn.unexploredUV = vUv;');
        // The rich feature-level branch is active (the low-end branch has no scrolling function).
        expect(result.glsl).toContain('CreateNebulaBaseScrolling');
    });
});
