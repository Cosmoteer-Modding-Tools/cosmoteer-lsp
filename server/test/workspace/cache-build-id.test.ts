import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error the build script is plain JavaScript with no types of its own.
import { computeCacheBuildId } from '../../../esbuild.cache-id.mjs';

const REPO = join(__dirname, '..', '..', '..');
const idOf = (): string => (computeCacheBuildId as (root: string) => string)(REPO);

/** Appends a byte to a file, reads the id back and puts the file back the way it was. */
const idWithTouched = (relative: string): string => {
    const path = join(REPO, relative);
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
    it('changes when a validator changes, since the scan cache holds its findings', () => {
        expect(idWithTouched('server/src/features/diagnostics/validator.schema.ts')).not.toBe(idOf());
    });

    it('changes when the parser changes, since every index is built on it', () => {
        expect(idWithTouched('server/src/core/parser/parser.ts')).not.toBe(idOf());
    });

    it('does not change when the field and class prose changes', () => {
        expect(idWithTouched('server/src/document/schema/field-docs.json')).toBe(idOf());
    });

    it('does not change when a hover changes, which no cache holds', () => {
        expect(idWithTouched('server/src/features/hover/schema-hover.ts')).toBe(idOf());
    });
});
