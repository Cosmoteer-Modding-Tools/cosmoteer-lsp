import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../src/core/lexer/lexer';
import { parser } from '../../src/core/parser/parser';
import { FullNavigationStrategy } from '../../src/features/navigation/full.navigation-strategy';
import { AbstractNode, isListNode } from '../../src/core/ast/ast';
import { parseFixture } from '../helpers';

const token = CancellationToken.None;

// Numeric inheritance (`: N`) inherits from the sibling at index N of the containing
// list, valid Cosmoteer syntax that the parser previously rejected with
// "Expected reference value after reference value but found Number".

describe('numeric inheritance (`: N`)', () => {
    it('parses `: N` without errors', () => {
        const result = parser(lexer('A\n[\n\t{ x = 1 }\n\t: 0\n\t{ y = 2 }\n]\n'), 'file:///t.rules');
        expect(result.parserErrors).toEqual([]);
    });

    it('captures the numeric inheritance as a relative `&N` reference', () => {
        const doc = parseFixture('numeric-inheritance.rules');
        const effects = doc.elements.find((e) => isListNode(e) && e.identifier?.name === 'Effects')!;
        const inheritingElement = (effects as unknown as { elements: AbstractNode[] }).elements[2];
        const inheritance = (inheritingElement as { inheritance?: { valueType: { value: string } }[] }).inheritance;
        expect(inheritance).toHaveLength(1);
        expect(inheritance![0].valueType.value).toBe('&1');
    });

    it('resolves a member inherited from the indexed sibling', async () => {
        const doc = parseFixture('numeric-inheritance.rules');
        const nav = new FullNavigationStrategy();
        const effects = doc.elements.find((e) => isListNode(e) && e.identifier?.name === 'Effects')!;
        const inheritingElement = (effects as unknown as { elements: AbstractNode[] }).elements[2];
        // `Color` is defined only on index 1; it must be reachable via `: 1`.
        const result = await nav.navigate('Color', inheritingElement, doc.uri, token);
        expect(result && 'valueType' in result && (result as { valueType: { value: unknown } }).valueType.value).toBe(
            22
        );
    });
});
