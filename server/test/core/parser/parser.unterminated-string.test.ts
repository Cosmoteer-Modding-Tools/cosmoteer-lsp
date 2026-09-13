import { describe, expect, it } from 'vitest';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { isGroupNode } from '../../../src/core/ast/ast';

/**
 * Parse a document and hand back both halves of the result.
 *
 * @param text the document source.
 * @returns the parsed document and the errors the parse reported.
 */
const parse = (text: string) => {
    const result = parser(lexer(text), 'file:///probe.rules');
    return { document: result.value, errors: result.parserErrors };
};

// A plain `"…"` ends at its line break in the game's tokenizer, which reports the missing quote
// there. Reading on used to hand the rest of the file to one string: typing an opening quote in
// front of a word that was already there swallowed everything below it, and the file filled with
// errors nowhere near the edit.
describe('a string with no closing quote', () => {
    const source = 'Part\n{\n\tName = "Big Gun\n\tMaxHealth = 100\n\tDensity = 2\n}\n';

    it('is reported once, on the line it was opened on', () => {
        const { errors } = parse(source);
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toMatch(/closing quote/);
        expect(errors[0].token.lineNumber).toBe(2);
    });

    it('leaves every member below it parsed', () => {
        const { document } = parse(source);
        const part = document.elements[0];
        expect(isGroupNode(part)).toBe(true);
        expect(isGroupNode(part) ? part.elements.length : 0).toBe(3);
    });

    it('says nothing about a string the line continues', () => {
        // A backslash before the break is ObjectText's line continuation, so the value really does
        // carry on below and the quote that closes it is on the next line.
        const { errors, document } = parse('Part\n{\n\tText = "one \\\n\ttwo"\n\tMaxHealth = 1\n}\n');
        expect(errors).toHaveLength(0);
        const part = document.elements[0];
        expect(isGroupNode(part) ? part.elements.length : 0).toBe(2);
    });

    it('says nothing about a verbatim string, which may span lines', () => {
        expect(parse('A = @"multi\nline"\n').errors).toHaveLength(0);
    });

    it('reports a quote left open at the end of the file', () => {
        const { errors } = parse('A = "open');
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toMatch(/closing quote/);
    });
});
