import { describe, expect, it } from 'vitest';
import { fieldSignatureMarkdown, typeDef } from '../../../src/document/schema/schema';

// The banner the hover and the completion documentation put under a dead field's signature has to
// say what the diagnostic on that same field says. A field the game reaches through an empty `if`
// body is read, so "never read" is false, and the hint sitting one line away in the same editor
// would be contradicted by the popup above it.
//
// Its own file rather than a block in `schema-dead-fields.test.ts`: importing `schema.ts` applies
// the overlay to the shared bundle object, which that suite's raw-versus-overlaid delta reads.
describe('the dead-field banner agrees with the diagnostic', () => {
    const signatureOf = (cls: string, name: string): string => {
        const field = typeDef(cls)?.fields.find((f) => f.name === name);
        expect(field).toBeTruthy();
        return fieldSignatureMarkdown(field!, cls);
    };

    it('says the game does nothing with the value', () => {
        expect(signatureOf('Cosmoteer.Ships.Parts.PartRules', 'FireDamageFactor')).toContain(
            '⚠ declared, and the game does nothing with the value'
        );
    });

    it('never claims the game does not read the field', () => {
        expect(signatureOf('Cosmoteer.Ships.Parts.PartRules', 'FireDamageFactor')).not.toContain('never read');
    });

    it('leaves a live field without a banner', () => {
        expect(signatureOf('Cosmoteer.Ships.Parts.PartRules', 'MaxHealth')).not.toContain('⚠ declared');
    });
});
