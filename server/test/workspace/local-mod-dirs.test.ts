import { describe, expect, it } from 'vitest';
import { existsSync } from 'fs';
import { basename } from 'path';
import { localModDirs } from '../../src/workspace/workshop-dir';

// A mod does not have to come from the workshop: the game loads whatever sits in the user's own
// `Mods` folder, and a code mod there supplies types the files being edited name just the same. The
// folder is outside every workspace folder and outside the workshop tree, so it is its own root.
describe('localModDirs', () => {
    it('returns existing Mods folders only', () => {
        for (const dir of localModDirs()) {
            expect(basename(dir)).toBe('Mods');
            expect(existsSync(dir)).toBe(true);
        }
    });

    it('does not throw without a detected game install', () => {
        expect(() => localModDirs()).not.toThrow();
    });
});
