import { describe, expect, it } from 'vitest';
import { homedir } from 'os';
import { join } from 'path';
import { CancellationToken } from 'vscode-languageserver';
import { importGameLog } from '../src/features/game-log/import-game-log.command';
import { filePathToUri } from '../src/features/navigation/navigation-strategy';

describe('scratch', () => {
    it('imports for the extended ship grid mod', async () => {
        const mod = join(homedir(), 'Saved Games', 'Cosmoteer', '76561198104661155', 'Mods', 'Extended Ship Grid');
        const result = await importGameLog(
            { uri: filePathToUri(join(mod, 'mod.rules')) },
            { openText: () => undefined },
            CancellationToken.None
        );
        expect(result).toBeTruthy();
    }, 60_000);
});
