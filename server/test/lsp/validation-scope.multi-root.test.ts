import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'path';
import { CancellationToken } from 'vscode-languageserver';

// The default panel scope is the manifest's reachability closure, and a workspace may hold several
// folders of which only some are mods. Each folder is judged by its own closure, so a folder with a
// manifest keeps hiding its dead content while a folder without one keeps every file it holds.
const harness = vi.hoisted(() => {
    let folders: unknown = null;
    const connection = {
        console: { error: () => undefined, warn: () => undefined, info: () => undefined, log: () => undefined },
        window: { showWarningMessage: () => Promise.resolve(undefined) },
        languages: { diagnostics: { refresh: () => undefined } },
        workspace: { getWorkspaceFolders: () => Promise.resolve(folders) },
    };
    return { connection, setFolders: (value: unknown) => (folders = value) };
});

vi.mock('../../src/lsp/context', () => ({
    connection: harness.connection,
    documents: { all: () => [], onDidChangeContent: () => undefined, onDidClose: () => undefined },
    tokenSourceManager: { cancel: () => undefined },
}));

const { readClientCapabilities } = await import('../../src/capabilities');
const { globalSettings } = await import('../../src/settings');
const { clearModRootCache } = await import('../../src/mod/mod-root');
const { bumpValidationScopeEpoch, reachableFileFilter } = await import('../../src/lsp/validation-scope');
const { invalidateWorkspaceFoldersCache } = await import('../../src/lsp/workspace-folders');
const { filePathToUri } = await import('../../src/document/reference-path');
const { collectScannedFiles } = await import('../../src/workspace/rules-file-walk');
const { FIXTURES_DIR } = await import('../helpers');

const token = CancellationToken.None;
const MOD_DIR = join(FIXTURES_DIR, 'scope-mod');
const PLAIN_DIR = join(FIXTURES_DIR, 'no-manifest-folder');
const WIRED_FILE = join(MOD_DIR, 'wired', 'good.rules');
const DEAD_FILE = join(MOD_DIR, '_backup', 'dead.rules');
const LOOSE_FILE = join(PLAIN_DIR, 'parts', 'loose.rules');
const LIVE_SHADER = join(MOD_DIR, 'wired', 'live.shader');
const STRAY_SHADER = join(MOD_DIR, 'wired', 'stray.shader');

/** Points the server at a folder set, dropping everything cached for the previous one. */
const openFolders = (...paths: string[]): void => {
    harness.setFolders(paths.map((path) => ({ uri: filePathToUri(path), name: path })));
    invalidateWorkspaceFoldersCache();
    clearModRootCache();
    bumpValidationScopeEpoch();
};

beforeEach(() => {
    readClientCapabilities({ workspace: { configuration: true, workspaceFolders: true } });
    globalSettings.diagnostics = { ...globalSettings.diagnostics, workspaceValidationScope: 'modRulesReachable' };
});

describe('the validation scope of a workspace holding several folders', () => {
    it('keeps every file of a folder that has no manifest beside a folder that has one', async () => {
        openFolders(MOD_DIR, PLAIN_DIR);
        const allows = await reachableFileFilter(token);
        expect(allows).toBeDefined();
        expect(allows!(LOOSE_FILE)).toBe(true);
    });

    it('still scopes the folder that has a manifest by what the manifest reaches', async () => {
        openFolders(MOD_DIR, PLAIN_DIR);
        const allows = await reachableFileFilter(token);
        expect(allows!(WIRED_FILE)).toBe(true);
        expect(allows!(DEAD_FILE)).toBe(false);
    });

    it('scopes a lone mod folder the same way it always did', async () => {
        openFolders(MOD_DIR);
        const allows = await reachableFileFilter(token);
        expect(allows!(WIRED_FILE)).toBe(true);
        expect(allows!(DEAD_FILE)).toBe(false);
    });

    it('restricts nothing when no folder has a manifest', async () => {
        openFolders(PLAIN_DIR);
        expect(await reachableFileFilter(token)).toBeUndefined();
    });

    it('restricts nothing when the user asked for every file', async () => {
        openFolders(MOD_DIR, PLAIN_DIR);
        globalSettings.diagnostics = { ...globalSettings.diagnostics, workspaceValidationScope: 'allFiles' };
        expect(await reachableFileFilter(token)).toBeUndefined();
    });
});

// The two steps the scan pass composes to build its file list: the walk, then the scope filter.
// A `.shader` carries its own HLSL checks, and the game compiles the one a material names, so the
// walk has to yield it and the closure has to keep it. An unreferenced copy is dead content like
// any dead `.rules`, and its broken include is nothing the modder has to hear about.
describe('the file list the workspace scan builds', () => {
    it('covers a shader the mod references and leaves an unreferenced copy out', async () => {
        openFolders(MOD_DIR);
        const walked: string[] = [];
        for await (const file of collectScannedFiles(MOD_DIR)) walked.push(file);
        expect(walked).toContain(LIVE_SHADER);
        expect(walked).toContain(STRAY_SHADER);
        const allows = await reachableFileFilter(token);
        expect(allows).toBeDefined();
        expect(allows!(LIVE_SHADER)).toBe(true);
        expect(allows!(STRAY_SHADER)).toBe(false);
    });
});
