import { describe, expect, it } from 'vitest';
import { buildShaderSemanticTokens } from '../../../src/features/semantic/shader-semantic-tokens';
import { semanticTokensLegend } from '../../../src/features/semantic/legend';

interface DecodedToken {
    line: number;
    char: number;
    length: number;
    type: string;
}

/** Decode the delta-encoded shader token stream into absolute tokens with their legend names. */
const decode = (source: string): DecodedToken[] => {
    const { data } = buildShaderSemanticTokens(source);
    const tokens: DecodedToken[] = [];
    let line = 0;
    let char = 0;
    for (let i = 0; i < data.length; i += 5) {
        const deltaLine = data[i];
        line += deltaLine;
        char = deltaLine === 0 ? char + data[i + 1] : data[i + 1];
        tokens.push({ line, char, length: data[i + 2], type: semanticTokensLegend.tokenTypes[data[i + 3]] });
    }
    return tokens;
};

const at = (tokens: DecodedToken[], line: number, char: number): DecodedToken | undefined =>
    tokens.find((t) => t.line === line && t.char <= char && char < t.char + t.length);

describe('semantic tokens for .shader', () => {
    const src = [
        '#include "base.shader"', // 0
        'cbuffer perFrame {', // 1
        '    float _time;', // 2
        '}', // 3
        'float4 pix(in float2 uv) {', // 4
        '    float _localUse = _time * 2.0;', // 5
        '    return float4(_localUse, 0, 0, 1);', // 6
        '}', // 7
    ].join('\n');

    it('colours a preprocessor directive as a macro', () => {
        expect(at(decode(src), 0, 0)?.type).toBe('macro'); // `#include`
    });

    it('colours an HLSL type as a type', () => {
        expect(at(decode(src), 4, 0)?.type).toBe('type'); // `float4`
    });

    it('colours a `_`-uniform as a variable everywhere it appears', () => {
        const tokens = decode(src);
        expect(at(tokens, 2, 10)?.type).toBe('variable'); // `_time` declaration
        expect(at(tokens, 5, 22)?.type).toBe('variable'); // `_time` use
    });

    it('colours a control keyword as a keyword', () => {
        expect(at(decode(src), 6, 4)?.type).toBe('keyword'); // `return`
    });

    it('colours a called identifier as a function', () => {
        // `pix(` on the definition line.
        expect(at(decode(src), 4, 7)?.type).toBe('function');
    });

    it('does not colour identifiers inside comments or strings', () => {
        const tokens = decode('// _commented\n"_string _time"\nfloat _real;');
        // No token on the comment line or the string line; only `float` and `_real` on line 2.
        expect(tokens.every((t) => t.line === 2)).toBe(true);
    });

    it('produces a position-ordered stream', () => {
        const tokens = decode(src);
        for (let i = 1; i < tokens.length; i++) {
            const prev = tokens[i - 1];
            const cur = tokens[i];
            expect(cur.line > prev.line || (cur.line === prev.line && cur.char >= prev.char)).toBe(true);
        }
    });
});
