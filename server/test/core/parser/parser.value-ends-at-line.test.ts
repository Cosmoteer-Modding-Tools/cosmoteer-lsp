import { describe, expect, it } from 'vitest';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { AbstractNode, isAssignmentNode, isGroupNode, isListNode } from '../../../src/core/ast/ast';

/**
 * The members of the single group a probe document declares.
 *
 * @param text the document source.
 * @returns each member's written name, or its node type when it has none.
 */
const memberNames = (text: string): string[] => {
    const group = parser(lexer(text), 'file:///probe.rules').value.elements[0];
    if (!isGroupNode(group)) return [];
    return group.elements.map((member: AbstractNode) => {
        if (isAssignmentNode(member)) return member.left.name;
        if (isGroupNode(member) || isListNode(member)) return member.identifier?.name ?? member.type;
        return member.type;
    });
};

// A field value ends at an unsuppressed line break, so a value left half-written takes nothing from
// the line below it. Every shape here is one a modder is in the middle of typing, and each of them
// used to swallow the next member: the field disappeared from the tree and the editor reported the
// mistake on a line the author had not touched.
describe('a value left open at the end of its line', () => {
    it('keeps the member below an unclosed function call', () => {
        expect(memberNames('Part\n{\n\tFoo = cos(\n\tB = 2\n\tC = 3\n}\n')).toEqual(['Foo', 'B', 'C']);
    });

    it('keeps the member below a trailing operator', () => {
        expect(memberNames('Part\n{\n\tFoo = 1 +\n\tB = 2\n\tC = 3\n}\n')).toEqual(['Foo', 'B', 'C']);
    });

    it('keeps the name of the list below a trailing sign', () => {
        expect(memberNames('Part\n{\n\tD = -\n\tResources\n\t[\n\t\t1\n\t]\n}\n')).toEqual(['D', 'Resources']);
    });

    it('still reads a call whose arguments are written on the same line', () => {
        expect(memberNames('Part\n{\n\tFoo = ceil(1.5)\n\tB = 2\n}\n')).toEqual(['Foo', 'B']);
    });

    it('still reads an expression the line continues with a backslash', () => {
        expect(memberNames('Part\n{\n\tFoo = 1 + \\\n\t\t2\n\tB = 3\n}\n')).toEqual(['Foo', 'B']);
    });
});
