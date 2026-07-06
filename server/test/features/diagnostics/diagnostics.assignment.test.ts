import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { ValidationForAssignment } from '../../../src/features/diagnostics/validator.assignment';
import { AbstractNodeDocument, AssignmentNode, AstPosition, ValueNode } from '../../../src/core/ast/ast';

const token = CancellationToken.None;
const pos = (): AstPosition => ({ line: 0, characterStart: 0, characterEnd: 0, start: 0, end: 0 });

const assign = (right: ValueNode, uri = 'file:///parts.rules'): AssignmentNode => {
    const doc: AbstractNodeDocument = { type: 'Document', uri, elements: [], position: pos() };
    const node: AssignmentNode = {
        type: 'Assignment',
        assignmentType: 'Equals',
        left: { type: 'Identifier', name: 'Foo', position: pos() },
        right,
        position: pos(),
        parent: doc,
    };
    right.parent = node as unknown as AbstractNodeDocument;
    return node;
};
const refValue = (value: string, quoted = false): ValueNode => ({
    type: 'Value',
    valueType: { type: 'Reference', value },
    quoted,
    position: pos(),
});
const run = (node: AssignmentNode) => ValidationForAssignment.callback(node, token);

describe('assignment diagnostics', () => {
    it('flags a quoted "&" reference', async () => {
        const error = await run(assign(refValue('&Bar', true)));
        expect(error?.message).toBe('Reference should not be quoted');
        expect(error?.additionalInfo).toContain('without quotation marks');
    });

    it.each(['<a/b>', '..Sibling', '~/Root', '^/0/Base'])('flags a reference that omits the leading ampersand: %s', async (value) => {
        const error = await run(assign(refValue(value)));
        expect(error?.message).toBe('Reference should start with an ampersand');
        expect(error?.additionalInfo).toContain('&');
    });

    it('accepts a well-formed "&" reference', async () => {
        expect(await run(assign(refValue('&Bar')))).toBeUndefined();
    });

    it('does not validate assignments inside a mod.rules file', async () => {
        expect(await run(assign(refValue('&Bar', true), 'file:///mod.rules'))).toBeUndefined();
    });
});
