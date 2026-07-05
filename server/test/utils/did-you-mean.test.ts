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
});
