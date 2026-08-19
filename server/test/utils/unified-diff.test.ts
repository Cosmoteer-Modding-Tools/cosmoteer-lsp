import { describe, expect, it } from 'vitest';
import { unifiedDiff } from '../../src/utils/unified-diff';

describe('unified diff', () => {
    it('says nothing when the two texts are the same', () => {
        expect(unifiedDiff('a\nb\n', 'a\nb\n', 'x.rules')).toBe('');
    });

    it('reports a removed line with its surrounding context', () => {
        const before = ['Part', '{', '\tA = 1', '\tB = 2', '\tC = 3', '}', ''].join('\n');
        const after = ['Part', '{', '\tA = 1', '\tC = 3', '}', ''].join('\n');
        expect(unifiedDiff(before, after, 'parts/a.rules')).toBe(
            [
                '--- a/parts/a.rules',
                '+++ b/parts/a.rules',
                '@@ -1,6 +1,5 @@',
                ' Part',
                ' {',
                ' \tA = 1',
                '-\tB = 2',
                ' \tC = 3',
                ' }',
                '',
            ].join('\n')
        );
    });

    it('reports a whole new file as one added hunk', () => {
        expect(unifiedDiff('', 'Part\n{\n}\n', 'base_part.rules')).toBe(
            ['--- a/base_part.rules', '+++ b/base_part.rules', '@@ -0,0 +1,3 @@', '+Part', '+{', '+}', ''].join('\n')
        );
    });

    it('keeps two distant changes in separate hunks and counts the lines of each', () => {
        const before = Array.from({ length: 30 }, (_, index) => `line ${index}`).join('\n');
        const after = before.replace('line 2', 'line two').replace('line 25', 'line twenty-five');
        const diff = unifiedDiff(before, after, 'x.rules');
        expect(diff.match(/^@@/gm)).toHaveLength(2);
        expect(diff).toContain('@@ -1,6 +1,6 @@');
        expect(diff).toContain('-line 25');
        expect(diff).toContain('+line twenty-five');
    });

    it('folds two nearby changes into one hunk rather than repeating the lines between them', () => {
        const before = Array.from({ length: 12 }, (_, index) => `line ${index}`).join('\n');
        const after = before.replace('line 4', 'line four').replace('line 6', 'line six');
        expect(unifiedDiff(before, after, 'x.rules').match(/^@@/gm)).toHaveLength(1);
    });

    it('reads a file that ends in a newline as the same lines as one that does not', () => {
        expect(unifiedDiff('a\nb', 'a\nb\n', 'x.rules')).toBe('');
    });
});
