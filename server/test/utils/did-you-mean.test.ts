import { describe, expect, it } from 'vitest';
import { closestMatch, levenshtein } from '../../src/utils/did-you-mean';

describe('levenshtein', () => {
    it('is zero for equal strings', () => {
        expect(levenshtein('Prohibited', 'Prohibited')).toBe(0);
    });

    it('counts a single substitution / insertion / deletion as 1', () => {
        expect(levenshtein('ProhibitedBy', 'PrhibitedBy')).toBe(1); // missing 'o'
        expect(levenshtein('abc', 'abx')).toBe(1);
        expect(levenshtein('abc', 'ab')).toBe(1);
    });

    it('handles empty strings', () => {
        expect(levenshtein('', 'abc')).toBe(3);
        expect(levenshtein('abc', '')).toBe(3);
    });
});

describe('closestMatch', () => {
    it('finds the closest plausible candidate', () => {
        expect(closestMatch('PrhibitedBy', ['ProhibitedBy', 'RequiredBy', 'Color'])).toBe('ProhibitedBy');
    });

    it('returns null when nothing is close enough (avoids nonsense suggestions)', () => {
        expect(closestMatch('Sprite', ['CompletelyDifferent', 'Other'])).toBeNull();
    });

    it('never suggests the identical string', () => {
        expect(closestMatch('Color', ['Color'])).toBeNull();
    });

    it('can match case-insensitively when asked', () => {
        // A genuine typo whose only near-match differs in case too.
        expect(closestMatch('Sparkk.png', ['spark.png'], true)).toBe('spark.png');
    });

    it('stays strict for short words (one edit max)', () => {
        expect(closestMatch('abc', ['xyz'])).toBeNull();
        expect(closestMatch('abc', ['abx'])).toBe('abx');
    });

    // A pool of ids or localization keys is full of long names that share a prefix and mean
    // something else, and the length rule alone always found one of them within a third of the
    // target. Three edits is what a mistyped name is worth, however long the name is.
    it('never spans more than three edits, however long the name is', () => {
        expect(closestMatch('Cosmoteer/Parts/StructureArmorPlate', ['Cosmoteer/Parts/StructureBlastDoor'])).toBeNull();
        expect(closestMatch('Cosmoteer/Parts/StructureArmorPlate', ['Cosmoteer/Parts/StructureArmorPlat'])).toBe(
            'Cosmoteer/Parts/StructureArmorPlat'
        );
    });

    // Two names that agree on everything but their numbers are two things that both exist, so
    // offering one for the other rewires the file to a part nobody asked for.
    it('refuses a name that differs only in the numbers it carries', () => {
        expect(closestMatch('armor_8x8', ['armor_1x1'])).toBeNull();
        expect(closestMatch('Turret_2', ['Turret_3'])).toBeNull();
        expect(closestMatch('Turret_12', ['Turret_3'])).toBeNull();
    });

    it('still corrects a misspelt name that carries a number', () => {
        expect(closestMatch('Turrret_2', ['Turret_2'])).toBe('Turret_2');
    });
});
