import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { CancellationToken } from 'vscode-languageserver';
import { homeOfLogFolder, importGameLog, logFolders } from '../../../src/features/game-log/import-game-log.command';
import { filePathToUri } from '../../../src/document/reference-path';

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

// The logger censors the running user's home folder in every line it writes, so the token has to be
// expanded back. On a Proton install the home the game censored is the prefix's, not the machine's,
// and the only way back to it is up from the folder the logs were found in. The two walks are held
// against each other here, since a candidate that lands one folder out probes a path that never
// exists and the whole import quietly finds nothing.
describe('the home folder a logged path is expanded against', () => {
    it('walks back to the folder the logs were built from', () => {
        const prefix = '/steam/compatdata/799600/pfx/drive_c/users/steamuser';
        const logs = join(prefix, 'Saved Games', 'Cosmoteer', '12345', 'Logs');
        expect(homeOfLogFolder(logs)).toBe(resolve(prefix));
    });

    it.skipIf(!HAVE_LOGS)('walks back to a folder the real log folders hang under', () => {
        for (const folder of logFolders()) {
            expect(folder.startsWith(join(homeOfLogFolder(folder), 'Saved Games', 'Cosmoteer'))).toBe(true);
        }
    });
});

describe('importing the game log', () => {
    it('says so when the file is in no mod', async () => {
        const result = await importGameLog({ uri: 'file:///nowhere/x.rules' }, { openText: () => undefined }, token);
        expect(result.kind).toBe('no-mod');
        expect(result.diagnostics).toEqual([]);
    });

    it.skipIf(!HAVE_LOGS)(
        'only ever reports files of the mod it was asked about',
        async () => {
            const mod = someMod();
            if (!mod) return;
            const result = await importGameLog(
                { uri: filePathToUri(join(mod, 'mod.rules')) },
                { openText: () => undefined },
                token
            );
            // `run-failed` is in the list on purpose: a run that reported a failure nothing here could
            // place is not an all clear, and this assertion is what would otherwise pass it over.
            expect(['imported', 'loaded-clean', 'run-failed', 'nothing-for-this-mod']).toContain(result.kind);
            for (const entry of result.diagnostics) {
                // Nothing outside the mod is ever published, however many files a log names.
                expect(entry.uri.toLowerCase()).toContain(mod.replace(/\\/g, '/').toLowerCase());
                expect(entry.diagnostic.source).toBe('cosmoteer-game-log');
                // Every finding says which run it came from, since it is a recording and not a check.
                expect(entry.diagnostic.message).toContain('Game log');
            }
        },
        60_000
    );
});
