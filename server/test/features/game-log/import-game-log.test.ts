import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { CancellationToken } from 'vscode-languageserver';
import { importGameLog } from '../../../src/features/game-log/import-game-log.command';
import { filePathToUri } from '../../../src/features/navigation/navigation-strategy';

const token = CancellationToken.None;
const SAVE_ROOT = join(homedir(), 'Saved Games', 'Cosmoteer', '76561198104661155');
const MODS = join(SAVE_ROOT, 'Mods');
const HAVE_LOGS = existsSync(join(SAVE_ROOT, 'Logs')) && existsSync(MODS);

/** The first installed local mod, whichever it is: the test asserts the rules, not the content. */
const someMod = (): string | undefined => {
    for (const name of readdirSync(MODS)) {
        if (existsSync(join(MODS, name, 'mod.rules'))) return join(MODS, name);
    }
    return undefined;
};

describe('importing the game log', () => {
    it('says so when the file is in no mod', async () => {
        const result = await importGameLog({ uri: 'file:///nowhere/x.rules' }, { openText: () => undefined }, token);
        expect(result.kind).toBe('no-mod');
        expect(result.diagnostics).toEqual([]);
    });

    it.skipIf(!HAVE_LOGS)('only ever reports files of the mod it was asked about', async () => {
        const mod = someMod();
        if (!mod) return;
        const result = await importGameLog(
            { uri: filePathToUri(join(mod, 'mod.rules')) },
            { openText: () => undefined },
            token
        );
        expect(['imported', 'nothing-for-this-mod']).toContain(result.kind);
        for (const entry of result.diagnostics) {
            // Nothing outside the mod is ever published, however many files a log names.
            expect(entry.uri.toLowerCase()).toContain(mod.replace(/\\/g, '/').toLowerCase());
            expect(entry.diagnostic.source).toBe('cosmoteer-game-log');
            // Every finding says which run it came from, since it is a recording and not a check.
            expect(entry.diagnostic.message).toContain('Game log');
        }
    }, 60_000);
});
