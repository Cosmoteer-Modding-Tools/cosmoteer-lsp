import { describe, expect, it } from 'vitest';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';

// While folding a math chain, an operator can be followed by input that `walk` recovers as an
// Assignment (`Y = 2`), and an Assignment node carries no own `position`. Reading
// `operand.position.end` then threw "Cannot read properties of undefined", taking down every
// request that parses the file (documentSymbol, hover, …). The malformed operand must be tolerated.
const parse = (src: string) => parser(lexer(src), 'file:///t.rules');

describe('math chain with an assignment operand', () => {
    it('does not throw when a math operand recovers as an assignment', () => {
        expect(() => parse('X = 1 + Y = 2')).not.toThrow();
    });

    it('does not throw for the same shape nested inside a group', () => {
        expect(() => parse('A\n{\n\tX = 1 + Y = 2\n}')).not.toThrow();
    });

    it('still produces a document with the leading field', () => {
        const result = parse('X = 1 + Y = 2');
        expect(result.value.elements.length).toBeGreaterThan(0);
    });
});
