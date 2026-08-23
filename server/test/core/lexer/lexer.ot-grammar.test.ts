import { describe, expect, it } from 'vitest';
import { lexer, TOKEN_TYPES } from '../../../src/core/lexer/lexer';

const BS = String.fromCharCode(92); // backslash
const NL = String.fromCharCode(10); // newline
const types = (src: string) => lexer(src).map((t) => t.type);
const stringValues = (src: string) => lexer(src).filter((t) => t.type === TOKEN_TYPES.STRING).map((t) => t.value);
const values = (src: string) => lexer(src).map((t) => t.value);

// These encode ObjectText caveats taken from the real parser (`Halfling.ObjectText`); see the
// `inspect-cosmoteer-ot-format` skill.
describe('lexer: ObjectText backslash handling', () => {
    it('treats a stray backslash as whitespace, so it produces no token of its own', () => {
        const toks = types('A = foo ' + BS + ' bar' + NL);
        expect(toks).toEqual([TOKEN_TYPES.VALUE, TOKEN_TYPES.EQUALS, TOKEN_TYPES.VALUE, TOKEN_TYPES.VALUE]);
        expect(toks).not.toContain(TOKEN_TYPES.UNEXPECTED);
    });

    it('treats `\\` before a newline as a line continuation', () => {
        // `X = 1 \<newline> + 2` continues the value across the line break, so it lexes the same
        // as `X = 1 + 2` and parses to a math expression.
        const withContinuation = types('X = 1 ' + BS + NL + ' + 2' + NL);
        const oneLine = types('X = 1 + 2' + NL);
        expect(withContinuation).toEqual(oneLine);
    });
});

describe('lexer: ObjectText verbatim strings', () => {
    it('lexes `@"…"` as a single STRING and unescapes doubled quotes', () => {
        expect(stringValues('X = @"a' + BS + 'b ""q"" c"' + NL)).toEqual(['a' + BS + 'b "q" c']);
    });

    it('does not treat `\\` as an escape inside a verbatim string', () => {
        // Verbatim strings keep the backslash literally (unlike regular `"…"` strings).
        expect(stringValues('X = @"c:' + BS + 'path"' + NL)).toEqual(['c:' + BS + 'path']);
    });

    it('allows a verbatim string to span newlines', () => {
        expect(stringValues('X = @"line1' + NL + 'line2"' + NL)).toEqual(['line1' + NL + 'line2']);
    });

    it('still lexes a regular `"…"` string with backslash escapes', () => {
        expect(stringValues('X = "a' + BS + '"b"' + NL)).toEqual(['a' + BS + '"b']);
    });
});

describe('lexer: string escape handling (no desync)', () => {
    it('closes a string that ends with an escaped backslash', () => {
        // `"x\\"` is a string whose content is `x\\`; the quote after `\\` CLOSES it. The old naive
        // check ran past this quote and swallowed the rest of the file (the ja/ru locale-file bug).
        const toks = lexer('A = "x' + BS + BS + '"' + NL + 'B = 1' + NL);
        expect(stringValues('A = "x' + BS + BS + '"' + NL + 'B = 1' + NL)).toEqual(['x' + BS + BS]);
        // The field after the string must still be tokenized (not absorbed into the string).
        expect(toks.some((t) => t.type === TOKEN_TYPES.VALUE && t.value === 'B')).toBe(true);
    });

    it('keeps an escaped quote inside the string', () => {
        expect(stringValues('X = "a' + BS + '"b' + BS + BS + '"' + NL)).toEqual(['a' + BS + '"b' + BS + BS]);
    });
});

describe('lexer: keywords are whole words', () => {
    it('reads a value that only begins with `true`/`false` as one value', () => {
        expect(types('A = truest' + NL)).toEqual([TOKEN_TYPES.VALUE, TOKEN_TYPES.EQUALS, TOKEN_TYPES.VALUE]);
        expect(values('A = truest' + NL)).toContain('truest');
        expect(values('A = falsely' + NL)).toContain('falsely');
    });

    it('still reads the keyword when the value ends there', () => {
        for (const src of ['A = true' + NL, 'A = false' + NL, 'A = true // note' + NL, 'A = [true, false]' + NL]) {
            expect(types(src)).toContain(src.includes('false') ? TOKEN_TYPES.FALSE : TOKEN_TYPES.TRUE);
        }
    });
});

describe('lexer: a block comment does not move the column of what follows it', () => {
    it('counts the opening `/*` like any other text', () => {
        const tokens = lexer('X = [A/*, B*/]' + NL);
        const closing = tokens.find((token) => token.type === TOKEN_TYPES.RIGHT_BRACKET);
        expect(closing?.lineOffset).toBe('X = [A/*, B*/'.length);
    });

    it('starts the line after a comment newline at column zero', () => {
        const tokens = lexer('X = 1' + NL + '/* c' + NL + '*/ Y = 2' + NL);
        const y = tokens.filter((token) => token.value === 'Y');
        expect(y[0]?.lineOffset).toBe('*/ '.length);
        expect(y[0]?.lineNumber).toBe(2);
    });
});
