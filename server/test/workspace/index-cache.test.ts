import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, utimesSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CancellationToken } from 'vscode-languageserver';
import { initWorkspace, WORKSPACE_DATA_DIR, workspaceFile } from '../workspace-helper';
import { WatchedDocumentIndex } from '../../src/features/navigation/watched-document-index';
import { ReverseIncludeIndex } from '../../src/features/navigation/reverse-include.index';
import { SchemaIdIndex } from '../../src/features/completion/schema-id.index';
import { TemplateBaseIndex } from '../../src/features/diagnostics/template-base.index';
import { LocalizationKeyIndex } from '../../src/features/completion/localization-key.index';

const token = CancellationToken.None;
const CACHE_HOME = mkdtempSync(join(tmpdir(), 'cosmo-index-cache-'));
const previousLocalAppData = process.env.LOCALAPPDATA;

const allIndexes = (): WatchedDocumentIndex[] => [
    ReverseIncludeIndex.instance,
    SchemaIdIndex.instance,
    TemplateBaseIndex.instance,
    LocalizationKeyIndex.instance,
];

const resetAll = (): void => {
    for (const index of allIndexes()) index.reset();
};

const build = async (): Promise<void> => {
    await WatchedDocumentIndex.buildTogether(allIndexes(), [WORKSPACE_DATA_DIR], 'test index build');
};

const statesOf = (): string => JSON.stringify(allIndexes().map((index) => index.saveState()));

const cacheFile = (): string => {
    const dir = join(CACHE_HOME, 'cosmoteer-lsp');
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith('index-cache-')) : [];
    expect(files.length).toBe(1);
    return join(dir, files[0]);
};

describe('persistent project index cache', () => {
    beforeAll(async () => {
        process.env.LOCALAPPDATA = CACHE_HOME;
        await initWorkspace();
    });

    afterAll(() => {
        process.env.LOCALAPPDATA = previousLocalAppData;
        rmSync(CACHE_HOME, { recursive: true, force: true });
    });

    it('writes the cache on a cold build and reproduces identical state from it', async () => {
        resetAll();
        await build();
        const coldStates = statesOf();
        expect(existsSync(cacheFile())).toBe(true);

        resetAll();
        await build();
        expect(statesOf()).toBe(coldStates);
    });

    it('actually serves the second build from the cache file', async () => {
        // Plant a marker key in the saved localization state. It can only surface in the index if
        // the build loads the cache instead of re-walking the game tree.
        const file = cacheFile();
        const cache = JSON.parse(readFileSync(file, 'utf-8'));
        cache.states.localizationKeys = [['file:///planted', 'Planted', [['Planted/Marker', 'from cache']]]];
        writeFileSync(file, JSON.stringify(cache));

        resetAll();
        await build();
        const keys = await LocalizationKeyIndex.instance.allKeys([WORKSPACE_DATA_DIR], token);
        expect(keys.has('Planted/Marker')).toBe(true);
    });

    it('invalidates the cache when a game file changes', async () => {
        // Bump a file's mtime: the manifest no longer matches, so the planted marker must be
        // rebuilt away from a fresh disk walk (a game update invalidates the same way).
        const touched = workspaceFile('cosmoteer.rules');
        const now = new Date();
        utimesSync(touched, now, now);

        resetAll();
        await build();
        const keys = await LocalizationKeyIndex.instance.allKeys([WORKSPACE_DATA_DIR], token);
        expect(keys.has('Planted/Marker')).toBe(false);
    });
});
