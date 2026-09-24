import { sep } from 'path';
import { describe, expect, it } from 'vitest';
import { normalizeUri, uriToFsPath } from '../../src/utils/uri-path';
import { filePathToUri } from '../../src/document/reference-path';

// A mod folder on a network share reaches the server as `file://host/share/…`, where the host sits
// in the uri's authority rather than in the path. Both directions have to read it the same way, or
// the two spellings of one file never meet.
describe('a uri with an authority', () => {
    const uri = 'file://nas/mods/my_mod/a.rules';

    it('keeps the host in the path it decodes to', () => {
        expect(uriToFsPath(uri)).toBe(`${sep}${sep}nas${sep}mods${sep}my_mod${sep}a.rules`);
    });

    it('round-trips back to the spelling it came in as', () => {
        expect(filePathToUri(uriToFsPath(uri))).toBe(uri);
    });

    it('reaches the same key from either spelling', () => {
        expect(normalizeUri(uriToFsPath(uri))).toBe(normalizeUri(uri));
    });
});

// The control: a local path is not a share, so nothing may grow a second leading slash.
describe('a local uri', () => {
    const uri = 'file:///c%3A/mods/my_mod/a.rules';

    it('decodes to a drive path', () => {
        expect(uriToFsPath(uri)).toBe(`c:${sep}mods${sep}my_mod${sep}a.rules`);
    });

    it('round-trips back to the spelling it came in as', () => {
        expect(filePathToUri(uriToFsPath(uri))).toBe(uri);
    });

    it('is written with one slash in front of the drive', () => {
        expect(filePathToUri('c:\\mods\\my_mod\\a.rules')).toBe(uri);
    });
});
