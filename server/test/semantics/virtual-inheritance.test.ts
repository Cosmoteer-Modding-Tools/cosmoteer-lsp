import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { stepIntoNode } from '../../src/semantics/reference-resolver';
import { FullNavigationStrategy } from '../../src/features/navigation/full.navigation-strategy';
import { ValidationForValue } from '../../src/features/diagnostics/validator.value';
import { AbstractNode, isListNode, isGroupNode, isValueNode, ValueNode } from '../../src/core/ast/ast';
import { parseFixture, walkAst } from '../helpers';

// Virtual inheritance: a `:` path segment jumps to the most-derived inheritor of the current node
// (see "Rules Syntax.md"). Statically we approximate it with the node itself (the game's
// no-inheritor behavior), so `&:/v_A` resolves the declaring group's own (default) member, and a
// member that exists only in an inheritor is skipped by validation rather than flagged.
const token = CancellationToken.None;
const navigation = new FullNavigationStrategy();
const doc = parseFixture('virtual-inheritance.rules');

const referenceContaining = (needle: string): ValueNode => {
    for (const node of walkAst(doc)) {
        if (isValueNode(node) && node.valueType.type === 'Reference' && String(node.valueType.value).includes(needle)) {
            return node;
        }
    }
    throw new Error(`No reference containing "${needle}"`);
};

const navigate = (node: ValueNode): Promise<AbstractNode | null | unknown> =>
    navigation.navigate(String(node.valueType.value), node, doc.uri, token);

describe('stepIntoNode `:` segment', () => {
    const parent = doc.elements.find((e) => isGroupNode(e) && e.identifier?.name === 'Parent')!;

    it('resolves `:` on a group to the group itself (no-inheritor approximation)', () => {
        expect(stepIntoNode(parent, ':')).toBe(parent);
    });

    it('resolves `:` on a value node to its owning group', () => {
        const value = stepIntoNode(parent, 'v_A')!;
        expect(isValueNode(value)).toBe(true);
        expect(stepIntoNode(value, ':')).toBe(parent);
    });

    it('resolves a named void field (`v_Declared` with no value) to its declaration', () => {
        const declaration = stepIntoNode(parent, 'v_Declared');
        expect(declaration?.type).toBe('Identifier');
    });
});

describe('virtual-inheritance reference navigation', () => {
    it('resolves `&../:/v_Foo` to the parent group default member', async () => {
        const resolved = (await navigate(referenceContaining(':/v_Foo'))) as ValueNode;
        expect(resolved && isValueNode(resolved)).toBe(true);
        expect(resolved.valueType.value).toBe(0);
    });

    it('resolves the `(&:/v_A)` math operand to the declaring group member', async () => {
        const resolved = (await navigate(referenceContaining(':/v_A'))) as ValueNode;
        expect(resolved && isValueNode(resolved)).toBe(true);
        expect(resolved.valueType.value).toBe(1);
    });
});

describe('virtual-inheritance reference validation', () => {
    const collectReferences = (): ValueNode[] => {
        const out: ValueNode[] = [];
        for (const node of walkAst(doc)) {
            if (isValueNode(node) && node.valueType.type === 'Reference') out.push(node);
        }
        return out;
    };

    it('never flags a reference containing a `:` segment, even when unresolvable statically', async () => {
        for (const ref of collectReferences()) {
            const value = String(ref.valueType.value);
            if (!value.includes(':')) continue;
            const diagnostic = await ValidationForValue.callback(ref, token);
            expect(diagnostic, `flagged ${value}`).toBeUndefined();
        }
    });

    it('the inheritance list itself still parses (`Child : Parent`)', () => {
        const child = doc.elements.find((e) => isGroupNode(e) && e.identifier?.name === 'Child');
        expect(child && (isGroupNode(child) || isListNode(child)) && child.inheritance?.length).toBe(1);
    });
});
