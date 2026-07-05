import { describe, expect, it } from 'vitest';
import { isValidReference } from '../../src/utils/reference.utils';
import { stripReferenceWhitespace } from '../../src/features/navigation/navigation-strategy';

describe('stripReferenceWhitespace', () => {
    it('removes whitespace that ObjectText allows around `&`, `/` and segments', () => {
        // Regression (cosmoteer `build_gui.rules`): `& <file>/X` failed to resolve because the
        // navigate() prefix checks expected `&<`. Whitespace OUTSIDE a `<...>` file path is
        // insignificant in an ObjectText reference path.
        expect(stripReferenceWhitespace('& <./Data/a.rules>/X')).toBe('&<./Data/a.rules>/X');
        expect(stripReferenceWhitespace('&  ~/Part')).toBe('&~/Part');
        expect(stripReferenceWhitespace('^ / 0 / Part')).toBe('^/0/Part');
        expect(stripReferenceWhitespace('& /SW_X')).toBe('&/SW_X');
    });

    it('preserves whitespace INSIDE a `<...>` file path (filenames may contain spaces)', () => {
        expect(stripReferenceWhitespace('&<./Data/my file.rules>/X')).toBe('&<./Data/my file.rules>/X');
    });
});

// `isValidReference` ports the game's `Halfling.ObjectText.Validator.PATH_RE` (see the
// `inspect-cosmoteer-ot-format` skill), so these cases mirror what the real parser accepts.
describe('isValidReference', () => {
    it('accepts bare `~/…` and `^/…` references (a slash may follow the prefix)', () => {
        expect(isValidReference('~/MODIFIERS/OVERCLOCK_LERP')).toBe(true);
        expect(isValidReference('~/Part/^/0/BASE_THERMAL_PORT')).toBe(true);
        expect(isValidReference('^/0/Components')).toBe(true);
    });

    it('accepts the other reference forms', () => {
        expect(isValidReference('&~/Part/X')).toBe(true);
        expect(isValidReference('&<./Data/a.rules>/A')).toBe(true);
        expect(isValidReference('/PRIORITIES/Defense')).toBe(true);
        expect(isValidReference('../Sibling')).toBe(true);
        expect(isValidReference('&Name')).toBe(true);
        expect(isValidReference('&A.B.C')).toBe(true); // dotted identifier
    });

    it('accepts ground-truth forms our old heuristic wrongly rejected', () => {
        expect(isValidReference('^/0/:')).toBe(true); // `:` is a valid path segment
        expect(isValidReference('&#tag')).toBe(true); // `#`-prefixed identifier
        expect(isValidReference('&Part / X')).toBe(true); // whitespace around `/`
        // A bare relative name IS a valid path to the game (e.g. `: Parent` inheritance). Our
        // parser only ever classifies prefixed values as references, so this is harmless.
        expect(isValidReference('plainword')).toBe(true);
    });

    it('rejects malformed references', () => {
        expect(isValidReference('//bad')).toBe(false);
        expect(isValidReference('&~has~tilde')).toBe(false);
        expect(isValidReference('&Foo:Bar')).toBe(false); // `:` is a segment, not mid-identifier
    });
});
