import { describe, expect, it } from 'vitest';
import { gameAlreadyDiscovers, runInCosmoteer } from '../../../src/features/run-game/run-game.command';

const INSTALL_ROOT = 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer';
const MODS_DIR = 'C:/Users/x/Saved Games/Cosmoteer/76561198104661155/Mods';

// The game enumerates the direct children of three folders and nothing else, so where the mod sits
// decides whether it has to be linked at all. Linking one that is already there loads it twice.
describe('deciding whether the game already finds the mod', () => {
    it('finds a mod that sits in the user mods folder', () => {
        expect(gameAlreadyDiscovers(`${MODS_DIR}/My Mod`, INSTALL_ROOT, [MODS_DIR])).toBe(true);
    });

    it('finds a mod that ships with the game', () => {
        expect(gameAlreadyDiscovers(`${INSTALL_ROOT}/Standard Mods/example_mod`, INSTALL_ROOT, [MODS_DIR])).toBe(true);
    });

    it('does not find a mod anywhere else', () => {
        expect(gameAlreadyDiscovers('D:/dev/MyMod', INSTALL_ROOT, [MODS_DIR])).toBe(false);
    });

    it('does not count the mods folder itself', () => {
        expect(gameAlreadyDiscovers(MODS_DIR, INSTALL_ROOT, [MODS_DIR])).toBe(false);
    });

    it('ignores the case of a path, the way the game compares them', () => {
        const answer = gameAlreadyDiscovers(`${MODS_DIR.toLowerCase()}/my mod`, INSTALL_ROOT, [MODS_DIR]);
        expect(answer).toBe(process.platform === 'win32');
    });
});

// The command writes into the user's game settings and mods folder, so anything it cannot establish
// has to stop it rather than be guessed at.
describe('running the mod in the game', () => {
    it('refuses when the file is in no mod', async () => {
        const result = await runInCosmoteer({ uri: 'file:///nowhere/x.rules' }, {
            modRoot: () => null,
            reportError: () => undefined,
        });
        expect(result.kind).toBe('refused');
        if (result.kind !== 'refused') return;
        // Without a detected install that comes first, which is equally a refusal and never a launch.
        expect(['no-mod', 'no-install', 'no-executable', 'unsupported-platform']).toContain(result.reason);
    });
});
