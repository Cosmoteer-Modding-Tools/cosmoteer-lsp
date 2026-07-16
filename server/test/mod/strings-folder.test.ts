import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { isStringsFile } from '../../src/mod/strings-folder';

// Language-strings files hold localization text, so the value validators skip asset/math checks for
// them. Detection is by a `strings/` path segment (the default `./strings` StringsFolder, used by the
// base game and by convention in mods). The base game's `cosmoteer.rules` declares no StringsFolder.
const token = CancellationToken.None;

describe('isStringsFile', () => {
    it('recognizes a file under a `strings/` directory (default ./strings)', async () => {
        expect(await isStringsFile('file:///c%3A/Game/Data/strings/en.rules', token)).toBe(true);
        expect(await isStringsFile('file:///c%3A/mymod/strings/de.rules', token)).toBe(true);
    });

    it('does not treat an ordinary file as a strings file', async () => {
        expect(await isStringsFile('file:///c%3A/Game/Data/parts/reactor/reactor.rules', token)).toBe(false);
        // `substrings` must not match the `strings/` segment.
        expect(await isStringsFile('file:///c%3A/Game/Data/substrings/x.rules', token)).toBe(false);
    });

    it('returns false for an undefined uri', async () => {
        expect(await isStringsFile(undefined, token)).toBe(false);
    });
});
