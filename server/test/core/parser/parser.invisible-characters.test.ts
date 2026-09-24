import { describe, expect, it } from 'vitest';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { isAssignmentNode, isListNode, isValueNode } from '../../../src/core/ast/ast';

const messages = (src: string): string[] =>
    parser(lexer(src), 'file:///probe.rules').parserErrors.map((error) => error.message);

// ObjectText's tokenizer reads only tab, line feed, carriage return, space and backslash as spacing
// and only `[0-9A-Za-z_.]` as name text, so a no-break space or a zero-width character is a token of
// its own. Running each of these through the shipped HalflingCore parser answers
// `OTParseException: Unexpected " " at position Line=2,Char=1` wherever the character stands in
// front of a member name, and parses the file fine wherever it stands inside a value, a string or a
// comment. The editor has to draw the same line, because the mod does not load either way.
describe('an invisible character', () => {
    it.each([
        ['no-break space', ' ', 'U+00A0'],
        ['zero-width space', '​', 'U+200B'],
        ['byte-order mark', '﻿', 'U+FEFF'],
        ['ideographic space', '　', 'U+3000'],
        ['narrow no-break space', ' ', 'U+202F'],
        ['en quad', ' ', 'U+2000'],
        ['line separator', ' ', 'U+2028'],
        ['vertical tab', '\u000b', 'U+000B'],
        ['form feed', '\u000c', 'U+000C'],
        ['next line', '\u0085', 'U+0085'],
        ['soft hyphen', '­', 'U+00AD'],
        ['left-to-right mark', '‎', 'U+200E'],
    ])('is reported in front of a member name: %s', (_label, character, codePoint) => {
        expect(messages(`A = 1\n${character}B = 2\n`)).toEqual([
            `The invisible character ${codePoint} stands where a member name belongs`,
        ]);
    });

    it('is reported inside a member name', () => {
        // The game stops at the character itself, `Unexpected "​" at position Line=2,Char=2`.
        expect(messages('A = 1\nB​C = 2\n')).toEqual([
            'The invisible character U+200B stands where a member name belongs',
        ]);
    });

    it('is reported between a member name and its "="', () => {
        expect(messages('A = 1\nB = 2\n')).toEqual([
            'The invisible character U+00A0 stands where a member name belongs',
        ]);
    });

    it('is reported where it stands alone in front of a closing brace', () => {
        expect(messages('G\n{\n\tA = 1\n }\n')).toEqual([
            'The invisible character U+00A0 stands where a member name belongs',
        ]);
    });

    it('points at the character rather than at the word behind it', () => {
        const error = parser(lexer('A = 1\n B = 2\n'), 'file:///probe.rules').parserErrors[0];
        expect(error.token.start).toBe(6);
        expect(error.token.end).toBe(7);
    });

    it('says nothing inside a value, which the game keeps', () => {
        // The game reads `A = Foo Bar` with a no-break space in it as the single value
        // `Foo<U+00A0>Bar`, and `Standard Mods/example_translation/strings/devlish.rules` ships a
        // zero-width space inside a value the game parses fine.
        expect(messages('A = Foo Bar\nB = 2\n')).toEqual([]);
        expect(messages('Coil2 = Izqfs​Dpjmt\nB = 2\n')).toEqual([]);
    });

    it('says nothing right after the "=", where the value starts', () => {
        expect(messages('A = 1\nB = 2\n')).toEqual([]);
    });

    it('says nothing inside a quoted value, a verbatim value or a comment', () => {
        expect(messages('A = "Foo Bar"\nB = 2\n')).toEqual([]);
        expect(messages('A = @"Foo Bar"\nB = 2\n')).toEqual([]);
        expect(messages('// foo bar\nA = 1\n')).toEqual([]);
        expect(messages('/* foo bar */\nA = 1\n')).toEqual([]);
    });

    it('says nothing about a byte-order mark opening the file, which the game skips', () => {
        expect(messages('﻿A = 1\n')).toEqual([]);
    });

    it('says nothing about a list element, which is a value and not a name', () => {
        // The game reads the element as the text `<U+00A0>a`, so it loads.
        expect(messages('L\n[\n\t a\n]\n')).toEqual([]);
    });
});

// The control characters are one more of the same class, and they are what a file really picks up
// from a tool that wrote it wrong. Every C0 code and the delete character answer the same in the
// shipped HalflingCore parser, the tab, the line feed and the carriage return excepted, which are
// its spacing: `A = 1<control>` is the value `1<control>` and `S = [1,<control> 2]` is the two
// elements `1` and `<control> 2`, while `<control>A = 1` and `A<control>B = 1` are `Unexpected` and
// drop the whole file. The cases below take the ends and the middle of that range.
describe.each([
    ['a NUL byte', '\u0000', 'U+0000'],
    ['a start-of-heading byte', '\u0001', 'U+0001'],
    ['a backspace byte', '\u0008', 'U+0008'],
    ['a unit-separator byte', '\u001f', 'U+001F'],
    ['a delete byte', '\u007f', 'U+007F'],
])('%s', (_label, control, codePoint) => {
    /**
     * The written value of the first assignment in a probe source.
     *
     * @param source the document source.
     * @returns the value the assignment binds, as text.
     */
    const firstValue = (source: string): string => {
        const assignment = parser(lexer(source), 'file:///probe.rules').value.elements[0];
        const right = assignment && isAssignmentNode(assignment) ? assignment.right : undefined;
        return right && isValueNode(right) ? String(right.valueType.value) : '';
    };

    /**
     * How many elements the list bound by the first assignment holds.
     *
     * @param source the document source.
     * @returns the element count, or -1 when the assignment binds no list.
     */
    const elementCount = (source: string): number => {
        const assignment = parser(lexer(source), 'file:///probe.rules').value.elements[0];
        const right = assignment && isAssignmentNode(assignment) ? assignment.right : undefined;
        return right && isListNode(right) ? right.elements.length : -1;
    };

    it.each([
        ['ending a value', `A = 1${control}\n`, `1${control}`],
        ['opening a value', `A =${control} 1\n`, `${control} 1`],
        ['inside a word', `A = a${control}b\n`, `a${control}b`],
    ])('stays in the value %s', (_label, source, expected) => {
        expect(firstValue(source)).toBe(expected);
        expect(messages(source)).toEqual([]);
    });

    it('leaves a value without one reading as it did', () => {
        expect(firstValue('A = 1\n')).toBe('1');
        expect(messages('A = 1\n')).toEqual([]);
    });

    it('is reported in front of a member name', () => {
        expect(messages(`A = 1\n${control}B = 2\n`)).toEqual([
            `The invisible character ${codePoint} stands where a member name belongs`,
        ]);
    });

    it('is reported inside a member name', () => {
        expect(messages(`A${control}B = 1\n`)).toEqual([
            `The invisible character ${codePoint} stands where a member name belongs`,
        ]);
    });

    it('leaves the list it stands in with the element count the game gives it', () => {
        expect(elementCount(`S = [1,${control} 2]\n`)).toBe(2);
        expect(messages(`S = [1,${control} 2]\n`)).toEqual([]);
    });

    it('leaves a list without one reading as it did', () => {
        expect(elementCount('S = [1, 2]\n')).toBe(2);
        expect(messages('S = [1, 2]\n')).toEqual([]);
    });
});
