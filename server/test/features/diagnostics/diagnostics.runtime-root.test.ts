import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { ValidationForValue } from '../../../src/features/diagnostics/validator.value';
import { AbstractNode, isListNode, isGroupNode, isValueNode, ValueNode } from '../../../src/core/ast/ast';
import { readFixture } from '../../helpers';

const token = CancellationToken.None;

// Collect every Reference-typed Value node in a tree, paired with its reference string.
const collectReferences = (node: AbstractNode, out: ValueNode[] = []): ValueNode[] => {
    if (!node || typeof node !== 'object') return out;
    if (isValueNode(node) && node.valueType.type === 'Reference') out.push(node);
    const n = node as unknown as {
        elements?: AbstractNode[];
        inheritance?: AbstractNode[];
        left?: AbstractNode;
        right?: AbstractNode;
        arguments?: AbstractNode[];
    };
    if (isGroupNode(node) || isListNode(node) || node.type === 'Document') {
        (n.elements ?? []).forEach((c) => collectReferences(c, out));
        (n.inheritance ?? []).forEach((c) => collectReferences(c, out));
    }
    if (n.left) collectReferences(n.left, out);
    if (n.right) collectReferences(n.right, out);
    (n.arguments ?? []).forEach((c) => collectReferences(c, out));
    return out;
};

const validate = async (src: string, uri = 'file:///runtime-root-ref.rules') => {
    const doc = parser(lexer(src), uri).value;
    const refs = collectReferences(doc);
    const result = new Map<string, string | undefined>();
    for (const ref of refs) {
        const diagnostic = await ValidationForValue.callback(ref, token);
        result.set(String(ref.valueType.value), diagnostic?.message);
    }
    return result;
};

describe('runtime-root (`~`) references', () => {
    it('does not flag a `~`-reference whose first segment is not a root member (runtime context)', async () => {
        const diagnostics = await validate(readFixture('runtime-root-ref.rules'));
        // EMITTER is not defined in this file — it belongs to the consuming weapon part.
        expect(diagnostics.get('&~/EMITTER/BeamCount')).toBeUndefined();
    });

    it('still resolves a `~`-reference whose first segment IS a real root member', async () => {
        const diagnostics = await validate(readFixture('runtime-root-ref.rules'));
        expect(diagnostics.get('&~/RealRoot/Inner')).toBeUndefined();
    });

    it('does not flag a deeper `~` path even when a segment is absent statically (runtime-resolved)', async () => {
        // `~` paths reach runtime-assembled subtrees (e.g. `&~/Part/Components/.../Bullet/...`) that
        // do not exist in the static file and are indistinguishable from a typo, so we never flag a
        // `~`-rooted reference. This used to be flagged; the change removed hundreds of real-mod
        // false positives at the cost of typo detection inside `~` paths.
        const diagnostics = await validate(readFixture('runtime-root-ref.rules'));
        expect(diagnostics.get('&~/RealRoot/Missing')).toBeUndefined();
    });
});
