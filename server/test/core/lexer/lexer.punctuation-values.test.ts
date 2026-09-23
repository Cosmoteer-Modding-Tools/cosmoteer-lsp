import { describe, expect, it } from 'vitest';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import {
    AbstractNodeDocument,
    isAssignmentNode,
    isGroupNode,
    isListNode,
    isValueNode,
} from '../../../src/core/ast/ast';

const NL = String.fromCharCode(10);

/**
 * The document one probe source parses to.
 *
 * @param text the document source.
 * @returns the parsed document.
 */
const parse = (text: string): AbstractNodeDocument => parser(lexer(text), 'file:///probe.rules').value;

/**
 * The parse errors one probe source produces.
 *
 * @param text the document source.
 * @returns each error's message.
 */
const errors = (text: string): string[] =>
    parser(lexer(text), 'file:///probe.rules').parserErrors.map((error) => error.message);

/**
 * The written value of the first assignment in a probe source.
 *
 * @param text the document source.
 * @returns the value the assignment binds, as text.
 */
const firstValue = (text: string): string => {
    const assignment = parse(text).elements.find((node) => isAssignmentNode(node));
    const right = assignment && isAssignmentNode(assignment) ? assignment.right : undefined;
    return right && isValueNode(right) ? String(right.valueType.value) : '';
};

// The game's file tokenizer hands any character it has no grammar for to the value as a token of
// its own, so `#`, `@`, `$`, `?`, `|` and a backtick are ordinary text on the right of an `=`. Each
// expectation below was taken from the shipped HalflingCore parser, which reads `A = a#b` as the
// value `a#b` and refuses `A#B = 1` with `Unexpected "#"`.
describe('punctuation the game reads as value text', () => {
    it.each([
        ['a hash inside a word', 'A = a#b' + NL, 'a#b'],
        ['a hash on its own', 'A = #' + NL, '#'],
        ['a hash ending a word', 'A = foo#' + NL, 'foo#'],
        ['a hash starting a number', 'A = Gun #2' + NL, 'Gun #2'],
        ['an at sign inside a word', 'A = a@b' + NL, 'a@b'],
        ['a dollar inside a word', 'A = a$b' + NL, 'a$b'],
        ['a question mark inside a word', 'A = a?b' + NL, 'a?b'],
        ['a question mark on its own', 'A = ?' + NL, '?'],
        ['a question mark before a word', 'A = ?x' + NL, '?x'],
        ['a pipe between words', 'A = Guns | Roses' + NL, 'Guns | Roses'],
        ['a backtick inside a word', 'A = a`b' + NL, 'a`b'],
    ])('keeps %s in the value', (_label, source, expected) => {
        expect(firstValue(source)).toBe(expected);
        expect(errors(source)).toEqual([]);
    });

    it('reads a hash in a reference path as part of the target', () => {
        const source = 'R = &#/Foo/Bar' + NL;
        expect(firstValue(source)).toBe('&#/Foo/Bar');
        expect(errors(source)).toEqual([]);
    });

    it('reads a hash in a referenced file name as part of the path', () => {
        const source = 'A = &<a#b.rules>/X' + NL;
        expect(firstValue(source)).toBe('&<a#b.rules>/X');
        expect(errors(source)).toEqual([]);
    });

    it('leaves the group under a hash-carrying value with its own name', () => {
        const document = parse('A = foo#bar' + NL + 'MyGroup' + NL + '{' + NL + '\tX = 1' + NL + '}' + NL);
        const group = document.elements.find((node) => isGroupNode(node));
        expect(group && isGroupNode(group) ? group.identifier?.name : undefined).toBe('MyGroup');
    });

    it.each([
        ['a hash', 'A#B = 1' + NL, 'Unexpected "#"'],
        ['an at sign', 'A@B = 1' + NL, 'Unexpected "@"'],
        ['a question mark', 'A?B = 1' + NL, 'Unexpected "?"'],
        ['a dollar', 'A$B = 1' + NL, 'Unexpected "$"'],
        ['a pipe', 'A|B = 1' + NL, 'Unexpected "|"'],
        ['a backtick', 'A`B = 1' + NL, 'Unexpected "`"'],
    ])('reports %s where a member name belongs', (_label, source, expected) => {
        expect(errors(source)).toContain(expected);
    });

    it('reports a hash in the name of a bare member inside a group', () => {
        expect(errors('G' + NL + '{' + NL + '\tFoo#Bar;' + NL + '}' + NL)).toContain('Unexpected "#"');
    });

    it('keeps a hash written as the modulo operator out of the value', () => {
        const assignment = parse('X = 7 # 3' + NL).elements.find((node) => isAssignmentNode(node));
        const right = assignment && isAssignmentNode(assignment) ? assignment.right : undefined;
        expect(right?.type).toBe('MathExpression');
    });

    it('keeps a pipe written as the boolean operator out of the value', () => {
        const assignment = parse('X = (0) | (3)' + NL).elements.find((node) => isAssignmentNode(node));
        const right = assignment && isAssignmentNode(assignment) ? assignment.right : undefined;
        expect(right?.type).toBe('MathExpression');
    });
});

// A `?` standing alone as a list element is the void element of ObjectText, and the game keeps the
// index it occupies. The element still has to be counted, since a positional list reads its shape
// off the indexes.
describe('a void list element written as a question mark', () => {
    it.each([
        ['between two elements', 'A = [1, ?, 2]' + NL, 3],
        ['as the only element', 'A = [?]' + NL, 1],
        ['after the last element', 'A = [1, 2, ?]' + NL, 3],
        ['separated by semicolons', 'A = [1; ?; 2]' + NL, 3],
    ])('keeps the element count %s', (_label, source, expected) => {
        const assignment = parse(source).elements.find((node) => isAssignmentNode(node));
        const right = assignment && isAssignmentNode(assignment) ? assignment.right : undefined;
        expect(right && isListNode(right) ? right.elements.length : -1).toBe(expected);
        expect(errors(source)).toEqual([]);
    });

    it('leaves a list without one reading as it did', () => {
        const assignment = parse('A = [1, 2]' + NL).elements.find((node) => isAssignmentNode(node));
        const right = assignment && isAssignmentNode(assignment) ? assignment.right : undefined;
        expect(right && isListNode(right) ? right.elements.length : -1).toBe(2);
    });
});
