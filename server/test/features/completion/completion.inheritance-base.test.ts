import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { ReferenceAutoCompletionStrategy } from '../../../src/features/completion/strategy/reference.autocompletion-strategy';
import { AutoCompletionReference } from '../../../src/features/completion/autocompletion.reference';
import { AbstractNode, AbstractNodeDocument, isGroupNode, ValueNode } from '../../../src/core/ast/ast';
import { parseFixture } from '../../helpers';

// Inheritance-position completion (`Child : …`) and the virtual-inheritance `:` segment walk.
// Inheritance refs name a sibling of the inheriting group, so completions must come from the
// group's container (previously the caller hardcoded `isInheritanceNode: false` and the group's
// OWN members were offered). The `:` segment lists the current group's members (the static
// most-derived-inheritor approximation shared with the resolver).
const strategy = new ReferenceAutoCompletionStrategy();
const completer = new AutoCompletionReference();
const token = CancellationToken.None;
const pos = { line: 0, characterStart: 0, characterEnd: 0, start: 0, end: 0 };

const parse = (src: string): AbstractNodeDocument => parser(lexer(src), 'file:///inheritance-completion.rules').value;

const refNode = (value: string, parent: AbstractNode): ValueNode => ({
    type: 'Value',
    valueType: { type: 'Reference', value },
    position: pos,
    parent: parent as ValueNode['parent'],
});

describe('inheritance base completion', () => {
    it('completes a partial base name against the container, not the inheriting group', async () => {
        const doc = parse('Base\n{\n\tA = 1\n}\nChild : Bas\n{\n\tOwnMember = 2\n}\n');
        const child = doc.elements.find((e) => isGroupNode(e) && e.identifier?.name === 'Child');
        expect(isGroupNode(child) && child.inheritance?.length).toBe(1);
        const inheritanceNode = (child as { inheritance?: ValueNode[] }).inheritance![0];
        const labels = (await completer.getCompletions(inheritanceNode, token)).map((c) =>
            typeof c === 'string' ? c : (c as { label: string }).label
        );
        expect(labels).toContain('Base');
        expect(labels).not.toContain('OwnMember');
    });

    it('the empty inheritance value offers path prefixes, the `^/N/` caret idiom and sibling names', async () => {
        const doc = parse('Base\n{\n\tSub { A = 1 }\n}\nChild : Base\n{\n\tSub : ^/0/Sub\n\t{\n\t\tB = 2\n\t}\n\tOther { C = 3 }\n}\n');
        const child = doc.elements.find((e) => isGroupNode(e) && e.identifier?.name === 'Child');
        const sub = isGroupNode(child) ? child.elements.find((e) => isGroupNode(e) && e.identifier?.name === 'Sub') : undefined;
        expect(isGroupNode(sub)).toBe(true);
        const options = await strategy.complete({
            node: refNode('', sub!),
            isInheritanceNode: true,
            cancellationToken: token,
        });
        expect(options).toEqual(expect.arrayContaining(['/', '..', '~', '<', '^/0/']));
        expect(options).toContain('Other'); // sibling of the inheriting group
        expect(options).not.toContain('Sub'); // never offer self-inheritance
    });
});

describe('virtual-inheritance `:` segment completion', () => {
    it('`&:/` lists the current group members (static most-derived approximation)', async () => {
        const doc = parseFixture('virtual-inheritance.rules');
        const parent = doc.elements.find((e) => isGroupNode(e) && e.identifier?.name === 'Parent')!;
        const options = await strategy.complete({
            node: refNode('&:/', parent),
            isInheritanceNode: false,
            cancellationToken: token,
        });
        expect(options).toContain('v_A');
        expect(options).toContain('v_B');
    });

    it('`&:/v_` filters the members by the typed prefix', async () => {
        const doc = parseFixture('virtual-inheritance.rules');
        const parent = doc.elements.find((e) => isGroupNode(e) && e.identifier?.name === 'Parent')!;
        const options = await strategy.complete({
            node: refNode('&:/v_', parent),
            isInheritanceNode: false,
            cancellationToken: token,
        });
        expect(options).toEqual(expect.arrayContaining(['v_A', 'v_B', 'v_Foo']));
        expect(options).not.toContain('Nested1');
    });

    it('offers a named void field (declared without a value) among the members', async () => {
        const doc = parseFixture('virtual-inheritance.rules');
        const parent = doc.elements.find((e) => isGroupNode(e) && e.identifier?.name === 'Parent')!;
        const options = await strategy.complete({
            node: refNode('&:/', parent),
            isInheritanceNode: false,
            cancellationToken: token,
        });
        expect(options).toContain('v_Declared');
    });

    it('offers the `&:/` prefix when a reference is being started', () => {
        const doc = parseFixture('virtual-inheritance.rules');
        const parent = doc.elements.find((e) => isGroupNode(e) && e.identifier?.name === 'Parent')!;
        expect(strategy.completeReferenceStart(refNode('&', parent))).toContain('&:/');
    });
});
