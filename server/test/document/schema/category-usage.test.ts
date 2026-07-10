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

    // A positional entry of a `list<group>` field (`EditorParentParts = [ [part, 0] ]`): the index
    // at the cursor selects the entry class's digit field, so the reference position completes part
    // ids while the int position offers nothing.
    it('resolves a positional element target from the cursor offset (EditorParentParts entry)', () => {
        const src = 'Part\n{\n\tEditorParentParts = [ [other_part, 0] ]\n}';
        const doc = parse(src);
        let inner: AbstractNode | undefined;
        const walk = (n: any) => {
            if (isListNode(n)) inner = n; // deepest list wins (visited last)
            for (const k of (n.elements ?? (n.type === 'Assignment' ? [n.left, n.right] : []))) walk(k);
        };
        walk(doc);
        const refOffset = src.indexOf('other_part') + 3;
        const intOffset = src.indexOf(', 0]') + 2;
        expect(listElementReferenceTarget(inner as any, refOffset)).toBe('Cosmoteer.Ships.Parts.PartRules');
        expect(listElementReferenceTarget(inner as any, intOffset)).toBeUndefined();
    });

    // A tuple entry of a part's `Resources [ [bullet, 20] ]`: the tuple's first slot is an
    // ID<ResourceRules> reference, the second an int. The cursor's index picks the entry type.
    it('resolves a tuple entry target from the cursor offset (Resources entry)', () => {
        const src = 'Part\n{\n\tResources\n\t[\n\t\t[battery, 20]\n\t]\n}';
        const doc = parse(src);
        let inner: AbstractNode | undefined;
        const walk = (n: any) => {
            if (isListNode(n)) inner = n; // deepest list wins (visited last)
            for (const k of (n.elements ?? (n.type === 'Assignment' ? [n.left, n.right] : []))) walk(k);
        };
        walk(doc);
        const refOffset = src.indexOf('battery') + 3;
        const intOffset = src.indexOf(', 20]') + 2;
        expect(listElementReferenceTarget(inner as any, refOffset)).toBe('Cosmoteer.Resources.ResourceRules');
        expect(listElementReferenceTarget(inner as any, intOffset)).toBeUndefined();
    });

    // The scalar-form spelling of a `list<group>` field: every vanilla wedge part writes
    // `EditorParentParts = ["cosmoteer.armor"]`, where the bare entry reads as the entry class's
    // `0` reference field.
    it('resolves a bare scalar-form entry of a list<group> field (EditorParentParts flat form)', () => {
        const src = 'Part\n{\n\tEditorParentParts = [ armor_part ]\n}';
        const doc = parse(src);
        let list: AbstractNode | undefined;
        const walk = (n: any) => {
            if (isListNode(n)) list = n;
            for (const k of (n.elements ?? (n.type === 'Assignment' ? [n.left, n.right] : []))) walk(k);
        };
        walk(doc);
        const offset = src.indexOf('armor_part') + 3;
        expect(listElementReferenceTarget(list as any, offset)).toBe('Cosmoteer.Ships.Parts.PartRules');
    });

    // A reference list nested inside a tuple slot: the career map picker's
    // `CandidatesClosestToFactions = [3, [faction, …]]` (tuple of int and list<reference FactionRules>).
    it('resolves a reference list nested inside a tuple slot', () => {
        const src = 'Galaxy\n{\n\tType = StartingNodePicker\n\tCandidatesClosestToFactions = [3, [monolith]]\n}';
        const doc = parse(src);
        let inner: AbstractNode | undefined;
        const walk = (n: any) => {
            if (isListNode(n)) inner = n; // deepest list wins (visited last)
            for (const k of (n.elements ?? (n.type === 'Assignment' ? [n.left, n.right] : []))) walk(k);
        };
        walk(doc);
        const offset = src.indexOf('monolith') + 3;
        expect(listElementReferenceTarget(inner as any, offset)).toBe('Cosmoteer.Factions.FactionRules');
    });

    // The just-opened-entry state a modder is actually in when asking for ids: `[<cursor>` with
    // nothing typed yet must already resolve slot 0.
    it('resolves the first tuple slot in an empty just-opened entry', () => {
        const src = 'Part\n{\n\tResources\n\t[\n\t\t[\n\t]\n}';
        const doc = parse(src);
        let inner: AbstractNode | undefined;
        const walk = (n: any) => {
            if (isListNode(n)) inner = n;
            for (const k of (n.elements ?? (n.type === 'Assignment' ? [n.left, n.right] : []))) walk(k);
        };
        walk(doc);
        const offset = src.indexOf('[\n\t]') + 1;
        expect(listElementReferenceTarget(inner as any, offset)).toBe('Cosmoteer.Resources.ResourceRules');
    });
});
