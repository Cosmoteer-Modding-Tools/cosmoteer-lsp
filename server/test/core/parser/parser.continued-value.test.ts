import { describe, expect, it } from 'vitest';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { AbstractNode, isAssignmentNode, isGroupNode, isListNode, isValueNode } from '../../../src/core/ast/ast';

const BS = String.fromCharCode(92); // backslash
const NL = String.fromCharCode(10); // newline

/**
 * The document one probe source parses to.
 *
 * @param text the document source.
 * @returns the document's root members.
 */
const members = (text: string): AbstractNode[] => parser(lexer(text), 'file:///probe.rules').value.elements;

/**
 * The parse errors one probe source produces.
 *
 * @param text the document source.
 * @returns each error's message.
 */
const errors = (text: string): string[] =>
    parser(lexer(text), 'file:///probe.rules').parserErrors.map((error) => error.message);

/**
 * The right-hand node of the first assignment in a probe source.
 *
 * @param text the document source.
 * @returns the value the assignment binds.
 */
const rightOf = (text: string): AbstractNode | null => {
    const assignment = members(text).find((node) => isAssignmentNode(node));
    return assignment && isAssignmentNode(assignment) ? assignment.right : null;
};

/**
 * The written value of the first assignment in a probe source.
 *
 * @param text the document source.
 * @returns the value the assignment binds, as text.
 */
const firstValue = (text: string): string => {
    const right = rightOf(text);
    return right && isValueNode(right) ? String(right.valueType.value) : '';
};

/**
 * The element count of the first list a probe source declares.
 *
 * @param text the document source.
 * @returns how many elements the list holds.
 */
const elementCount = (text: string): number => {
    const list = members(text).find((node) => isListNode(node));
    return list && isListNode(list) ? list.elements.length : -1;
};

// A `\` is spacing to ObjectText and it suppresses the line break behind it, and a block comment is
// spacing too, so neither ends the value it stands in: the game joins the pieces with a single
// space and reads `A = 1 \<newline> 2` and `A = 1 /* c */ 2` alike as the one value `1 2`. Every
// expectation here was taken from the shipped HalflingCore parser.
describe('a value carried on past a backslash or a comment', () => {
    it.each([
        ['a backslash before the line break', 'A = 1 ' + BS + NL + '2' + NL, '1 2'],
        ['a backslash standing inside the line', 'A = 5 ' + BS + ' 6' + NL, '5 6'],
        ['two backslash breaks in a row', 'A = 1 ' + BS + NL + '2 ' + BS + NL + '3' + NL, '1 2 3'],
        ['a blank line after the backslash', 'A = 1 ' + BS + NL + NL + '2' + NL, '1 2'],
        ['a comment between two words', 'A = foo /* c */ bar' + NL, 'foo bar'],
        ['a comment with no spacing around it', 'A = 1/*c*/2' + NL, '1 2'],
    ])('joins the pieces across %s', (_label, source, expected) => {
        expect(firstValue(source)).toBe(expected);
        expect(errors(source)).toEqual([]);
    });

    it('leaves nothing of the continued run behind as a member of its own', () => {
        expect(members('A = 1 ' + BS + NL + '2' + NL)).toHaveLength(1);
    });

    it('keeps the group under a continued value with its own name', () => {
        const source = 'A = 1 ' + BS + NL + '2' + NL + 'MyGroup { X = 1 }' + NL;
        const group = members(source).find((node) => isGroupNode(node));
        expect(group && isGroupNode(group) ? group.identifier?.name : undefined).toBe('MyGroup');
    });

    it('joins a continued value inside a group and leaves the member below it alone', () => {
        const source = 'G' + NL + '{' + NL + '\tDamage = 12 ' + BS + NL + '34' + NL + '\tOther = 1' + NL + '}' + NL;
        const group = members(source).find((node) => isGroupNode(node));
        const names =
            group && isGroupNode(group)
                ? group.elements.map((node) => (isAssignmentNode(node) ? node.left.name : node.type))
                : [];
        expect(names).toEqual(['Damage', 'Other']);
    });

    it('counts a continued list element once', () => {
        expect(elementCount('L [ 1 ' + BS + NL + '2 ]' + NL)).toBe(1);
    });

    it('counts a list element behind a comment once', () => {
        expect(elementCount('L [ 1 /* c */ 2 ]' + NL)).toBe(1);
    });

    it('still counts two elements when a comma separates them', () => {
        // The near neighbour: a `,` ends the element whatever spacing follows it, so the join must
        // never cross one.
        expect(elementCount('L [ 1, ' + BS + NL + '2 ]' + NL)).toBe(2);
    });

    it('still closes the list when the comment sits in front of the bracket', () => {
        // The one shape that really occurs, a commented-out tail inside a list.
        const source = 'L [ BottomRight/*, Bottom, BottomLeft*/]' + NL;
        expect(elementCount(source)).toBe(1);
        expect(errors(source)).toEqual([]);
    });

    it('still reads a continued math expression as math', () => {
        expect(rightOf('A = 10 ' + BS + NL + '* 3' + NL)?.type).toBe('MathExpression');
    });

    it('still keeps the member below a stray trailing backslash', () => {
        // The game folds `B = 2` into A's value here, which is a typo the parser refuses to
        // reproduce: the member would disappear from the tree and the mistake would be reported on
        // a line the author never touched.
        const names = members('A = 1' + BS + NL + 'B = 2' + NL).map((node) =>
            isAssignmentNode(node) ? node.left.name : node.type
        );
        expect(names).toEqual(['A', 'B']);
    });

    it('still ends the value at a line break inside the comment', () => {
        // The near neighbour of the joined comment: the game refuses this file outright, so the
        // pieces must not be joined into a value it never reads.
        expect(firstValue('A = 1 /*' + NL + 'c */ 2' + NL)).toBe('1');
    });

    it('still ends the value at a plain line break', () => {
        const names = members('A = 1' + NL + 'B = 2' + NL).map((node) =>
            isAssignmentNode(node) ? node.left.name : node.type
        );
        expect(names).toEqual(['A', 'B']);
    });
});
