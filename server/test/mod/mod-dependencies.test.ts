import { describe, expect, it } from 'vitest';
import { join } from 'path';
import {
    addDependencyEdit,
    declaredDependenciesOf,
    dependencyTokenOf,
    identityOfMod,
    isDeclaredDependency,
    manifestPathsIn,
} from '../../src/mod/mod-dependencies';
import { FIXTURES_DIR } from '../helpers';

const DEPENDENCY_MOD = join(FIXTURES_DIR, 'dependency-mod');
const UNDECLARED_MOD = join(FIXTURES_DIR, 'undeclared-dep-mod');
const DECLARED_MOD = join(FIXTURES_DIR, 'declared-dep-mod');

// The game reads no dependency field, so this is a statement between the author and the editor.
// It only earns its place if it reads what a real manifest writes and writes what one would.
describe('mod dependencies', () => {
    it('finds every manifest of a mod', () => {
        expect(manifestPathsIn(DEPENDENCY_MOD).map((path) => path.replace(/\\/g, '/'))).toEqual([
            `${DEPENDENCY_MOD.replace(/\\/g, '/')}/mod.rules`,
        ]);
    });

    it('reads a mod by its manifest id and name', async () => {
        const identity = await identityOfMod(DEPENDENCY_MOD);
        expect(identity.manifestId).toBe('Test.DependencyMod');
        expect(identity.name).toBe('Dependency Fixture');
        // Not installed through the workshop, so there is no published file id to name it by.
        expect(identity.publishedFileId).toBeUndefined();
        expect(dependencyTokenOf(identity)).toBe('Test.DependencyMod');
    });

    it('reads what a manifest declares', async () => {
        expect(await declaredDependenciesOf(DECLARED_MOD)).toEqual(new Set(['test.dependencymod']));
        expect(await declaredDependenciesOf(UNDECLARED_MOD)).toEqual(new Set());
    });

    it('matches a declaration however it is cased', async () => {
        const identity = await identityOfMod(DEPENDENCY_MOD);
        expect(isDeclaredDependency(new Set(['test.dependencymod']), identity)).toBe(true);
        expect(isDeclaredDependency(new Set(['somebody.else']), identity)).toBe(false);
    });

    it('matches a declaration written as the published file id', () => {
        const identity = { root: 'x', publishedFileId: '3577650065', manifestId: 'Some.Mod' };
        expect(isDeclaredDependency(new Set(['3577650065']), identity)).toBe(true);
    });

    it('appends to a list the manifest already has', async () => {
        const insert = await addDependencyEdit(DECLARED_MOD, 'Other.Mod');
        expect(insert).not.toBeNull();
        expect(insert!.uri).toContain('declared-dep-mod/mod.rules');
        expect(insert!.edit.newText).toBe(', "Other.Mod"');
        // Right after the last entry of the existing list, on its line.
        expect(insert!.edit.range.start.line).toBe(4);
    });

    it('writes the list above the actions when the manifest has none', async () => {
        const insert = await addDependencyEdit(UNDECLARED_MOD, 'Test.DependencyMod');
        expect(insert).not.toBeNull();
        expect(insert!.edit.newText).toBe('Dependencies = ["Test.DependencyMod"]\n\n');
        expect(insert!.edit.range.start.character).toBe(0);
        // The `Actions` line, so the new member sits with ID, Name and Version rather than below them.
        expect(insert!.edit.range.start.line).toBe(5);
    });

    it('answers nothing for a folder that is not a mod', async () => {
        expect(await addDependencyEdit(join(FIXTURES_DIR, 'nope'), 'x')).toBeNull();
    });
});
