import { describe, expect, it } from 'vitest';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { isListNode, AbstractNode } from '../../../src/core/ast/ast';
import { categoryUsagesOf } from '../../../src/document/schema/category-usage';
import { listElementReferenceTarget } from '../../../src/document/schema/schema-context';

const parse = (src: string) => parser(lexer(src), 'file:///t.rules').value;

describe('category-usage: categoryUsagesOf', () => {
    it('collects category names from Category and TypeCategories fields', () => {
        const doc = parse('Part\n{\n\tCategory = airlock\n\tTypeCategories = [armor, command]\n}');
        expect([...categoryUsagesOf(doc)].sort()).toEqual(['airlock', 'armor', 'command']);
    });

    it('yields nothing for a document with no category fields', () => {
        expect([...categoryUsagesOf(parse('Part\n{\n\tDamage = 5\n}'))]).toHaveLength(0);
    });
});

describe('listElementReferenceTarget', () => {
    it('resolves the element target of a list<reference> field (TypeCategories → PartCategory)', () => {
        const doc = parse('Part\n{\n\tTypeCategories = [armor]\n}');
        let list: AbstractNode | undefined;
        const walk = (n: any) => {
            if (isListNode(n)) list = n;
            for (const k of (n.elements ?? (n.type === 'Assignment' ? [n.left, n.right] : []))) walk(k);
        };
        walk(doc);
        expect(listElementReferenceTarget(list as any)).toBe('Cosmoteer.Ships.Parts.PartCategory');
    });
});
