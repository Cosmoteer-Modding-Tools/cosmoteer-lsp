import { describe, expect, it } from 'vitest';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { buildSemanticTokens } from '../../../src/features/semantic/semantic-tokens.service';
import { semanticTokensLegend } from '../../../src/features/semantic/legend';

/** A semantic token decoded back from the delta-encoded LSP stream, with its type/modifier names. */
interface DecodedToken {
    line: number;
    char: number;
    length: number;
    type: string;
    modifiers: string[];
}

/** Decode the delta-encoded `data` array into absolute tokens with their legend names. */
const decode = (source: string): DecodedToken[] => {
    const parsed = parser(lexer(source), 'file:///test.rules');
    const { data } = buildSemanticTokens(parsed.value);
    const tokens: DecodedToken[] = [];
    let line = 0;
    let char = 0;
    for (let i = 0; i < data.length; i += 5) {
        const deltaLine = data[i];
        const deltaChar = data[i + 1];
        line += deltaLine;
        char = deltaLine === 0 ? char + deltaChar : deltaChar;
        const modifiersBits = data[i + 4];
        tokens.push({
            line,
            char,
            length: data[i + 2],
            type: semanticTokensLegend.tokenTypes[data[i + 3]],
            modifiers: semanticTokensLegend.tokenModifiers.filter((_, bit) => (modifiersBits & (1 << bit)) !== 0),
        });
    }
    return tokens;
};

/** Finds the token covering a substring's start offset on a given line. */
const tokenAt = (tokens: DecodedToken[], line: number, char: number): DecodedToken | undefined =>
    tokens.find((t) => t.line === line && t.char <= char && char < t.char + t.length);

describe('semantic tokens for .rules', () => {
    it('classifies a top-level entity name as a declaring type', () => {
        const tokens = decode('Calc\n{\n\tA = 10\n}\n');
        const calc = tokenAt(tokens, 0, 0);
        expect(calc?.type).toBe('type');
        expect(calc?.modifiers).toContain('declaration');
    });

    it('classifies a key as a property and a number value as a number', () => {
        const tokens = decode('Calc\n{\n\tA = 10\n}\n');
        expect(tokenAt(tokens, 2, 1)?.type).toBe('property'); // `A`
        expect(tokenAt(tokens, 2, 5)?.type).toBe('number'); // `10`
    });

    it('classifies a math function call as a function and its reference arg as a variable', () => {
        const tokens = decode('Calc\n{\n\tResult = ceil(&A / 2)\n}\n');
        const ceil = tokenAt(tokens, 2, 10);
        expect(ceil?.type).toBe('function');
        expect(ceil?.modifiers).toContain('defaultLibrary');
        expect(ceil?.length).toBe(4); // only the name, not the parens/args
        // `&A` inside the call resolves to a reference variable.
        expect(tokens.some((t) => t.line === 2 && t.type === 'variable')).toBe(true);
    });

    it('classifies a bareword value as an enum member and a quoted value as a string', () => {
        const tokens = decode('Calc\n{\n\tMode = Add\n\tText = "hi"\n}\n');
        expect(tokenAt(tokens, 2, 8)?.type).toBe('enumMember'); // `Add`
        expect(tokenAt(tokens, 3, 8)?.type).toBe('string'); // `"hi"`
    });

    it('classifies an inheritance base as a type and a nested group key as a property', () => {
        const tokens = decode('Base\n{\n}\nChild : Base\n{\n\tInner\n\t{\n\t\tX = 1\n\t}\n}\n');
        // `Base` after the colon on the Child declaration line.
        const base = tokenAt(tokens, 3, 8);
        expect(base?.type).toBe('type');
        expect(base?.modifiers).not.toContain('declaration');
        // The nested `Inner` group is a field, not a top-level declaration.
        expect(tokenAt(tokens, 5, 1)?.type).toBe('property');
    });

    it('produces a non-empty, position-ordered token stream', () => {
        const tokens = decode('Calc\n{\n\tA = 10\n\tB = &A + 5\n}\n');
        expect(tokens.length).toBeGreaterThan(0);
        for (let i = 1; i < tokens.length; i++) {
            const prev = tokens[i - 1];
            const cur = tokens[i];
            expect(cur.line > prev.line || (cur.line === prev.line && cur.char >= prev.char)).toBe(true);
        }
    });
});
