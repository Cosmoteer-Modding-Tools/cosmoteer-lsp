import { describe, expect, it } from 'vitest';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { isValueNode } from '../../../src/core/ast/ast';
import { findNodeAtPosition } from '../../../src/utils/ast.utils';
import { schemaReferenceFieldOf, mapKeyReferenceAt, mapKeyReferencesOf } from '../../../src/features/navigation/schema-id-reference.navigation';

// A `Type=`-dispatched group whose class (StartingNodePickerSpawner) has `AllowedFactions` typed
// `list<reference FactionRules>`.
const SRC = 'StartingNodePicker\n{\n\tType = StartingNodePicker\n\tAllowedFactions = [fringe]\n}';
const parse = () => parser(lexer(SRC), 'file:///t.rules').value;

const valueNode = (id: string) => {
    const doc = parse();
    let found: any;
    const walk = (n: any) => {
        if (isValueNode(n) && String(n.valueType.value) === id) found = n;
        const kids = n.elements ?? (n.type === 'Assignment' ? [n.left, n.right] : []) ?? [];
        for (const k of kids) walk(k);
    };
    walk(doc);
    return found;
};

describe('schemaReferenceFieldOf: list-element references', () => {
    it('recognizes a LIST-element reference (Field = [ ref ])', () => {
        expect(schemaReferenceFieldOf(valueNode('fringe'))).toEqual({
            targetClass: 'Cosmoteer.Factions.FactionRules',
            value: 'fringe',
        });
    });

    it('ignores a list element whose field is not a reference list', () => {
        // `MinConnections = [2]` would not be a reference; a non-entity bare value is not a ref.
        const doc = parser(lexer('StartingNodePicker\n{\n\tType = StartingNodePicker\n\tFoo = [bar]\n}'), 'file:///t.rules').value;
        let v: any;
        const walk = (n: any) => { if (isValueNode(n) && String(n.valueType.value) === 'bar') v = n; for (const k of (n.elements ?? (n.type === 'Assignment' ? [n.left, n.right] : []) ?? [])) walk(k); };
        walk(doc);
        expect(schemaReferenceFieldOf(v)).toBeUndefined();
    });
});

describe('mapKeyReferenceAt: map-key references', () => {
    // PartRules.MaxBuffValues is map<reference BuffType, percent>; the key `Engine` is an ID<BuffType>.
    const PART = 'Part\n{\n\tMaxBuffValues = { Engine = 100% }\n}';
    const at = (needle: string, off: number) => {
        const doc = parser(lexer(PART), 'file:///t.rules').value;
        const lineIdx = PART.split('\n').findIndex((l) => l.includes(needle));
        const character = PART.split('\n')[lineIdx].indexOf(needle) + off;
        return mapKeyReferenceAt(doc, { line: lineIdx, character });
    };

    it('recognizes a map key as an ID<X> reference', () => {
        expect(at('Engine', 0)).toEqual({ targetClass: 'Cosmoteer.Ships.Buffs.BuffType', value: 'Engine', node: expect.anything() });
    });

    it('does NOT treat the map field name itself as a key', () => {
        expect(at('MaxBuffValues', 0)).toBeUndefined();
    });

    it('returns undefined when the cursor is not on a map key', () => {
        const doc = parser(lexer('Part\n{\n\tDamage = 5\n}'), 'file:///t.rules').value;
        expect(mapKeyReferenceAt(doc, { line: 2, character: 2 })).toBeUndefined();
    });

    it('mapKeyReferencesOf yields every map key (for find-references and rename)', () => {
        const doc = parser(lexer('Part\n{\n\tMaxBuffValues = { Engine = 100%, Factory = 50% }\n}'), 'file:///t.rules').value;
        const keys = [...mapKeyReferencesOf(doc)];
        expect(keys.map((k) => k.value).sort()).toEqual(['Engine', 'Factory']);
        expect(keys.every((k) => k.targetClass === 'Cosmoteer.Ships.Buffs.BuffType')).toBe(true);
    });
});

describe('findNodeAtPosition descends into list/group values', () => {
    it('returns the list ELEMENT value, not the enclosing list', () => {
        const doc = parse();
        const line = SRC.split('\n').findIndex((l) => l.includes('AllowedFactions'));
        const character = SRC.split('\n')[line].indexOf('fringe') + 1;
        const node: any = findNodeAtPosition(doc, { line, character });
        expect(node?.type).toBe('Value');
        expect(String(node?.valueType?.value)).toBe('fringe');
    });
});
