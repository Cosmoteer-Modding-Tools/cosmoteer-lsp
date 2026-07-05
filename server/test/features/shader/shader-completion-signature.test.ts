import { describe, expect, it } from 'vitest';
import { shaderCompletions } from '../../../src/features/shader/shader-completion';
import { shaderSignatureHelp } from '../../../src/features/shader/shader-signature';
import { collectIncludeText } from '../../../src/features/shader/shader-index';

const SRC = ['cbuffer c {', '    float _glow;', '}', 'float4 pix() {', '    return lerp(0.0, _glow, 0.5);', '}'].join('\n');
// The whole-file (non-member) completion set is what you get at a position not after a `.`.
const globalLabels = (src: string): string[] => shaderCompletions(src, src.length).map((c) => c.label);

describe('shader completion', () => {
    it('offers HLSL intrinsics, types and keywords', () => {
        const labels = globalLabels(SRC);
        expect(labels).toContain('lerp');
        expect(labels).toContain('float4');
        expect(labels).toContain('return');
    });

    it('offers the file-scope uniforms and functions it declares', () => {
        const labels = globalLabels(SRC);
        expect(labels).toContain('_glow');
        expect(labels).toContain('pix');
    });

    it('offers engine uniforms declared in an include (e.g. _texture, _time)', () => {
        const labels = globalLabels(SRC);
        expect(labels).toContain('_texture');
        expect(labels).toContain('_time');
        const texture = shaderCompletions(SRC, SRC.length).find((c) => c.label === '_texture');
        expect(texture?.detail).toBe('Texture2D (engine uniform)');
    });

    it('gives an intrinsic its signature as detail', () => {
        const lerp = shaderCompletions(SRC, SRC.length).find((c) => c.label === 'lerp');
        expect(lerp?.detail).toBe('lerp(a, b, s)');
    });

    it('does not duplicate a label', () => {
        const labels = globalLabels(SRC);
        expect(labels.length).toBe(new Set(labels).size);
    });
});

/** Completion items at the cursor placed right after the `.` in the first occurrence of `marker`. */
const itemsAfterDot = (src: string, marker: string): ReturnType<typeof shaderCompletions> =>
    shaderCompletions(src, src.indexOf(marker) + marker.length);
const afterDot = (src: string, marker: string): string[] => itemsAfterDot(src, marker).map((c) => c.label);

describe('context-aware member completion', () => {
    it('offers vector swizzles limited to the component count, not the global set', () => {
        const src = 'float4 pix() {\n    float3 color = float3(1,0,0);\n    return color.;\n}';
        const labels = afterDot(src, 'color.');
        expect(labels).toEqual(expect.arrayContaining(['x', 'y', 'z', 'r', 'g', 'b', 'xyz', 'rgb']));
        expect(labels).not.toContain('w'); // a float3 has no 4th channel
        expect(labels).not.toContain('lerp'); // member context excludes the global builtins
    });

    it('shows the resulting type and an explanation on each swizzle', () => {
        const src = 'float4 pix() {\n    float4 color = float4(1,0,0,1);\n    return color.;\n}';
        const items = itemsAfterDot(src, 'color.');
        expect(items.find((c) => c.label === 'x')?.detail).toBe('float'); // a single channel is a scalar
        expect(items.find((c) => c.label === 'xyz')?.detail).toBe('float3'); // three channels → float3
        expect(String(items.find((c) => c.label === 'xyz')?.documentation)).toContain('x, y, z');
    });

    it('shows integer swizzle types for an int vector', () => {
        const src = 'void f() {\n    int2 coord = int2(0,0);\n    coord.;\n}';
        expect(itemsAfterDot(src, 'coord.').find((c) => c.label === 'xy')?.detail).toBe('int2');
    });

    it('offers texture methods for the engine `_texture` even though it is not declared in the file', () => {
        const src = 'float4 pix() {\n    return _texture.;\n}';
        const labels = afterDot(src, '_texture.');
        expect(labels).toEqual(expect.arrayContaining(['Sample', 'SampleLevel', 'GetDimensions']));
        expect(labels).not.toContain('x');
    });

    it('offers texture sampling methods with return type and explanation', () => {
        const src = 'Texture2D _noiseTex;\nfloat4 pix() {\n    return _noiseTex.;\n}';
        const items = itemsAfterDot(src, '_noiseTex.');
        expect(items.map((c) => c.label)).toEqual(expect.arrayContaining(['Sample', 'SampleLevel', 'GetDimensions']));
        expect(items.map((c) => c.label)).not.toContain('x');
        const sample = items.find((c) => c.label === 'Sample');
        expect(sample?.detail).toBe('float4 Sample(sampler, uv)');
        expect(String(sample?.documentation)).toContain('Sample the texture');
        expect(items.find((c) => c.label === 'GetDimensions')?.detail).toBe('void GetDimensions(out width, out height)');
    });

    it('offers struct members with their types and an explanation', () => {
        const src =
            'struct VERT_INPUT { float4 location : POSITION; float2 uv : TEXCOORD0; };\n' +
            'float4 pix(in VERT_INPUT input) {\n    return input.;\n}';
        const items = itemsAfterDot(src, 'input.');
        expect(items.map((c) => c.label)).toEqual(expect.arrayContaining(['location', 'uv']));
        expect(items.map((c) => c.label)).not.toContain('lerp');
        expect(items.find((c) => c.label === 'uv')?.detail).toBe('float2');
        expect(String(items.find((c) => c.label === 'location')?.documentation)).toContain('VERT_INPUT');
    });

    it('falls back to the full swizzle set for an unknown base type', () => {
        const src = 'float4 pix() {\n    return foo.;\n}';
        const labels = afterDot(src, 'foo.');
        expect(labels).toEqual(expect.arrayContaining(['x', 'y', 'z', 'w']));
    });
});

