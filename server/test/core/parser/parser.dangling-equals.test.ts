import { describe, expect, it } from 'vitest';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';

const messages = (src: string): string[] =>
    parser(lexer(src), 'file:///probe.rules').parserErrors.map((error) => error.message);

const DANGLING = 'This "=" has no value, so the game reads the closing brace as one';

// The game hunts for a field's value past the line break and takes the first thing it finds, so a
// `}` standing there becomes the value and the group never closes. The shipped HalflingCore parser
// answers `OTParseException: Unexpected EOF` on `G { A = }`, and the same file with one more `}`
// under it loads with `A` holding `"}"`, which is what proves the brace is eaten rather than left.
describe('an "=" with nothing after it', () => {
    it('is reported in front of the brace that closes its group', () => {
        expect(messages('G\n{\n\tA =\n}\nB = 9\n')).toEqual([DANGLING]);
    });

    it('is reported when a comment or a blank line stands between', () => {
        expect(messages('G\n{\n\tA =\n\t// note\n}\nB = 9\n')).toEqual([DANGLING]);
        expect(messages('G\n{\n\tA =\n\n}\nB = 9\n')).toEqual([DANGLING]);
        expect(messages('G\n{\n\tA = // note\n}\nB = 9\n')).toEqual([DANGLING]);
    });

    it('is reported for the inner brace of a nested group', () => {
        expect(messages('L\n[\n\t{\n\t\tA =\n\t}\n]\nC = 9\n')).toEqual([DANGLING]);
        expect(messages('G\n{\n\tH\n\t{\n\t\tA = 1\n\t}\n\tB =\n}\nC = 2\n')).toEqual([DANGLING]);
    });

    it('points at the "=" rather than at the brace', () => {
        const error = parser(lexer('G\n{\n\tA =\n}\nB = 9\n'), 'file:///probe.rules').parserErrors[0];
        expect(error.token.lineNumber).toBe(2);
        expect(error.token.lineOffset).toBe(3);
    });

    it('says nothing when the value is written on the next line', () => {
        expect(messages('G\n{\n\tA =\n\t5\n}\nB = 9\n')).toEqual([]);
        expect(messages('G\n{\n\tA =\n\t&B\n}\nB = 1\n')).toEqual([]);
    });

    it('says nothing about a second dangling "=" the first one already swallowed', () => {
        // The game reads `A`'s value as the whole next line, `"B ="`, so it never meets a `}` in a
        // value slot and the file loads.
        expect(messages('G\n{\n\tA =\n\tB =\n}\nC = 9\n')).toEqual([]);
    });

    it('says nothing in front of the bracket that closes a list', () => {
        // Inside a list there is no assignment to leave dangling: the game reads the whole line as
        // the element `"B ="` and the list closes normally.
        expect(messages('L\n[\n\tA = 1\n\tB =\n]\nC = 9\n')).toEqual([]);
    });
});
