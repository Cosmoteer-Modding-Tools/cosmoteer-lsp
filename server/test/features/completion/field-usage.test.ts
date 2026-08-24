import { describe, expect, it } from 'vitest';
import { fieldUsageRank } from '../../../src/features/completion/field-usage';

const PART_RULES = 'Cosmoteer.Ships.Parts.PartRules';

// A class such as PartRules declares over a hundred fields, and alphabetical order puts the ones
// the game itself never writes in front of the ones every part is written with. The ranks come
// from counting the shipped files, see tools/fieldstats/fieldstats.ts.
describe('the rank a field takes in the completion list', () => {
    it('puts a field the game writes on nearly every part in front of a rare one', () => {
        expect(fieldUsageRank(PART_RULES, 'MaxHealth') < fieldUsageRank(PART_RULES, 'AIFirepowerRating')).toBe(true);
    });

    it('reads the name the way the game binds it, ignoring case', () => {
        expect(fieldUsageRank(PART_RULES, 'maxhealth')).toBe(fieldUsageRank(PART_RULES, 'MaxHealth'));
    });

    it('sends a field nothing counted behind every counted one', () => {
        expect(fieldUsageRank(PART_RULES, 'NoSuchField') > fieldUsageRank(PART_RULES, 'MaxHealth')).toBe(true);
    });

    it('answers for a group whose class did not resolve, rather than throwing', () => {
        expect(fieldUsageRank(undefined, 'MaxHealth')).toBe(fieldUsageRank('No.Such.Class', 'MaxHealth'));
    });

    it('keeps the rank two digits, so the sort key stays short', () => {
        expect(fieldUsageRank(PART_RULES, 'MaxHealth')).toMatch(/^\d{2}$/);
    });
});
