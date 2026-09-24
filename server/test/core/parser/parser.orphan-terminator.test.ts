import { describe, expect, it } from 'vitest';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';

const messages = (src: string): string[] =>
    parser(lexer(src), 'file:///probe.rules').parserErrors.map((error) => error.message);

const ORPHAN_SEMICOLON = 'This ";" has no entry in front of it to end';
const ORPHAN_COMMA = 'This "," has no entry in front of it to end';

// ObjectText reads one insignificant token and then accepts a `,`/`;` as the terminator of the node
// it just finished. Running each shape through the shipped HalflingCore parser settles where that
// holds: a field, a reference or a void name takes its terminator only before its own line break, a
// closed `}`/`]` takes one across line breaks and comments, and a separator straight after an `=`
// becomes the field's value. Everywhere else the game answers `OTParseException: Unexpected ";"` and
// refuses the file.
describe('a separator that ends nothing', () => {
    it('is reported at the start of the file', () => {
        expect(messages(';\nA = 1\n')).toEqual([ORPHAN_SEMICOLON]);
    });

    it('is reported on the line below the entry it was meant for', () => {
        expect(messages('A = 1\n;\nB = 2\n')).toEqual([ORPHAN_SEMICOLON]);
    });

    it('is reported when a comment separates it from the entry', () => {
        expect(messages('A = 1 // c\n;\nB = 2\n')).toEqual([ORPHAN_SEMICOLON]);
    });

    it('is reported when two of them stand together', () => {
        expect(messages('A = 1;; B = 2\n')).toEqual([ORPHAN_SEMICOLON]);
        expect(messages('A = 1,, B = 2\n')).toEqual([ORPHAN_COMMA]);
        expect(messages('A = 1 ;;\n')).toEqual([ORPHAN_SEMICOLON]);
    });

    it('is reported on the second one behind a closed group', () => {
        // One terminator after a `}` is legal wherever it stands, a second one is not.
        expect(messages('G\n{\n\tA = 1\n}\n;\n;\nB = 2\n')).toEqual([ORPHAN_SEMICOLON]);
    });

    it('is reported at the start of a line inside a group or a list', () => {
        expect(messages('G\n{\n\tA = 1\n\t, B = 2\n}\n')).toEqual([ORPHAN_COMMA]);
        expect(messages('L\n[\n\t1\n\t, 2\n]\n')).toEqual([ORPHAN_COMMA]);
    });

    it('is reported below a void member', () => {
        expect(messages('A\n;\nB = 2\n')).toEqual([ORPHAN_SEMICOLON]);
    });

    it('says nothing about one that ends its entry on the same line', () => {
        expect(messages('A = 1 ;\nB = 2\n')).toEqual([]);
        expect(messages('A = 1, B = 2\n')).toEqual([]);
        expect(messages('A;\nB = 2\n')).toEqual([]);
        expect(messages('G\n{\n\tA = 1\n};\nB = 2\n')).toEqual([]);
    });

    it('says nothing about one behind a closed group or list, wherever it stands', () => {
        expect(messages('G\n{\n\tA = 1\n}\n;\nB = 2\n')).toEqual([]);
        expect(messages('L\n[\n\t1\n]\n;\nB = 2\n')).toEqual([]);
        expect(messages('G\n{\n\tA = 1\n}\n\n\n;\nB = 2\n')).toEqual([]);
        expect(messages('G\n{\n\tA = 1\n}\n// c\n;\nB = 2\n')).toEqual([]);
    });

    it('says nothing about one that fills an empty value slot', () => {
        // The game reads `A = ;;` as `A` holding `";"` plus the terminator behind it.
        expect(messages('A = ;;\nB = 2\n')).toEqual([]);
        expect(messages('A = ; ;\nB = 2\n')).toEqual([]);
        expect(messages('A = ,\nB = 2\n')).toEqual([]);
    });

    it('says nothing about one behind a value the line continues', () => {
        // The `\` suppresses the break, so `A = 1 \` and `2;` are one line to the game and the
        // terminator still stands behind its own entry.
        expect(messages('A = 1 \\\n2;\nB = 3\n')).toEqual([]);
    });

    it('says nothing about the separators of an inheritance list', () => {
        expect(messages('Base\n{\n\tQ = 1\n}\nOther\n{\n\tR = 2\n}\nD : Base, Other\n{\n\tS = 3\n}\n')).toEqual([]);
        expect(messages('Base\n{\n\tQ = 1\n}\nOther\n{\n\tR = 2\n}\nD : Base,\nOther\n{\n\tS = 3\n}\n')).toEqual([]);
    });
});