describe('include-aware completion', () => {
    // A custom base shader the edited file `#include`s, passed as the concatenated include scope.
    const BASE = 'float4 _myShared;\nTexture2D _customTex;\nstruct MYV { float2 uv : TEXCOORD0; float4 pos : POSITION; };';

    it('offers uniforms declared in an included base shader', () => {
        const src = 'float4 pix() {\n    return _myShared;\n}';
        const labels = shaderCompletions(src, src.length, BASE).map((c) => c.label);
        expect(labels).toContain('_myShared');
        expect(labels).toContain('_customTex');
    });

    it('resolves a texture uniform from an include to its methods after a `.`', () => {
        const src = 'float4 pix() {\n    return _customTex.;\n}';
        const offset = src.indexOf('_customTex.') + '_customTex.'.length;
        const labels = shaderCompletions(src, offset, BASE).map((c) => c.label);
        expect(labels).toEqual(expect.arrayContaining(['Sample', 'SampleLevel']));
        expect(labels).not.toContain('x');
    });

    it('resolves a struct type defined in an include for a local of that type', () => {
        const src = 'float4 pix(in MYV v) {\n    return v.;\n}';
        const offset = src.indexOf('v.') + 2;
        const labels = shaderCompletions(src, offset, BASE).map((c) => c.label);
        expect(labels).toEqual(expect.arrayContaining(['uv', 'pos']));
    });

    it('collectIncludeText follows the #include chain via the read override', async () => {
        // The override supplies each included file's text by path, so no disk access is needed.
        const files: Record<string, string> = {
            'base.shader': '#include "colors.shader"\nfloat4 _fromBase;',
            'colors.shader': 'float3 _fromColors;',
        };
        const override = (p: string): string | undefined => {
            const name = p.replace(/\\/g, '/').split('/').pop() ?? '';
            return files[name];
        };
        const text = await collectIncludeText('#include "base.shader"', 'C:/proj/main.shader', 'C:/data', override);
        // Both the direct include and its transitive include are collected.
        expect(text).toContain('_fromBase');
        expect(text).toContain('_fromColors');
    });
});

