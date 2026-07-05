import { describe, expect, it } from 'vitest';
import { filePathToDirectoryPath } from '../../../src/features/navigation/navigation-strategy';

// `filePathToDirectoryPath` turns a document URI into the on-disk directory the reference resolver
// walks. It used to hand-patch only the lowercase `c%3A` drive VS Code happens to send; an
// uppercase or non-`C:` drive was left as a literal `C%3A`/`D%3A`, so readdir failed and EVERY
// relative reference was wrongly flagged. It now decodes generically.
describe('filePathToDirectoryPath URI decoding', () => {
    it('decodes the lowercase drive form VS Code sends', () => {
        expect(filePathToDirectoryPath('file:///c%3A/Users/foo/bar.rules')).toBe('C:/Users/foo/');
    });

    it('decodes an UPPERCASE-encoded drive (the regression that caused mass false positives)', () => {
        expect(filePathToDirectoryPath('file:///C%3A/Users/foo/bar.rules')).toBe('C:/Users/foo/');
    });

    it('decodes a non-C drive letter', () => {
        expect(filePathToDirectoryPath('file:///d%3A/Mods/x/y.rules')).toBe('D:/Mods/x/');
    });

    it('decodes spaces and parentheses anywhere in the path', () => {
        expect(filePathToDirectoryPath('file:///c%3A/My%20Mods/a%20%28copy%29/z.rules')).toBe('C:/My Mods/a (copy)/');
    });

    it('handles an unencoded colon drive', () => {
        expect(filePathToDirectoryPath('file:///C:/Users/foo/bar.rules')).toBe('C:/Users/foo/');
    });

    it('leaves a plain OS path (non-URI) ending in .rules as its directory', () => {
        expect(filePathToDirectoryPath('C:/Users/foo/bar.rules')).toBe('C:/Users/foo/');
    });
});
