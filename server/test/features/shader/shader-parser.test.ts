import { describe, expect, it } from 'vitest';
import { existsSync } from 'fs';
import { join } from 'path';
import { parseShader } from '../../../src/features/shader/shader-parser';
import { clearShaderCache, shaderConstants } from '../../../src/features/shader/shader-index';

const DATA_DIR =
    process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const HAVE_DATA = existsSync(DATA_DIR);

describe('shader HLSL scanner', () => {
    it('extracts file-scope uniforms, skips locals and struct members', () => {
        const src = `
#include "base.shader"
struct VERT_INPUT { float4 location : POSITION; float2 _notAUniform : TEXCOORD0; };
cbuffer perFrame
{
    float2 _screenSize;
    float _time;
}
float4x4 _transform;
Texture2D _noiseTexture;
SamplerState _noiseTexture_SS;
float4 _centerColor = 255;
float _z = 0.2;
float pix(in float2 uv) {
    float _localVar = 1.0; // must be ignored
    return _z;
}
`;
        const parsed = parseShader(src);
        expect(parsed.includes).toEqual(['base.shader']);
        expect(parsed.functions).toContain('pix');
        const names = parsed.constants.map((c) => c.name);
        // cbuffer members + file-scope uniforms are captured.
        expect(names).toEqual(
            expect.arrayContaining(['_screenSize', '_time', '_transform', '_noiseTexture', '_centerColor', '_z'])
        );
        // struct members and function locals are not.
        expect(names).not.toContain('_notAUniform');
        expect(names).not.toContain('_localVar');
        // kinds + defaults.
        expect(parsed.constants.find((c) => c.name === '_z')).toMatchObject({ kind: 'float', default: '0.2' });
        expect(parsed.constants.find((c) => c.name === '_centerColor')).toMatchObject({ kind: 'vec4' });
        expect(parsed.constants.find((c) => c.name === '_transform')).toMatchObject({ kind: 'matrix' });
    });

    it.runIf(HAVE_DATA)('resolves a real shader to its settable constants, dropping engine-bound ones', async () => {
        clearShaderCache();
        const path = join(DATA_DIR, 'common_effects/particles/particle_light_emissive.shader');
        const constants = await shaderConstants(path);
        const names = constants.map((c) => c.name);
        // These are the user-set constants seen in explode_sparks_def.rules.
        expect(names).toEqual(
            expect.arrayContaining(['_z', '_litReflectiveStrength', '_litAdditiveStrength', '_unlitAdditiveStrength'])
        );
        // Engine-bound built-ins from base.shader must be filtered out.
        expect(names).not.toContain('_time');
        expect(names).not.toContain('_transform');
        expect(names).not.toContain('_screenSize');
        expect(names).not.toContain('_color');
        // Samplers are never offered.
        expect(names.every((n) => !n.endsWith('_SS'))).toBe(true);
    });
});
