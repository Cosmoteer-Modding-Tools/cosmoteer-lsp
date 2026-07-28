import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { watchDirectories, watchModAssemblies } from '../../../src/features/mod-schema/watch';
import { discoverModAssemblies } from '../../../src/features/mod-schema/mod-schema';

// The merged mod schema is only correct while it matches the assemblies on disk: a mod installed,
// updated or rebuilt after startup leaves the extraction behind, and every `Type=` its new build
// added comes back as an unknown discriminator on content the game accepts. Two things keep that
// from happening — the cache key notices a changed doc file beside an unchanged assembly, and the
// watcher notices the change at all.

const dirs: string[] = [];
const disposers: Array<() => void> = [];

/** A throwaway directory, removed after the test. */
const tempDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'cosmoteer-modwatch-'));
    dirs.push(dir);
    return dir;
};

/** Waits for the watcher's debounce plus the filesystem's own latency. */
const settle = (ms = 2500): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('watchDirectories', () => {
    it('watches each assembly folder and each search root, without duplicates', () => {
        const targets = watchDirectories(
            ['C:/mods/a/a.dll', 'C:/mods/a/b.dll', 'C:/mods/b/b.dll'],
            ['C:/mods', 'C:/mods/a']
        );
        expect(new Set(targets)).toEqual(new Set(['C:/mods', 'C:/mods/a', 'C:/mods/b']));
    });
});

describe('watchModAssemblies', () => {
    it('fires once for a burst of assembly writes', async () => {
        const dir = tempDir();
        let fired = 0;
        disposers.push(watchModAssemblies([dir], () => fired++));

        writeFileSync(join(dir, 'mod.dll'), 'one');
        writeFileSync(join(dir, 'mod.dll'), 'two');
        writeFileSync(join(dir, 'mod.xml'), '<doc/>');
        await settle();

        expect(fired).toBe(1);
    });

    it('fires for a mod folder appearing under a watched root', async () => {
        const root = tempDir();
        let fired = 0;
        disposers.push(watchModAssemblies([root], () => fired++));

        mkdirSync(join(root, '3768401176'));
        await settle();

        expect(fired).toBe(1);
    });

    it('ignores a file that cannot change the extraction', async () => {
        const dir = tempDir();
        let fired = 0;
        disposers.push(watchModAssemblies([dir], () => fired++));

        writeFileSync(join(dir, 'mod.rules'), 'Foo { }');
        writeFileSync(join(dir, 'logo.png'), 'not really a png');
        await settle();

        expect(fired).toBe(0);
    });

    it('stops firing once disposed', async () => {
        const dir = tempDir();
        let fired = 0;
        const dispose = watchModAssemblies([dir], () => fired++);
        dispose();

        writeFileSync(join(dir, 'mod.dll'), 'one');
        await settle();

        expect(fired).toBe(0);
    });

    it('survives a directory that does not exist', () => {
        expect(() => disposers.push(watchModAssemblies([join(tempDir(), 'nope')], () => undefined))).not.toThrow();
    });
});

describe('discoverModAssemblies', () => {
    it('stamps the XML doc file beside an assembly, so a doc-only change misses the cache', async () => {
        const dir = tempDir();
        writeFileSync(join(dir, 'mod.dll'), 'assembly');
        writeFileSync(join(dir, 'mod.xml'), '<doc><members/></doc>');

        const before = await discoverModAssemblies([dir]);
        expect(before).toHaveLength(1);
        expect(before[0].doc).toBeDefined();

        // The author documented one more field: same assembly, different prose.
        writeFileSync(join(dir, 'mod.xml'), '<doc><members><member name="F:A.B"/></members></doc>');
        const after = await discoverModAssemblies([dir]);
        expect(after[0].path).toBe(before[0].path);
        expect(after[0].mtimeMs).toBe(before[0].mtimeMs);
        expect(after[0].doc).not.toEqual(before[0].doc);
    });

    it('leaves the doc stamp unset when the author shipped none', async () => {
        const dir = tempDir();
        writeFileSync(join(dir, 'mod.dll'), 'assembly');
        const stamps = await discoverModAssemblies([dir]);
        expect(stamps[0].doc).toBeUndefined();
    });

    it('notices a doc file added beside an untouched assembly', async () => {
        const dir = tempDir();
        const assembly = join(dir, 'mod.dll');
        writeFileSync(assembly, 'assembly');
        const before = await discoverModAssemblies([dir]);

        writeFileSync(join(dir, 'mod.xml'), '<doc/>');
        // The assembly itself is deliberately untouched, which is exactly the case a dll-only cache
        // key missed: dropping in a doc file changed nothing it looked at.
        utimesSync(assembly, new Date(before[0].mtimeMs), new Date(before[0].mtimeMs));

        const after = await discoverModAssemblies([dir]);
        // `utimes` keeps whole milliseconds only, so the restored stamp is the same instant, not the
        // same float.
        expect(Math.abs(after[0].mtimeMs - before[0].mtimeMs)).toBeLessThan(1);
        expect(after[0].doc).toBeDefined();
    });
});
