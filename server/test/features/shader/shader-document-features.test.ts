import { describe, expect, it } from 'vitest';
import { shaderDocumentHover, shaderDocumentDefinition } from '../../../src/features/shader/shader-document-features';

const SRC = ['cbuffer perFrame {', '    float _myGlow;', '}', 'float4 pix(Texture2D _t) { return lerp(_myGlow, _time, 0.5); }'].join(
    '\n'
);
const offsetOf = (text: string, needle: string): number => text.indexOf(needle);
/** The rendered markdown of a hover at the first occurrence of `needle` (+1 to land inside the word). */
const hoverText = (needle: string): string | null => {
    const hover = shaderDocumentHover(SRC, offsetOf(SRC, needle) + 1);
    return hover ? (hover.contents as { value: string }).value : null;
};

describe('in-shader document features', () => {
    it('hovers a file uniform with its declared type', () => {
        const value = hoverText('_myGlow');
        expect(value).toContain('float _myGlow');
        expect(value).toContain('uniform');
    });

    it('hovers an HLSL intrinsic with its signature and explanation', () => {
        const value = hoverText('lerp');
        expect(value).toContain('lerp(a, b, s)');
        expect(value).toContain('Linear interpolation');
    });

    it('hovers an HLSL type with a description', () => {
        expect(hoverText('float4')).toContain('4-component');
    });

    it('hovers an engine-provided uniform even though it is not declared here', () => {
        expect(hoverText('_time')).toContain('Engine uniform');
    });

    it('hovers a function the file defines', () => {
        expect(hoverText('pix')).toContain('function defined in this shader');
    });

    it('hovers a texture sampling method with its return type and explanation', () => {
        const src = 'Texture2D _t;\nfloat4 f() { return _t.Sample(s, uv); }';
        const hover = shaderDocumentHover(src, src.indexOf('Sample') + 1);
        const value = (hover!.contents as { value: string }).value;
        expect(value).toContain('float4 Sample(sampler, uv)');
        expect(value).toContain('Sample the texture');
    });

    it('hovers a uniform declared in an include, given the include scope', () => {
        const src = 'float4 pix() { return float4(_tint, 1); }';
        const hover = shaderDocumentHover(src, src.indexOf('_tint') + 1, 'float3 _tint;');
        expect((hover!.contents as { value: string }).value).toContain('float3 _tint');
    });

    it('returns null for an ordinary local or keyword', () => {
        expect(hoverText('return')).toBeNull();
    });

    it('returns null for a definition request not on an include', () => {
        expect(shaderDocumentDefinition(SRC, offsetOf(SRC, '_time'), 'file:///x.shader')).toBeNull();
    });

    it('returns null for an include whose target does not exist', () => {
        const src = '#include "does_not_exist_12345.shader"\n';
        const def = shaderDocumentDefinition(src, 12, 'file:///x.shader');
        expect(def).toBeNull();
    });
});

describe('preprocessor macro hover', () => {
    it('explains an engine feature-level macro', async () => {
        const { shaderDocumentHover } = await import('../../../src/features/shader/shader-document-features');
        const src = '#ifdef GTE_PS_4_0_level_9_3\nfloat x;\n#endif';
        const hover = shaderDocumentHover(src, src.indexOf('GTE_PS') + 2);
        expect(hover).not.toBeNull();
        expect(JSON.stringify(hover)).toContain('shader model 4.0 level 9.3 or above');
    });

    it('shows a defined macro with its replacement', async () => {
        const { shaderDocumentHover } = await import('../../../src/features/shader/shader-document-features');
        const src = '#define TEX_SCALE 0.3\nfloat f() { return TEX_SCALE; }';
        const hover = shaderDocumentHover(src, src.lastIndexOf('TEX_SCALE') + 2);
        expect(JSON.stringify(hover)).toContain('#define TEX_SCALE 0.3');
    });

    it('explains a guard tested only by an included base shader', async () => {
        const { shaderDocumentHover } = await import('../../../src/features/shader/shader-document-features');
        const src = '#define ENABLE_STENCIL\n#include "base_atlas.shader"';
        const includeText = '#ifdef ENABLE_STENCIL\nfloat guarded;\n#endif';
        // The macro is defined in the edited file, so the define hover wins.
        const defined = shaderDocumentHover(src, src.indexOf('ENABLE_STENCIL') + 2, includeText);
        expect(JSON.stringify(defined)).toContain('#define ENABLE_STENCIL');
        // A guard never defined anywhere still gets the tested-guard explanation.
        const testedOnly = shaderDocumentHover('#ifdef DISABLE_ANIMATION\n#endif', 9);
        expect(JSON.stringify(testedOnly)).toContain('guard tested');
    });
});
