import { describe, expect, it } from 'vitest';
import { join } from 'path';
import { DocumentCache } from '../../src/cli/assert/documents';
import { chooseManifest, metadataFailures, readCandidates } from '../../src/cli/assert/manifest';
import { walkModFiles } from '../../src/cli/assert/walk';

// The manifest rules the game applies before it runs a single action. A mod can fail to load here
// without any of its actions being wrong, so the check has to answer this half too.

const FIXTURES = join(__dirname, 'fixtures', 'assert-manifests');

/**
 * Read every manifest of one fixture folder.
 *
 * @param folder the folder name under the manifest fixtures.
 * @returns the candidates the game would consider.
 */
const candidatesOf = async (folder: string) => {
    const cache = new DocumentCache();
    const { manifests } = await walkModFiles(join(FIXTURES, folder));
    return readCandidates(manifests, cache);
};

describe('the metadata the game refuses to load a mod without', () => {
    it('reports a manifest with no ID', async () => {
        const [candidate] = await candidatesOf('no-id');
        const failures = metadataFailures(candidate, 'mod.rules');
        expect(failures.map((failure) => failure.subject)).toEqual(['ID']);
        expect(failures[0].detail).toContain('starts without this mod');
    });

    it('reports an ID with nothing on one side of its dot', async () => {
        const [candidate] = await candidatesOf('dotless');
        expect(metadataFailures(candidate, 'mod.rules')[0].detail).toContain('author_name.mod_name');
    });

    it('reports a manifest with no Name', async () => {
        const [candidate] = await candidatesOf('no-name');
        expect(metadataFailures(candidate, 'mod.rules').map((failure) => failure.subject)).toEqual(['Name']);
    });

    it('passes a manifest that carries both', async () => {
        const cache = new DocumentCache();
        const { manifests } = await walkModFiles(join(__dirname, 'fixtures', 'assert-clean-mod'));
        const [candidate] = await readCandidates(manifests, cache);
        expect(metadataFailures(candidate, 'mod.rules')).toEqual([]);
        expect(candidate.id).toBe('Test.AssertClean');
        expect(candidate.name).toBe('Assert Clean Fixture');
    });
});

describe('choosing between several manifests', () => {
    it('takes the only one without looking inside it, as the game does', async () => {
        const candidates = await candidatesOf('no-id');
        const choice = chooseManifest(candidates);
        expect(choice.selected).toHaveLength(1);
        expect(choice.undecided).toBe(false);
    });

    it('refuses to guess which of several the running game version picks', async () => {
        const candidates = await candidatesOf('versioned');
        const choice = chooseManifest(candidates);
        expect(candidates).toHaveLength(2);
        expect(choice.selected).toHaveLength(2);
        expect(choice.undecided).toBe(true);
        expect(choice.selected.some((candidate) => candidate.useThisFileIfNoVersionMatch)).toBe(true);
    });
});

describe('finding the manifests', () => {
    it('reads the two names the game reads and nothing else', async () => {
        const { manifests, rulesFiles } = await walkModFiles(join(__dirname, 'fixtures', 'assert-mod'));
        expect(manifests.map((file) => file.split(/[\\/]/).pop())).toEqual(['mod.rules']);
        expect(rulesFiles).toHaveLength(4);
    });
});
