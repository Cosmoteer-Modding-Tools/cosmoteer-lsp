import { describe, expect, it } from 'vitest';
import { lexer, TOKEN_TYPES } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { AbstractNode, isAssignmentNode, isValueNode } from '../../../src/core/ast/ast';

const BS = String.fromCharCode(92); // backslash
const CR = String.fromCharCode(13); // carriage return
const NL = String.fromCharCode(10); // newline

/**
 * The member names a probe source parses to at the document root.
 *
 * @param text the document source.
 * @returns each member's written name.
 */
const memberNames = (text: string): string[] =>
    parser(lexer(text), 'file:///probe.rules')
        .value.elements.filter((node: AbstractNode) => isAssignmentNode(node))
        .map((node) => (isAssignmentNode(node) ? (node.left.name as string) : ''));

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
    const assignment = parser(lexer(text), 'file:///probe.rules').value.elements.find((node) => isAssignmentNode(node));
    const right = assignment && isAssignmentNode(assignment) ? assignment.right : undefined;
    return right && isValueNode(right) ? String(right.valueType.value) : '';
};

// ObjectText's tokenizer ends a line at a carriage return as readily as at a line feed, so a file
// written with lone `\r` breaks carries one member per return. Running `A = 1\rB = 2\rC = 3` through
// the shipped HalflingCore parser answers three fields, and the lone return occurs in no installed
// file today, which is why this only surfaced on files the server itself had written.
describe('a lone carriage return between members', () => {
    it('ends the value in front of it, so each member is its own', () => {
        expect(memberNames('A = 1' + CR + 'B = 2' + CR + 'C = 3' + NL)).toEqual(['A', 'B', 'C']);
    });

    it('says nothing about the members it separates', () => {
        expect(errors('A = 1' + CR + 'B = 2' + CR + 'C = 3' + NL)).toEqual([]);
    });

    it('marks the members after it as beginning a line of their own', () => {
        const tokens = lexer('A = 1' + CR + 'B = 2' + NL).filter((token) => token.value === 'B');
        expect(tokens[0]?.precededByNewline).toBe(true);
        expect(tokens[0]?.lineNumber).toBe(1);
    });

    it('ends a bare member the same way a line feed does', () => {
        expect(errors('A' + CR + 'B = 2' + NL)).toEqual([]);
    });

    it('counts a carriage return and line feed pair as one line', () => {
        const tokens = lexer('A = 1' + CR + NL + 'B = 2' + CR + NL).filter((token) => token.value === 'B');
        expect(tokens[0]?.lineNumber).toBe(1);
    });

    it('is still suppressed by a backslash, so the value carries on across it', () => {
        expect(firstValue('A = foo ' + BS + CR + ' bar' + NL)).toBe('foo bar');
    });

    it('leaves a line comment running to the line feed, the way the game reads one', () => {
        // The game's line-comment state ends only at char 10, so `// note\rA = 1` is all comment.
        expect(lexer('// note' + CR + 'A = 1' + CR + 'B = 2' + NL)).toEqual([]);
    });

    it('leaves two members written on one line reported as before', () => {
        // The near neighbour: without a break between them the value really does swallow the next
        // member, and the tokens stay on the one line they were written on.
        const tokens = lexer('A = 1 B = 2' + NL);
        expect(tokens.every((token) => token.lineNumber === 0)).toBe(true);
        expect(tokens.filter((token) => token.type === TOKEN_TYPES.EQUALS)).toHaveLength(2);
    });
});