describe('shader signature help', () => {
    it('shows the intrinsic signature and highlights the active argument', () => {
        // Offset just after the second comma inside `lerp(0.0, _glow, `.
        const offset = SRC.indexOf('0.5');
        const help = shaderSignatureHelp(SRC, offset);
        expect(help?.signatures[0].label).toBe('lerp(a, b, s)');
        expect(help?.activeParameter).toBe(2);
    });

    it('returns null when the cursor is not inside a known intrinsic call', () => {
        const offset = SRC.indexOf('cbuffer');
        expect(shaderSignatureHelp(SRC, offset)).toBeNull();
    });

    it('shows a file function`s own signature with its return type and typed params', () => {
        const src =
            'float4 loadRawNormals(float2 uv, float scale) { return float4(uv, scale, 1); }\n' +
            'float4 pix() { return loadRawNormals(0.5, 2.0); }';
        const offset = src.indexOf('2.0'); // inside the second argument
        const help = shaderSignatureHelp(src, offset);
        expect(help?.signatures[0].label).toBe('float4 loadRawNormals(float2 uv, float scale)');
        expect(help?.activeParameter).toBe(1);
    });

    it('shows the signature of a function defined in an include', () => {
        const base = 'float3 applyTint(float3 c, float amount) { return c * amount; }';
        const src = 'float4 pix() { return float4(applyTint(_color.rgb, 0.5), 1); }';
        const offset = src.indexOf('_color'); // inside applyTint(...)
        const help = shaderSignatureHelp(src, offset, base);
        expect(help?.signatures[0].label).toBe('float3 applyTint(float3 c, float amount)');
        expect(help?.activeParameter).toBe(0);
    });
});

describe('in-scope local and parameter completion', () => {
    it('offers the enclosing function`s parameters (e.g. `input`)', () => {
        const src = 'float4 pix(in VERT_INPUT input, float2 uv) {\n    return \n}';
        const offset = src.indexOf('return ') + 'return '.length;
        const items = shaderCompletions(src, offset);
        const byName = new Map(items.map((c) => [c.label, c]));
        expect(byName.get('input')?.detail).toBe('VERT_INPUT (parameter)');
        expect(byName.get('uv')?.detail).toBe('float2 (parameter)');
    });

    it('offers locals declared in the body before the cursor', () => {
        const src = 'float4 pix() {\n    float3 color = float3(1, 0, 0);\n    float alpha = 1.0;\n    return \n}';
        const offset = src.indexOf('return ') + 'return '.length;
        const labels = shaderCompletions(src, offset).map((c) => c.label);
        expect(labels).toContain('color');
        expect(labels).toContain('alpha');
    });

    it('does not offer locals of a different function', () => {
        const src = 'float3 helper() {\n    float3 secret = float3(0, 0, 0);\n    return secret;\n}\nfloat4 pix() {\n    return \n}';
        const offset = src.lastIndexOf('return ') + 'return '.length;
        const labels = shaderCompletions(src, offset).map((c) => c.label);
        expect(labels).not.toContain('secret');
    });

    it('still offers the builtins and uniforms alongside the locals', () => {
        const src = 'float _glow;\nfloat4 pix(float2 uv) {\n    return \n}';
        const offset = src.indexOf('return ') + 'return '.length;
        const labels = shaderCompletions(src, offset).map((c) => c.label);
        expect(labels).toEqual(expect.arrayContaining(['uv', '_glow', 'lerp', 'float4']));
    });
});

describe('declaration-name completion suppression', () => {
    it('offers nothing while typing the name of a new variable after a type', () => {
        const src = 'float4 pix() {\n    float x\n}';
        const offset = src.indexOf('float x') + 'float x'.length;
        expect(shaderCompletions(src, offset)).toEqual([]);
    });

    it('offers nothing right after a type and a space (empty name)', () => {
        const src = 'float4 pix() {\n    float3 \n}';
        const offset = src.indexOf('float3 ') + 'float3 '.length;
        expect(shaderCompletions(src, offset)).toEqual([]);
    });

    it('suppresses inside a parameter list when naming a parameter', () => {
        const src = 'float4 pix(float2 uv';
        expect(shaderCompletions(src, src.length)).toEqual([]);
    });

    it('still completes in an initializer on the right of `=`', () => {
        const src = 'float4 pix() {\n    float x = l\n}';
        const offset = src.indexOf('= l') + '= l'.length;
        expect(shaderCompletions(src, offset).map((c) => c.label)).toContain('lerp');
    });
});
