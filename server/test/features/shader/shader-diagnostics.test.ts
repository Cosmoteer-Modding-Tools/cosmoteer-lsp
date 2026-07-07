import { describe, expect, it } from 'vitest';
import { validateShaderDocument } from '../../../src/features/shader/shader-diagnostics';

/** Validates a self-contained shader (no readable includes) with an optional include-file override. */
const validate = (text: string, override?: (p: string) => string | undefined) =>
    validateShaderDocument(text, 'C:/proj/main.shader', 'C:/data', override);
const messages = async (text: string, override?: (p: string) => string | undefined): Promise<string[]> =>
    (await validate(text, override)).map((d) => d.message as string);

describe('shader diagnostics', () => {
    it('reports nothing on a clean shader', async () => {
        const src = [
            'Texture2D _noiseTex;',
            'float _glow;',
            'float4 pix() {',
            '    float4 col = _noiseTex.Sample(s, uv);',
            '    return lerp(col, _glow, saturate(_time));',
            '}',
        ].join('\n');
        expect(await messages(src)).toEqual([]);
    });

    it('flags a `_`-uniform read that nothing declares', async () => {
        const src = 'float _glow;\nfloat4 pix() { return _gloww * _glow; }';
        const msgs = await messages(src);
        expect(msgs.some((m) => m.includes("'_gloww'"))).toBe(true);
        expect(msgs.some((m) => m.includes("'_glow'"))).toBe(false); // the real one is fine
    });

    it('does not flag a `_`-prefixed local or parameter', async () => {
        const src = 'float4 pix(in float3 _uv) {\n    float _t = _uv.x;\n    return float4(_t, _t, _t, 1);\n}';
        expect(await messages(src)).toEqual([]);
    });

    it('does not flag an engine-provided uniform', async () => {
        const src = 'float4 pix() { return _color * _time; }';
        expect(await messages(src)).toEqual([]);
    });

    it('flags a call to an unknown function but not intrinsics or file functions', async () => {
        const src = 'float3 tint(float3 c) { return c; }\nfloat4 pix() { return float4(tint(doStuff(_time)), 1); }';
        const msgs = await messages(src);
        expect(msgs.some((m) => m.includes("'doStuff'"))).toBe(true);
        expect(msgs.some((m) => m.includes("'tint'"))).toBe(false);
        expect(msgs.some((m) => m.includes("'float4'"))).toBe(false);
    });

    it('flags an #include whose target does not exist', async () => {
        const src = '#include "does_not_exist_12345.shader"\nfloat4 pix() { return _color; }';
        const msgs = await messages(src);
        expect(msgs.some((m) => m.includes('does_not_exist_12345.shader'))).toBe(true);
    });

    it('skips the undeclared checks when an include cannot be read (partial symbol set)', async () => {
        // The include is unresolvable, so `_mystery` might be declared in the file we could not read.
        // Only the unresolvable-include diagnostic should fire, never the undeclared-uniform one.
        const src = '#include "missing.shader"\nfloat4 pix() { return _mystery; }';
        const msgs = await messages(src);
        expect(msgs.some((m) => m.includes('missing.shader'))).toBe(true);
        expect(msgs.some((m) => m.includes('_mystery'))).toBe(false);
    });

    it('accepts a uniform declared in a readable include', async () => {
        const files: Record<string, string> = { 'base.shader': 'float3 _shared;\n' };
        const override = (p: string): string | undefined => files[p.replace(/\\/g, '/').split('/').pop() ?? ''];
        const src = '#include "base.shader"\nfloat4 pix() { return float4(_shared, 1); }';
        expect(await messages(src, override)).toEqual([]);
    });

    it('flags a typo even when a readable include is present', async () => {
        const files: Record<string, string> = { 'base.shader': 'float3 _shared;\n' };
        const override = (p: string): string | undefined => files[p.replace(/\\/g, '/').split('/').pop() ?? ''];
        const src = '#include "base.shader"\nfloat4 pix() { return float4(_shard, 1); }';
        const msgs = await messages(src, override);
        expect(msgs.some((m) => m.includes("'_shard'"))).toBe(true);
    });
});

describe('shader function-argument and return-type checks', () => {
    it('flags a call with the wrong number of arguments', async () => {
        const src = 'float3 blend(float3 a, float3 b) { return a + b; }\nfloat4 pix() { return float4(blend(_color.rgb), 1); }';
        const msgs = await messages(src);
        expect(msgs.some((m) => m.includes("'blend'") && m.includes('2') && m.includes('1'))).toBe(true);
    });

    it('accepts a call with the right number of arguments', async () => {
        const src = 'float3 blend(float3 a, float3 b) { return a + b; }\nfloat4 pix() { return float4(blend(_color.rgb, _color.rgb), 1); }';
        expect(await messages(src)).toEqual([]);
    });

    it('does not argument-check an overloaded function name (ambiguous arity)', async () => {
        const src =
            'float f(float a) { return a; }\n' +
            'float f(float a, float b) { return a + b; }\n' +
            'float4 pix() { float x = f(1); return float4(x); }';
        const msgs = await messages(src);
        expect(msgs.some((m) => m.includes("'f'") && m.includes('argument'))).toBe(false);
    });

    it('flags assigning a float4-returning call to a float (truncation)', async () => {
        const src = 'float4 loadRawNormals(float2 uv) { return float4(uv, 0, 1); }\nfloat4 pix() { float x = loadRawNormals(_screenSize); return float4(x); }';
        const msgs = await messages(src);
        expect(msgs.some((m) => m.includes('float4') && m.includes('float'))).toBe(true);
    });

    it('does not flag assigning a matching return type', async () => {
        const src = 'float3 tint(float3 c) { return c; }\nfloat4 pix() { float3 y = tint(_color.rgb); return float4(y, 1); }';
        expect(await messages(src)).toEqual([]);
    });

    it('does not flag a scalar-returning call splatting into a vector', async () => {
        const src = 'float lum(float3 c) { return c.x; }\nfloat4 pix() { float3 g = lum(_color.rgb); return float4(g, 1); }';
        expect(await messages(src)).toEqual([]);
    });

    it('does not flag when the call is only part of a larger expression', async () => {
        const src = 'float lum(float3 c) { return c.x; }\nfloat4 pix() { float x = lum(_color.rgb) * 2.0; return float4(x); }';
        expect(await messages(src)).toEqual([]);
    });

    it('flags a type used as an assignment target with no variable name', async () => {
        const src = 'float4 pix() { float = _time; return float4(0); }';
        const msgs = await messages(src);
        expect(msgs.some((m) => m.includes('variable name') && m.includes('float'))).toBe(true);
    });
});
