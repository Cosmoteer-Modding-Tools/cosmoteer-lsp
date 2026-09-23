import { describe, expect, it } from 'vitest';
import { fsPathToUri } from '../../src/cli/uri';
import { uriToFsPath } from '../../src/workspace/workspace-files';

// The command line and the server both name a file by uri, and a report links back to the file with
// the spelling the command line produced. A file on a network share carries its host in the two
// leading slashes, and a uri carries a host in its authority, so the two have to agree about where
// the host goes or the same file is keyed twice.
describe('the uri the command line spells a file with', () => {
    it('puts the host of a network share in the authority', () => {
        expect(fsPathToUri('//nas/share/mod/part.rules')).toBe('file://nas/share/mod/part.rules');
    });

    it('spells a network share the way the server reads it back', () => {
        const uri = fsPathToUri('//nas/share/mod/part.rules');
        expect(uriToFsPath(uri).replace(/\\/g, '/')).toBe('//nas/share/mod/part.rules');
    });

    it('leaves a drive path spelled the way it already was', () => {
        // The control: a fix that prefixed every path with a host would break this one. The drive
        // keeps the case it was handed, which is not the lower-cased spelling the server writes, and
        // the two still key the same file because `normalizeUri` folds it.
        expect(fsPathToUri('C:/mod/part.rules')).toBe('file:///C%3A/mod/part.rules');
    });

    it('escapes a segment that carries a character a uri reserves', () => {
        expect(fsPathToUri('C:/mod/a b#c.rules')).toBe('file:///C%3A/mod/a%20b%23c.rules');
    });

    it('leaves a uri it is handed alone', () => {
        expect(fsPathToUri('file:///c%3A/mod/part.rules')).toBe('file:///c%3A/mod/part.rules');
    });
});
