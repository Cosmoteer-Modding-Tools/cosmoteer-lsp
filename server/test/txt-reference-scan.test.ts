import { describe, expect, it } from 'vitest';
import { join } from 'path';
import { CancellationToken } from 'vscode-languageserver';
import { collectReferencedTxtKeys } from '../src/features/navigation/txt-reference-scan';
import { foldPathCase } from '../src/workspace/fs-cache';
import { FIXTURES_DIR } from './helpers';

const MOD_DIR = join(FIXTURES_DIR, 'txt-reference-mod');
const part = (name: string): string => join(MOD_DIR, 'parts', name);
const token = CancellationToken.None;

/**
 * Collects the fixture mod's referenced `.txt` keys.
 *
 * @returns the referenced keys.
 */
const scan = async (): Promise<Set<string>> => {
    const keys = await collectReferencedTxtKeys([MOD_DIR], token);
    if (!keys) throw new Error('expected a reference set, the fixture holds .txt files');
    return keys;
};

/**
 * Whether the scan recorded a fixture file as referenced.
 *
 * @param keys the scan's reference set.
 * @param name the part file's name.
 * @returns true when the file is referenced.
 */
const referenced = (keys: Set<string>, name: string): boolean => keys.has(foldPathCase(part(name)));

describe('txt reference scan', () => {
    it('records a whole-file include (&<x.txt>)', async () => {
        expect(referenced(await scan(), 'included.txt')).toBe(true);
    });

    it('records a deep include (&<x.txt>/Part/NameKey)', async () => {
        // The reverse-include index drops deep includes on purpose, since their slot says nothing
        // about the file's root type. The reference still exists, so the scan must see it.
        expect(referenced(await scan(), 'deep_included.txt')).toBe(true);
    });

    it('records a plain inheritance base (: <x.txt>/Part)', async () => {
        expect(referenced(await scan(), 'inherit_base.txt')).toBe(true);
    });

    it('records an ampersand inheritance base (: &<x.txt>/Part)', async () => {
        expect(referenced(await scan(), 'amp_inherit_base.txt')).toBe(true);
    });

    it('records a mod-action target', async () => {
        expect(referenced(await scan(), 'action_target.txt')).toBe(true);
    });

    it('does not record a readme nothing names', async () => {
        expect(referenced(await scan(), 'readme.txt')).toBe(false);
    });

    it('reports no set for a project holding no .txt', async () => {
        expect(await collectReferencedTxtKeys([join(FIXTURES_DIR, 'scope-mod')], token)).toBeUndefined();
    });
});
