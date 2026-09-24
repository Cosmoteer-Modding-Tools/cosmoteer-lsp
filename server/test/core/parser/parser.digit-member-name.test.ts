import { describe, expect, it } from 'vitest';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';

const messages = (src: string): string[] =>
    parser(lexer(src), 'file:///probe.rules').parserErrors.map((error) => error.message);

const NUMBER_NAME = 'A number cannot name a member';

// An ObjectText identifier may not start with a digit, so a digit-keyed member of a group is a hard
// parse failure. The shipped HalflingCore parser answers `Unexpected "0" at position Line=3,Char=2`
// on `G { 0 = 2 }` and `Unexpected "0" at position Line=1,Char=1` on a digit key at the top level.
// Inside a `[ … ]` list there is no assignment at all: the game reads the whole line as the element
// text `"0 = 2"` and the file loads.
describe('a digit-keyed member', () => {
    it('is reported inside a group', () => {
        expect(messages('G\n{\n\t0 = 2\n}\n')).toEqual([NUMBER_NAME]);
    });

    it('is reported at the document top level', () => {
        expect(messages('0 = 2\nA = 1\n')).toEqual([NUMBER_NAME]);
    });

    it('is reported for a list-typed slot written as a digit-keyed group', () => {
        // The shape the schema cannot see: `Resources` is an array slot, and the group spelling of
        // it fails before the array reader is ever asked.
        expect(messages('Resources\n{\n\t0 = [steel, 32]\n}\n')).toEqual([NUMBER_NAME]);
    });

    it('is reported for a vector written positionally inside a group', () => {
        expect(messages('Size\n{\n\t0 = 2\n\t1 = 2\n}\n')).toEqual([NUMBER_NAME, NUMBER_NAME]);
    });

    it('says nothing about a positional element of a list, which is how the game reads a vector', () => {
        expect(messages('Size [ 2, 2 ]\n')).toEqual([]);
    });

    it('says nothing about a digit-keyed line inside a list, which is element text', () => {
        expect(messages('L\n[\n\t0 = 2\n]\n')).toEqual([]);
    });

    it('says nothing about a name that merely holds digits', () => {
        expect(messages('G\n{\n\t_0 = 2\n\tCoil2 = 3\n}\n')).toEqual([]);
    });
});
