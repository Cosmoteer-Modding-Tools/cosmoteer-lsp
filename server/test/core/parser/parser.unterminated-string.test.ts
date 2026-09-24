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

    it('reports a backslash that tries to carry the value on from inside the quotes', () => {
        // The game's in-string escape takes any character except a line break, so a `\` at the end
        // of the line does not continue a quoted value. Running it through the shipped HalflingCore
        // parser answers `OTParseException: Unexpected "\n" at position Line=3,Char=9`, so the file
        // does not load and the editor has to say so.
        const { errors } = parse('Part\n{\n\tText = "one \\\n\ttwo"\n\tMaxHealth = 1\n}\n');
        expect(errors.length).toBeGreaterThan(0);
        expect(errors[0].message).toMatch(/closing quote/);
        expect(errors[0].token.lineNumber).toBe(2);
    });

    it('says nothing about a value the line continues outside the quotes', () => {
        // The spelling the game does accept, which the advice on the missing-quote error names:
        // close the quote, end the line with a backslash, open a new quoted piece below. The game
        // reads the two pieces as the single value `onetwo`.
        const { errors, document } = parse('Part\n{\n\tText = "one" \\\n\t"two"\n\tMaxHealth = 1\n}\n');
        expect(errors).toHaveLength(0);
        const part = document.elements[0];
        expect(isGroupNode(part) ? part.elements.length : 0).toBe(2);
    });

    it('says nothing about a verbatim string, which may span lines', () => {
        expect(parse('A = @"multi\nline"\n').errors).toHaveLength(0);
        expect(parse('A = @"say ""hi"""\nB = 1\n').errors).toHaveLength(0);
    });

    it('reports a verbatim string that never closes, and keeps the members below it', () => {
        // The game answers `OTParseException: Unexpected "￿"` on this one, because the value
        // runs to the end of the input. Reading it that way here would hand `B` and `C` to the
        // value and leave the outline, completion and every whole-file check short of two members,
        // so the token ends at its own line the way an unclosed plain string does.
        const { errors, document } = parse('A = @"oops\nB = 1\nC = 2\n');
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toMatch(/closing quote/);
        expect(errors[0].additionalInfo?.[0].message).toMatch(/verbatim/);
        expect(document.elements).toHaveLength(3);
    });

    it('reports a verbatim string that never closes inside a group', () => {
        const { errors, document } = parse('G\n{\n\tA = @"oops\n\tB = 1\n}\nC = 2\n');
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toMatch(/closing quote/);
        const group = document.elements[0];
        expect(isGroupNode(group) ? group.elements.length : 0).toBe(2);
    });

    it('reports a quote left open at the end of the file', () => {
        const { errors } = parse('A = "open');
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toMatch(/closing quote/);
    });
});
