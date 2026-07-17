import { describe, expect, it } from 'vitest';
import { fieldOf, fieldSignatureMarkdown, valueTypeLabel } from '../../../src/document/schema/schema';
import type { ValueType } from '../../../src/document/schema/schema.types';

const ref = (name: string): ValueType => ({ kind: 'reference', target: `Cosmoteer.${name}`, targetName: name });

// valueTypeLabel prefixes a standalone reference field with a `→` arrow (it "points to" its target),
// but the same arrow nested inside a `map`/`list`/`range`/`tuple` label reads as a rendering artifact
// (`map<→ DamageType, …>`). These tests pin that a reference drops the arrow once composed.
describe('valueTypeLabel', () => {
    it('shows the arrow for a standalone reference field', () => {
        expect(valueTypeLabel(ref('DamageType'))).toBe('→ DamageType');
    });

    it('drops the arrow for a reference nested in a map key or value', () => {
        const map: ValueType = { kind: 'map', key: ref('DamageType'), value: ref('StatusType') };
        expect(valueTypeLabel(map)).toBe('map<DamageType, StatusType>');
    });

    it('drops the arrow for a reference nested in a list', () => {
        expect(valueTypeLabel({ kind: 'list', element: ref('DamageType') })).toBe('DamageType[]');
    });

    it('drops the arrow for a reference nested in a range', () => {
        expect(valueTypeLabel({ kind: 'range', element: ref('DamageType') })).toBe('range<DamageType>');
    });

    it('drops the arrow for every reference element of a tuple', () => {
        const tuple: ValueType = { kind: 'tuple', elements: [ref('DamageType'), ref('StatusType')] };
        expect(valueTypeLabel(tuple)).toBe('[DamageType, StatusType]');
    });

    it('renders the real DamageResistances map without an arrow in the key', () => {
        const field = fieldOf('Cosmoteer.Ships.Parts.PartRules', 'DamageResistances')!;
        expect(valueTypeLabel(field.valueType)).toBe('map<DamageType, range<number | ModifiableValue group>>');
        // The field hover embeds the same label, so it must read cleanly there too.
        expect(fieldSignatureMarkdown(field)).toContain(
            '`map<DamageType, range<number | ModifiableValue group>>`',
        );
    });
});
