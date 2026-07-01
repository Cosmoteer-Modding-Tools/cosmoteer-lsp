import { describe, expect, it } from 'vitest';
import { SymbolKind } from 'vscode-languageserver';
import { shaderDocumentSymbols, shaderSymbolDefinition } from '../../../src/features/shader/shader-document-features';
import { findShaderDeclaration } from '../../../src/features/shader/shader-index';
import { parseShader } from '../../../src/features/shader/shader-parser';

const SRC = [
    'cbuffer perFrame {',
    '    float _glow;',
    '}',
    'Texture2D _noiseTex;',
    'float3 tint(float3 c) {',
    '    return c * _glow;',
    '}',
    'float4 pix() {',
    '    return float4(tint(_noiseTex.Sample(s, uv).rgb), 1);',
    '}',
].join('\n');

describe('shader declaration positions', () => {
    it('records the line and column of each uniform', () => {
        const glow = parseShader(SRC).constants.find((c) => c.name === '_glow');
        expect(glow?.position?.line).toBe(1);
        expect(glow?.position?.column).toBe(SRC.split('\n')[1].indexOf('_glow'));
    });

    it('records the line and column of each function name', () => {
        const tint = parseShader(SRC).functionDecls.find((f) => f.name === 'tint');
        expect(tint?.position.line).toBe(4);
        expect(tint?.position.column).toBe(SRC.split('\n')[4].indexOf('tint'));
    });
});

describe('shader document symbols', () => {
    it('lists the file uniforms and functions with their kinds', () => {
        const symbols = shaderDocumentSymbols(SRC);
        const byName = new Map(symbols.map((s) => [s.name, s]));
        expect(byName.get('_glow')?.kind).toBe(SymbolKind.Constant);
        expect(byName.get('_glow')?.detail).toBe('float');
        expect(byName.get('_noiseTex')?.detail).toBe('Texture2D');
        expect(byName.get('tint')?.kind).toBe(SymbolKind.Function);
        expect(byName.get('pix')?.kind).toBe(SymbolKind.Function);
    });
});

describe('shader go-to-definition', () => {
    const uri = 'file:///c:/proj/main.shader';

    it('resolves a uniform under the cursor to its declaration line', async () => {
        const offset = SRC.indexOf('_glow', SRC.indexOf('return c')); // the use inside tint(), not the declaration
        const location = await shaderSymbolDefinition(SRC, offset, uri);
        expect(location?.range.start.line).toBe(1);
    });

    it('resolves a called function to its definition line', async () => {
        const offset = SRC.indexOf('tint(_noiseTex'); // the call site inside pix()
        const location = await shaderSymbolDefinition(SRC, offset, uri);
        expect(location?.range.start.line).toBe(4);
    });

    it('returns null on a texture method (a member after a dot)', async () => {
        const offset = SRC.indexOf('Sample');
        expect(await shaderSymbolDefinition(SRC, offset, uri)).toBeNull();
    });

    it('returns null on an intrinsic or keyword', async () => {
        expect(await shaderSymbolDefinition(SRC, SRC.indexOf('return'), uri)).toBeNull();
    });

    it('follows the #include chain to a uniform declared in a base shader', async () => {
        const files: Record<string, string> = { 'base.shader': 'float4 _fromBase;\n' };
        const override = (p: string): string | undefined => files[p.replace(/\\/g, '/').split('/').pop() ?? ''];
        const main = '#include "base.shader"\nfloat4 pix() { return _fromBase; }';
        const found = await findShaderDeclaration(main, 'C:/proj/main.shader', '_fromBase', 'C:/data', override);
        expect(found?.path.replace(/\\/g, '/')).toContain('base.shader');
        expect(found?.line).toBe(0);
    });
});
