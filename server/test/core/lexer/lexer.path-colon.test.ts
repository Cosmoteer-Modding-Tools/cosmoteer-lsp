import { describe, expect, it } from 'vitest';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { isAssignmentNode, isGroupNode, isValueNode } from '../../../src/core/ast/ast';

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
 * The parse errors one probe source produces.
 *
 * @param source the document source.
 * @returns each error's message.
 */
const messages = (source: string): string[] =>
    parser(lexer(source), 'file:///probe.rules').parserErrors.map((error) => error.message);

// A `:` between two `/` is the derived-override segment of a reference path, and it may also be the
// path's last segment. Running the shipped HalflingCore parser over these answers `R->/Foo/:` for
// `&/Foo/:` and `R->:` for `&:`, both of which it then resolves, while `&/Foo/:Bar` is the one it
// refuses with "is not a valid path". Cutting the value at the colon left the reference reading
// `&/Foo/`, so navigation and the reference check both worked off a path the author never wrote.
describe('a colon that ends a reference path', () => {
    it.each([
        ['after a path segment', 'R = &/Foo/:\n', '&/Foo/:'],
        ['as the whole path', 'R = &:\n', '&:'],
        ['inside parentheses', 'A = (&/Foo/:)\n', '&/Foo/:'],
        ['before a separator', 'R = &/Foo/:;\n', '&/Foo/:'],
    ])('stays in the value %s', (_label, source, expected) => {
        expect(firstValue(source)).toBe(expected);
        expect(messages(source)).toEqual([]);
    });

    it('leaves the member below it with its own line', () => {
        const source = 'R = &/Foo/:\nAfter = 7\n';
        const document = parser(lexer(source), 'file:///probe.rules').value;
        expect(document.elements.length).toBe(2);
        expect(messages(source)).toEqual([]);
    });

    it('leaves a path with the segment in the middle reading as it did', () => {
        expect(firstValue('R = &~/Foo/:/Bar\n')).toBe('&~/Foo/:/Bar');
        expect(messages('R = &~/Foo/:/Bar\n')).toEqual([]);
    });

    it('leaves an inheritance colon to the inheritance', () => {
        const document = parser(lexer('Child : Parent\n{\n\tX = 1\n}\n'), 'file:///probe.rules').value;
        const group = document.elements.find((node) => isGroupNode(node));
        expect(group && isGroupNode(group) ? group.identifier?.name : undefined).toBe('Child');
        expect(messages('Child : Parent\n{\n\tX = 1\n}\n')).toEqual([]);
    });

    it('leaves a time literal reading as it did', () => {
        expect(firstValue('T = 30:00\n')).toBe('30:00');
        expect(messages('T = 30:00\n')).toEqual([]);
    });
});

// Inside a `<…>` file path the colon belongs to the drive letter. The game builds the same
// reference from `&<C:/x/y.rules>/Member` that it builds from a relative path, while our value used
// to end at the colon and leave `&<C` behind as a reference that is not valid.
describe('a colon inside a referenced file path', () => {
    it('stays in the value', () => {
        expect(firstValue('A = &<C:/x/y.rules>/Member\n')).toBe('&<C:/x/y.rules>/Member');
        expect(messages('A = &<C:/x/y.rules>/Member\n')).toEqual([]);
    });

    it('leaves a relative file path reading as it did', () => {
        expect(firstValue('A = &<../x/y.rules>/Member\n')).toBe('&<../x/y.rules>/Member');
        expect(messages('A = &<../x/y.rules>/Member\n')).toEqual([]);
    });
});
