import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error the build script is plain JavaScript with no types of its own.
import { computeCacheBuildId } from '../../../esbuild.cache-id.mjs';

const REPO = join(__dirname, '..', '..', '..');

/**
 * A copy of everything the id is computed over. The id is a hash of real sources, so what it covers
 * can only be judged against the real file set, but touching those files where they live makes the
 * test a race against every other process writing the repo. The copy keeps the real sources and the
 * real import closure and moves only the mutation off the shared tree.
 */
let root: string;

/** The id of the untouched copy. It is the same for every case, and computing it is the slow half. */
let base: string;

const idOf = (): string => (computeCacheBuildId as (root: string) => string)(root);

/** Appends a byte to a file in the copy, reads the id back and puts the copy back the way it was. */
const idWithTouched = (relative: string): string => {
    const path = join(root, relative);
    const before = readFileSync(path);
    try {
        writeFileSync(path, Buffer.concat([before, Buffer.from(' ')]));
        return idOf();
    } finally {
        writeFileSync(path, before);
    }
};

// The id gates every on-disk cache, so what it covers decides what an upgrade throws away. Both
// directions matter: too narrow serves a stale answer, too wide makes every user rebuild their
// caches for a change no cached answer depends on.
describe('the cache build id', () => {
    beforeAll(() => {
        root = mkdtempSync(join(tmpdir(), 'cache-build-id-'));
        cpSync(join(REPO, 'server', 'src'), join(root, 'server', 'src'), { recursive: true });
        cpSync(join(REPO, 'package-lock.json'), join(root, 'package-lock.json'));
        base = idOf();
    }, 120_000);

    afterAll(() => rmSync(root, { recursive: true, force: true }));

    it('changes when a validator changes, since the scan cache holds its findings', () => {
        expect(idWithTouched('server/src/features/diagnostics/validator.schema.ts')).not.toBe(base);
    }, 60_000);

    it('changes when the parser changes, since every index is built on it', () => {
        expect(idWithTouched('server/src/core/parser/parser.ts')).not.toBe(base);
    }, 60_000);

    it('does not change when the field and class prose changes', () => {
        expect(idWithTouched('server/src/document/schema/field-docs.json')).toBe(base);
    }, 60_000);

    it('does not change when a hover changes, which no cache holds', () => {
        expect(idWithTouched('server/src/features/hover/schema-hover.ts')).toBe(base);
    }, 60_000);
});
