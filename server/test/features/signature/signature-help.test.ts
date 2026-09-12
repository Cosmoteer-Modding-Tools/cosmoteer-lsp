import { describe, expect, it } from 'vitest';
import { computeSignatureHelp } from '../../../src/features/signature/signature-help.service';

// The cursor position is marked with `|` in each input; the helper strips it and computes the offset.
const at = (marked: string) => {
    const offset = marked.indexOf('|');
    if (offset < 0) throw new Error('missing cursor marker');
    return computeSignatureHelp(marked.replace('|', ''), offset);
};

describe('signature help for math functions', () => {
    it('shows a curated signature with the active parameter inside a call', () => {
        const help = at('Damage = log(|');
        expect(help?.signatures[0].label).toBe('log(base, x)');
        expect(help?.activeParameter).toBe(0);
        expect(help?.signatures[0].documentation).toMatch(/Logarithm of x/);
    });

    it('advances the active parameter past each comma', () => {
        expect(at('X = round(2, |')?.activeParameter).toBe(1);
        expect(at('X = log(10, |')?.activeParameter).toBe(1);
    });

    it('keeps a variadic function highlighting its single slot', () => {
        const help = at('X = max(1, 2, 3, |');
        expect(help?.signatures[0].label).toBe('max(…values)');
        expect(help?.activeParameter).toBe(0);
    });

    it('resolves the INNER call when nested', () => {
        // cursor sits inside sqrt(, not the outer floor(
        const help = at('X = floor(sqrt(|');
        expect(help?.signatures[0].label).toBe('sqrt(x)');
    });

    it('counts commas only at the innermost call depth', () => {
        // a comma inside a grouping paren must not advance max's argument index
        const help = at('X = max(1, (2 + 3), |');
        expect(help?.signatures[0].label).toBe('max(…values)');
    });

    it('clamps an over-typed fixed-arity call to the last parameter', () => {
        // ceil takes one arg; extra commas keep the last (only) parameter lit, never -1
        expect(at('X = ceil(a, b, |')?.activeParameter).toBe(0);
    });

    it('handles a comma inside a string argument', () => {
        const help = at('X = db2vol("-3, 0|');
        expect(help?.signatures[0].label).toBe('db2vol("decibels")');
        expect(help?.activeParameter).toBe(0);
    });

    it('derives a signature from the registry arity for an unmodelled mXparser function', () => {
        // `gamma` is unary and `root` binary in the registry vocabulary, so even without curated
        // parameter names the signature shows the real argument count.
        expect(at('X = gamma(|')?.signatures[0].label).toBe('gamma(x)');
        expect(at('X = root(|')?.signatures[0].label).toBe('root(a, b)');
    });

    it('returns null outside any function call', () => {
        expect(at('Damage = 5 + |')).toBeNull();
        expect(at('Speed = (2 + 3|')).toBeNull(); // plain grouping paren, not a call
    });

    it('returns null for an unknown function name', () => {
        expect(at('X = notafunc(|')).toBeNull();
    });

    it('answers nothing for a miscased name, which the game refuses too', () => {
        // mXparser is case-sensitive: `CEIL(0)` is an invalid token, not a call.
        expect(at('X = CEIL(|')).toBeNull();
        expect(at('X = ceil(|')?.signatures[0].label).toBe('ceil(x)');
    });

    it('does not answer inside a comment or after an escaped quote', () => {
        expect(at('	// ceil(|')).toBeNull();
        expect(at('X = 1 // see ceil(|')).toBeNull();
        expect(at('A = "say \\"hi\\""\nX = |')).toBeNull();
    });

    it('does not carry a call across the line above', () => {
        expect(at('X = ceil(\nY = |')).toBeNull();
    });
});
