import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { ValidationForAssignment } from '../../../src/features/diagnostics/validator.assignment';
import { AbstractNode, AbstractNodeDocument, AssignmentNode, AstPosition, ValueNode, isAssignmentNode } from '../../../src/core/ast/ast';
import { parseText } from '../../../src/utils/ast.utils';

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

    // The pass used to skip every assignment in a manifest. The exemption below is the one manifest
    // shape that would have been reported, and replaying the two checks over every installed manifest
    // with the blanket skip gone produced no findings, so a manifest is now checked like any file.
    it('flags a quoted reference inside a mod.rules file too', async () => {
        const error = await run(assign(refValue('&Bar', true), 'file:///mod.rules'));
        expect(error?.message).toBe('Reference should not be quoted');
    });

    it('still exempts an action target path, which is a quoted game-root path rather than a reference', async () => {
        // Parsed rather than hand-built: the exemption asks whether the value sits in a real action
        // entry, which needs the Actions list and the Action field around it.
        const source = [
            'Actions',
            '[',
            '\t{',
            '\t\tAction = Overrides',
            '\t\tOverrideIn = "<./Data/ships/terran/terran.rules>"',
            '\t\tOverrides { Foo = 1 }',
            '\t}',
            ']',
        ].join('\n');
        const document = parseText(source, 'file:///mod.rules');
        const targets: AssignmentNode[] = [];
        const walk = (node: AbstractNode): void => {
            if (isAssignmentNode(node) && node.left.name === 'OverrideIn') targets.push(node);
            for (const child of (node as { elements?: AbstractNode[] }).elements ?? []) walk(child);
            if (isAssignmentNode(node) && node.right) walk(node.right);
        };
        walk(document);
        expect(targets).toHaveLength(1);
        expect(await run(targets[0])).toBeUndefined();
    });
});
