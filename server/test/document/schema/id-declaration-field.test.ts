import { describe, expect, it } from 'vitest';
import { isIdDeclarationField, PART_RULES_CLASS } from '../../../src/document/schema/entity-schema';

const RESOURCE_RULES = 'Cosmoteer.Resources.ResourceRules';

// A slot that declares an object's own id must not be offered the ids the project already has, since
// those are exactly the ones it cannot use. The predicate is what tells the two apart, and it turns on
// the value naming an instance of the very class the field is written on.
describe('isIdDeclarationField', () => {
    it('treats a class identity key as a declaration', () => {
        expect(isIdDeclarationField(PART_RULES_CLASS, 'ID', PART_RULES_CLASS)).toBe(true);
        expect(isIdDeclarationField(RESOURCE_RULES, 'ID', RESOURCE_RULES)).toBe(true);
    });

    it('treats the legacy alias list as a declaration', () => {
        expect(isIdDeclarationField(PART_RULES_CLASS, 'OtherIDs', PART_RULES_CLASS)).toBe(true);
        expect(isIdDeclarationField(PART_RULES_CLASS, 'otherids', PART_RULES_CLASS)).toBe(true);
    });

    it('leaves a field naming another object a reference', () => {
        // A part's `EditorParentParts` names other parts, so the taken ids are the right answer.
        expect(isIdDeclarationField(PART_RULES_CLASS, 'EditorParentParts', PART_RULES_CLASS)).toBe(false);
        // An `ID` spelled on a class that is not the referenced one names something else.
        expect(isIdDeclarationField('Cosmoteer.Ships.Parts.PartComponentRules', 'ID', PART_RULES_CLASS)).toBe(false);
    });

    it('answers false when the owner class could not be resolved', () => {
        expect(isIdDeclarationField(undefined, 'ID', PART_RULES_CLASS)).toBe(false);
        expect(isIdDeclarationField(PART_RULES_CLASS, undefined, PART_RULES_CLASS)).toBe(false);
    });
});
