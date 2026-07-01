import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../src/core/lexer/lexer';
import { parser } from '../../src/core/parser/parser';
import { FullNavigationStrategy } from '../../src/features/navigation/full.navigation-strategy';
import { AbstractNode, isListNode, isGroupNode } from '../../src/core/ast/ast';
import { parseFixture } from '../helpers';

// Same-file inheritance by bare name: `Child : Parent`. Previously the parser
// rejected the bare name with "Expected reference value after reference value but
// found String"; now it is captured as a relative `&Parent` reference.
const token = CancellationToken.None;

const findGroup = (doc: ReturnType<typeof parseFixture>, name: string) =>
    doc.elements
        .flatMap((e) => (isGroupNode(e) ? e.elements : []))
        .find((e) => (isGroupNode(e) || isListNode(e)) && e.identifier?.name === name);

describe('same-file inheritance by bare name', () => {
    it('parses `Child : Parent` without errors', () => {
        const src = parser(lexer('A { x = 1 }\nB : A {\n}\n'), 'file:///t.rules');
        expect(src.parserErrors).toEqual([]);
    });

    it('captures the bare name as a relative `&Parent` inheritance reference', () => {
        const doc = parseFixture('sibling-inheritance.rules');
        const right = findGroup(doc, 'BatteryStorageRight')!;
        expect(isGroupNode(right) || isListNode(right)).toBe(true);
        const inheritance = (right as { inheritance?: { valueType: { value: string } }[] }).inheritance;
        expect(inheritance).toHaveLength(1);
        expect(inheritance![0].valueType.value).toBe('&BatteryStorageLeft');
    });

    it('accepts a numeric inheritance target (`: N`) without a parse error', () => {
        // `: N` is valid numeric (index) inheritance, normalized to `&N` — see
        // inheritance.numeric.test.ts for resolution.
        const result = parser(lexer('Test : 12356 {\n}\n'), 'file:///t.rules');
        expect(result.parserErrors).toEqual([]);
    });

    it('resolves the bare-name inheritance reference itself to the sibling (validator path)', async () => {
        // The validator navigates the raw inheritance value node (`&BatteryStorageLeft`)
        // with the node itself as start. A relative `&` on an inheritance member must
        // resolve against the container (sibling), not the inheriting group's members.
        const doc = parseFixture('sibling-inheritance.rules');
        const nav = new FullNavigationStrategy();
        const right = findGroup(doc, 'BatteryStorageRight')!;
        const inhNode = (right as { inheritance: AbstractNode[] }).inheritance[0];
        const result = await nav.navigate('&BatteryStorageLeft', inhNode, doc.uri, token);
        expect(result && isGroupNode(result) && result.identifier?.name).toBe('BatteryStorageLeft');
    });

    it('resolves an inherited member through the sibling (BatteryStorageRight -> Type)', async () => {
        const doc = parseFixture('sibling-inheritance.rules');
        const nav = new FullNavigationStrategy();
        // `&~/…` is resolved from a node WITH a parent, as real reference nodes are.
        const start = findGroup(doc, 'BatteryStorageRight')!;
        // Type is defined only on BatteryStorageLeft; it must be reachable on the child.
        const result = await nav.navigate('&~/Components/BatteryStorageRight/Type', start, doc.uri, token);
        expect(result && 'valueType' in result && (result as { valueType: { value: unknown } }).valueType.value).toBe(
            'ResourceStorage'
        );
    });

    it('does not override a member the child redefines (MaxResources stays 50)', async () => {
        const doc = parseFixture('sibling-inheritance.rules');
        const nav = new FullNavigationStrategy();
        const start = findGroup(doc, 'BatteryStorageRight')!;
        const result = await nav.navigate('&~/Components/BatteryStorageRight/MaxResources', start, doc.uri, token);
        expect(result && 'valueType' in result && (result as { valueType: { value: unknown } }).valueType.value).toBe(
            50
        );
    });
});

// A list element re-declaring a base's element through inheritance: `: ../^/0/List/N`. This idiom
// is pervasive in vanilla (`: ../^/0/MediaEffects/5`, `: ../^/0/ContinuousEffects/0`). The `^` in the
// path is applied to the inheriting group reached mid-path, and per the game's `OTNode.FindAtPath` it
// must select THAT group's own inheritance base — not its grandparent. A prior off-by-one on `^`
// (grandparent instead of self) flagged every such line as an unknown reference.
describe('list-element `: ../^/0/List/N` inheritance (game `^` = own inheritance anchor)', () => {
    const SRC = [
        'Comp {',
        '\tBase {',
        '\t\tEffects [',
        '\t\t\t{ Color = 1 }',
        '\t\t]',
        '\t}',
        '\tDerived : Base {',
        '\t\tEffects [',
        '\t\t\t: ../^/0/Effects/0 {',
        '\t\t\t\tExtra = 2',
        '\t\t\t}',
        '\t\t]',
        '\t}',
        '}',
        '',
    ].join('\n');

    const inhRefOfDerivedElement = (doc: ReturnType<typeof parser>) => {
        const comp = doc.value.elements.find((e) => isGroupNode(e) && e.identifier?.name === 'Comp')! as AbstractNode & {
            elements: AbstractNode[];
        };
        const derived = comp.elements.find(
            (e) => (isGroupNode(e) || isListNode(e)) && e.identifier?.name === 'Derived'
        )! as AbstractNode & { elements: AbstractNode[] };
        const effects = derived.elements.find(
            (e) => isListNode(e) && e.identifier?.name === 'Effects'
        )! as AbstractNode & { elements: AbstractNode[] };
        const element = effects.elements[0] as { inheritance: AbstractNode[] };
        return element.inheritance[0] as AbstractNode & { valueType: { value: string } };
    };

    it('resolves the inheritance ref to the base list element (not null)', async () => {
        const doc = parser(lexer(SRC), 'file:///t.rules');
        expect(doc.parserErrors).toEqual([]);
        const nav = new FullNavigationStrategy();
        const inhNode = inhRefOfDerivedElement(doc);
        expect(inhNode.valueType.value).toBe('../^/0/Effects/0');
        // The validator starts the walk from the container of the inheriting group (`node.parent.parent`),
        // matching the game's `OTInheritanceReferenceNode.GetFindRoot` (`Parent.Parent.Parent`).
        const start = (inhNode.parent as AbstractNode).parent as AbstractNode;
        const result = await nav.navigate(inhNode.valueType.value, start, doc.value.uri, token);
        expect(result && isGroupNode(result)).toBe(true);
    });

    it('reaches a member defined only on the base element through the `^/0` inheritance', async () => {
        const doc = parser(lexer(SRC), 'file:///t.rules');
        const nav = new FullNavigationStrategy();
        const inhNode = inhRefOfDerivedElement(doc);
        const start = (inhNode.parent as AbstractNode).parent as AbstractNode;
        const color = await nav.navigate(`${inhNode.valueType.value}/Color`, start, doc.value.uri, token);
        expect(color && 'valueType' in color && (color as { valueType: { value: unknown } }).valueType.value).toBe(1);
    });
});
