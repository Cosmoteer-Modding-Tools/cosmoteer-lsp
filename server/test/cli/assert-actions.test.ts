import { describe, expect, it } from 'vitest';
import { join } from 'path';
import {
    collectManifestActions,
    countActionEntries,
    findActionFragments,
    includeReferencesOf,
    referenceEntriesOf,
    splitReference,
} from '../../src/cli/assert/actions';
import { DocumentCache, pathKey } from '../../src/cli/assert/documents';
import { walkModFiles } from '../../src/cli/assert/walk';

// Collecting the actions of a mod is the half of the load check that decides what is judged at all.
// A miss here is silent: the report would say every action loads while never having seen half of
// them, which is the one outcome this command must not produce.

const MOD_DIR = join(__dirname, 'fixtures', 'assert-mod');
const CLEAN_DIR = join(__dirname, 'fixtures', 'assert-clean-mod');

describe('collecting a mod actions', () => {
    it('reads the manifest own list and the list it pulls in from another file', async () => {
        const cache = new DocumentCache();
        const manifest = await cache.get(join(MOD_DIR, 'mod.rules'));
        const collection = await collectManifestActions(manifest!, MOD_DIR, cache);

        const verbs = collection.records.map((record) => record.action.verbText);
        expect(verbs).toEqual([
            'Add',
            'Add',
            'AddBase',
            'Add',
            'Add',
            'Add',
            'Overrides',
            'Remove',
            'Frobnicate',
            'AddMany',
            'Add',
            'Remove',
        ]);
        expect(collection.includedFiles.map(pathKey)).toEqual([pathKey(join(MOD_DIR, 'fragment_actions.rules'))]);
        expect(collection.unfollowed).toEqual([]);
        expect(collection.referenceEntries).toEqual([]);
    });

    it('gives every entry the file and the line it is written on', async () => {
        const cache = new DocumentCache();
        const manifest = await cache.get(join(MOD_DIR, 'mod.rules'));
        const collection = await collectManifestActions(manifest!, MOD_DIR, cache);

        const fromFragment = collection.records.filter((record) => record.file.endsWith('fragment_actions.rules'));
        expect(fromFragment).toHaveLength(2);
        for (const record of collection.records) {
            expect(record.line).toBeGreaterThan(0);
            expect(record.endOffset).toBeGreaterThan(record.startOffset);
        }
    });

    it('finds the files that hold an action list of their own', async () => {
        const cache = new DocumentCache();
        const { rulesFiles, manifests } = await walkModFiles(MOD_DIR);
        const fragments = await findActionFragments(rulesFiles, manifests, cache);
        expect(fragments.map((file) => file.replace(/\\/g, '/').split('/').pop())).toEqual([
            'fragment_actions.rules',
            'orphan_actions.rules',
        ]);
    });

    it('counts the entries of a file no manifest includes rather than reading each of them', async () => {
        const cache = new DocumentCache();
        const parsed = await cache.get(join(MOD_DIR, 'orphan_actions.rules'));
        expect(countActionEntries(parsed!)).toBe(1);
    });

    it('reads a mod that pulls nothing in', async () => {
        const cache = new DocumentCache();
        const manifest = await cache.get(join(CLEAN_DIR, 'mod.rules'));
        const collection = await collectManifestActions(manifest!, CLEAN_DIR, cache);
        expect(collection.records).toHaveLength(1);
        expect(collection.includedFiles).toEqual([]);
        expect(collection.unfollowed).toEqual([]);
    });
});

describe('reading a reference', () => {
    it('splits the file from the path inside it', () => {
        expect(splitReference('&<launcher.rules>/Actions')).toEqual({ file: 'launcher.rules', member: 'Actions' });
        expect(splitReference('<a/b.rules>')).toEqual({ file: 'a/b.rules', member: '' });
    });

    it('refuses a path that leaves the mod, which is not the mod file to read', () => {
        expect(splitReference('<./Data/cosmoteer.rules>/Actions')).toBeUndefined();
        expect(splitReference('<C:/games/x.rules>/Actions')).toBeUndefined();
        expect(splitReference('Actions')).toBeUndefined();
    });
});

describe('telling an include from an entry', () => {
    it('follows what a list inherits and leaves its own entries alone', async () => {
        const cache = new DocumentCache();
        const manifest = await cache.get(join(MOD_DIR, 'mod.rules'));
        const list = manifest!.document.elements.find(
            (element) => 'identifier' in element && (element as { identifier?: { name: string } }).identifier?.name === 'Actions'
        );
        expect(includeReferencesOf(list!)).toEqual(['&<fragment_actions.rules>/Actions']);
        expect(referenceEntriesOf(list!)).toEqual([]);
    });
});
