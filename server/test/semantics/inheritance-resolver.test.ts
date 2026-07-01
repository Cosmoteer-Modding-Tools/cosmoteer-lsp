import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { findMemberThroughInheritance } from '../../src/semantics/inheritance-resolver';
import { AbstractNode, GroupNode, ValueNode } from '../../src/core/ast/ast';

const token = CancellationToken.None;
const pos = { line: 0, characterStart: 0, characterEnd: 0, start: 0, end: 0 };

const ref = (value: string): ValueNode => ({ type: 'Value', valueType: { type: 'Reference', value }, position: pos });

const obj = (elements: AbstractNode[], inheritance?: ValueNode[]): GroupNode => ({
    type: 'Group',
    elements,
    inheritance,
    position: pos,
});

describe('findMemberThroughInheritance', () => {
    it('finds a member defined on an inherited parent', async () => {
        const parent = obj([
            { type: 'Assignment', assignmentType: 'Equals', left: { type: 'Identifier', name: 'Foo', position: pos }, right: ref('bar'), position: pos } as AbstractNode,
        ]);
        const child = obj([], [ref('Parent')]);
        const resolve = async () => parent;
        const found = await findMemberThroughInheritance(child, 'Foo', resolve, token);
        expect(found).toBeTruthy();
    });

    it('returns null when the member exists nowhere in the chain', async () => {
        const parent = obj([]);
        const child = obj([], [ref('Parent')]);
        const found = await findMemberThroughInheritance(child, 'Missing', async () => parent, token);
        expect(found).toBeNull();
    });

    it('terminates on a direct inheritance cycle (A inherits A) instead of looping forever', async () => {
        const a = obj([], [ref('A')]);
        // resolver always returns `a`, i.e. A inherits from itself.
        const found = await findMemberThroughInheritance(a, 'Anything', async () => a, token);
        expect(found).toBeNull();
    });

    it('terminates on a mutual inheritance cycle (A <-> B)', async () => {
        const a: GroupNode = obj([], [ref('B')]);
        const b: GroupNode = obj([], [ref('A')]);
        const resolve = async (path: string) => (path === 'A' ? a : b);
        const found = await findMemberThroughInheritance(a, 'Anything', resolve, token);
        expect(found).toBeNull();
    });

    it('does not mutate the node it resolves members for', async () => {
        const parent = obj([
            { type: 'Assignment', assignmentType: 'Equals', left: { type: 'Identifier', name: 'Foo', position: pos }, right: ref('bar'), position: pos } as AbstractNode,
        ]);
        const child = obj([], [ref('Parent')]);
        const before = child.elements.length;
        await findMemberThroughInheritance(child, 'Foo', async () => parent, token);
        expect(child.elements.length).toBe(before);
    });
});
