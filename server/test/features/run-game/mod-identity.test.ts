import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadedModKeyOf, sameLoadedMod } from '../../../src/features/run-game/mod-identity';
import { duplicateEnabledMod } from '../../../src/features/run-game/run-game.command';

const root = mkdtempSync(join(tmpdir(), 'modkey-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Writes a mod folder with the given manifest files, and returns its path. */
const modFolder = (name: string, manifests: Record<string, string>): string => {
    const folder = join(root, name);
    mkdirSync(folder, { recursive: true });
    for (const [file, text] of Object.entries(manifests)) writeFileSync(join(folder, file), text, 'utf8');
    return folder;
};

/** A manifest body, with whatever extra members the case needs. */
const manifest = (id: string, version: string, extra = ''): string =>
    `ID = "${id}"\nName = "A Mod"\nVersion = "${version}"\n${extra}`;

// The game keys every loaded mod by the id and version of the manifest it selected, so reading the
// wrong file means judging the wrong key.
describe('the key the game loads a mod folder under', () => {
    it('reads a single manifest whatever it declares', async () => {
        const folder = modFolder('single', { 'mod.rules': manifest('me.mod', '1.2') });
        expect(await loadedModKeyOf(folder)).toEqual({ id: 'me.mod', version: '1.2' });
    });

    it('reads a missing version as the empty string the loader stores', async () => {
        const folder = modFolder('no-version', { 'mod.rules': 'ID = "me.mod"\nName = "A Mod"\n' });
        expect(await loadedModKeyOf(folder)).toEqual({ id: 'me.mod', version: '' });
    });

    it('has no key for a folder with no manifest', async () => {
        const folder = modFolder('empty', {});
        expect(await loadedModKeyOf(folder)).toBeNull();
    });

    it('prefers a variant that says to use it when no version matches', async () => {
        const folder = modFolder('variants', {
            'mod.rules': manifest('me.mod', 'plain'),
            'mod_old.rules': manifest('me.mod', 'fallback', 'CompatibleGameVersions = ["0.1.0"]\nUseThisFileIfNoVersionMatch = true\n'),
        });
        expect(await loadedModKeyOf(folder)).toEqual({ id: 'me.mod', version: 'fallback' });
    });

    it('passes over a variant for a version nothing matches', async () => {
        const folder = modFolder('stale-variant', {
            'mod.rules': manifest('me.mod', 'plain'),
            'mod_old.rules': manifest('me.mod', 'stale', 'CompatibleGameVersions = ["0.1.0"]\n'),
        });
        expect(await loadedModKeyOf(folder)).toEqual({ id: 'me.mod', version: 'plain' });
    });
});

// `ModData.Equals` compares both halves with `string.Equals`, so the loader's own compare is
// ordinal and two ids differing in case are two mods.
describe('deciding whether the game sees one mod or two', () => {
    it('matches an equal id and version', () => {
        expect(sameLoadedMod({ id: 'me.mod', version: '1' }, { id: 'me.mod', version: '1' })).toBe(true);
    });

    it('separates two versions of the same id', () => {
        expect(sameLoadedMod({ id: 'me.mod', version: '1' }, { id: 'me.mod', version: '2' })).toBe(false);
    });

    it('separates ids that differ only in case', () => {
        expect(sameLoadedMod({ id: 'me.Mod', version: '1' }, { id: 'me.mod', version: '1' })).toBe(false);
    });
});

// A mod subscribed on the workshop and checked out locally is one mod to the loader, which throws
// on the second copy before it reads any rules.
describe('finding a second enabled copy of the mod being run', () => {
    it('names the other folder that declares the same id and version', async () => {
        const ours = modFolder('ours', { 'mod.rules': manifest('me.mod', '204.304') });
        const subscribed = modFolder('subscribed', { 'mod.rules': manifest('me.mod', '204.304') });
        expect(await duplicateEnabledMod(ours, [subscribed])).toBe(subscribed);
    });

    it('leaves a different mod alone', async () => {
        const ours = modFolder('ours-2', { 'mod.rules': manifest('me.mod', '1') });
        const other = modFolder('other-mod', { 'mod.rules': manifest('you.mod', '1') });
        expect(await duplicateEnabledMod(ours, [other])).toBeNull();
    });

    it('leaves another version of the same mod alone, which the loader files separately', async () => {
        const ours = modFolder('ours-3', { 'mod.rules': manifest('me.mod', '2') });
        const older = modFolder('older-copy', { 'mod.rules': manifest('me.mod', '1') });
        expect(await duplicateEnabledMod(ours, [older])).toBeNull();
    });

    it('skips an entry that names this same mod, which is what a previous run enabled', async () => {
        const ours = modFolder('ours-4', { 'mod.rules': manifest('me.mod', '1') });
        expect(await duplicateEnabledMod(ours, [join(root, '.', 'ours-4')])).toBeNull();
    });

    it('judges nothing when this mod declares no id', async () => {
        const ours = modFolder('idless', { 'mod.rules': 'Name = "A Mod"\n' });
        const other = modFolder('some-mod', { 'mod.rules': manifest('me.mod', '1') });
        expect(await duplicateEnabledMod(ours, [other])).toBeNull();
    });
});
