import { describe, expect, it } from 'vitest';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { GroupNode, isGroupNode } from '../../../src/core/ast/ast';
import { memberTypeIn, resolveGroupClass } from '../../../src/document/schema/schema-context';

// The `Y : ^/0/Y` inheritance form: a leading `^` on a base reference selects the DERIVING GROUP'S
// CONTAINER'S inheritance anchor (Y inherits from the same-named member of X's base), and the `^/0`
// step lands on the container's base entry — itself a reference (`~/TEMPLATE`) that must be
// dereferenced before `Y` can step into it. The synchronous class walk used to seed `^` at the
// deriving group itself, land on its own base value node and die there, leaving every such group
// dark to hover, validation and slot typing.
const parse = (src: string) => parser(lexer(src), 'file:///t.rules').value;

const topGroup = (doc: ReturnType<typeof parse>, id: string): GroupNode => {
    const group = doc.elements.find((e) => isGroupNode(e) && e.identifier?.name === id);
    expect(group, `top-level group ${id}`).toBeDefined();
    return group as GroupNode;
};

const childGroup = (parent: GroupNode, id: string): GroupNode => {
    const group = parent.elements.find((e) => isGroupNode(e) && e.identifier?.name === id);
    expect(group, `child group ${id}`).toBeDefined();
    return group as GroupNode;
};

const SRC = [
    'TEMPLATE',
    '{',
    '\tStorage',
    '\t{',
    '\t\tType = ResourceStorage',
    '\t\tMaxResources = 10',
    '\t}',
    '}',
    'X : ~/TEMPLATE',
    '{',
    '\tStorage : ^/0/Storage',
    '\t{',
    '\t\tMaxResources = 20',
    '\t}',
    '}',
    '',
].join('\n');

describe('`^/0/Y` same-file inheritance class resolution', () => {
    it('resolves the deriving group to the class of the same-named member of the container base', () => {
        const doc = parse(SRC);
        const storage = childGroup(topGroup(doc, 'X'), 'Storage');
        expect(resolveGroupClass(storage)).toBe('Cosmoteer.Ships.Parts.Resources.ResourceStorageRules');
    });

    it('types the deriving group members through the inherited class', () => {
        const doc = parse(SRC);
        const storage = childGroup(topGroup(doc, 'X'), 'Storage');
        expect(memberTypeIn(storage, 'MaxResources')).toBeDefined();
    });

    it('stays unresolved when the container has no base for `^/0` to select', () => {
        const doc = parse('X\n{\n\tStorage : ^/0/Storage\n\t{\n\t\tMaxResources = 20\n\t}\n}\n');
        const storage = childGroup(topGroup(doc, 'X'), 'Storage');
        expect(resolveGroupClass(storage)).toBeUndefined();
    });

    it('does not loop on a cyclic base chain', () => {
        // X's own base points back into X, so the dereference recursion must hit the depth cap
        // instead of spinning.
        const doc = parse('X : ~/X\n{\n\tStorage : ^/0/Storage\n\t{\n\t\tMaxResources = 20\n\t}\n}\n');
        const storage = childGroup(topGroup(doc, 'X'), 'Storage');
        expect(resolveGroupClass(storage)).toBeUndefined();
    });
});
