import { describe, expect, it } from 'vitest';
import { valueRunAtCursor, wholeValueRange, withReplaceRange } from '../../../src/features/completion/completion-range';

// The client measures a completion's replace range with its own word pattern, which breaks at `.` and
// `/`. These helpers measure it on the server instead, so a slash-joined key and a dotted id replace
// the whole value the user typed rather than only its last word.
describe('valueRunAtCursor', () => {
    it('keeps the slashes of a partly typed key', () => {
        expect(valueRunAtCursor('    NameKey = "Parts/Cann')).toBe('Parts/Cann');
    });

    it('keeps a dotted id whole', () => {
        expect(valueRunAtCursor('    Part = cosmoteer.can')).toBe('cosmoteer.can');
    });

    it('stops at the opening quote and at an empty value position', () => {
        expect(valueRunAtCursor('    NameKey = "')).toBe('');
        expect(valueRunAtCursor('  Part = ')).toBe('');
    });
});

describe('wholeValueRange', () => {
    it('spans the typed value and ends at the cursor', () => {
        expect(wholeValueRange({ line: 3, character: 22 }, 'Parts/Cann')).toEqual({
            start: { line: 3, character: 12 },
            end: { line: 3, character: 22 },
        });
    });

    it('is empty when nothing is typed', () => {
        const range = wholeValueRange({ line: 3, character: 12 }, '');
        expect(range.start).toEqual(range.end);
    });
});

describe('withReplaceRange', () => {
    it('tags a bare label and preserves an existing suggestion', () => {
        const range = { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } };
        expect(withReplaceRange(['A', { label: 'B', detail: 'd' }], range)).toEqual([
            { label: 'A', range },
            { label: 'B', detail: 'd', range },
        ]);
    });
});
