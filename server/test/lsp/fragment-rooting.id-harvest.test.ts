import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { join } from 'path';
import { CancellationToken } from 'vscode-languageserver';

// The startup builds the id index in the project walk and the mod-action rooting afterwards, so a
// fragment that only an action types is read before it has a class. This drives that order through
// the real `ensureFragmentRooting` over a fixture mod whose only resource is wired in by an
// `Overrides` action, which is the shape that left a mod's own resources out of every list the ids
// feed. A test that only queried the id index would build it in the other order and pass either way.
const harness = vi.hoisted(() => {
    let folders: unknown = null;
    const connection = {
        console: { error: () => undefined, warn: () => undefined, info: () => undefined, log: () => undefined },
        window: {
            createWorkDoneProgress: () =>
                Promise.resolve({ begin: () => undefined, report: () => undefined, done: () => undefined }),
            showWarningMessage: () => Promise.resolve(undefined),
        },
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
const { aliasRootIndex } = await import('../../src/document/schema/alias-root');
const { SchemaIdIndex } = await import('../../src/features/completion/schema-id.index');
const { ActionRootingIndex } = await import('../../src/mod/action-rooting.index');
const { ReverseIncludeIndex } = await import('../../src/mod/reverse-include.index');
const { invalidateModContext } = await import('../../src/mod/mod-context');
const { clearModRootCache } = await import('../../src/mod/mod-root');
const { ensureFragmentRooting, markWorkspaceReady } = await import('../../src/lsp/fragment-rooting');
const { invalidateWorkspaceFoldersCache } = await import('../../src/lsp/workspace-folders');
const { filePathToUri } = await import('../../src/document/reference-path');
const { initWorkspace, WORKSPACE_DATA_DIR } = await import('../workspace-helper');
const { FIXTURES_DIR } = await import('../helpers');

const token = CancellationToken.None;
const MOD_DIR = join(FIXTURES_DIR, 'action-id-mod');
const RESOURCE_CLASS = 'Cosmoteer.Resources.ResourceRules';

beforeAll(async () => {
    await initWorkspace();
    globalSettings.cosmoteerPath = WORKSPACE_DATA_DIR;
    readClientCapabilities({ workspace: { configuration: true, workspaceFolders: true } });
    harness.setFolders([{ uri: filePathToUri(MOD_DIR), name: 'action-id-mod' }]);
    invalidateWorkspaceFoldersCache();
    clearModRootCache();
    invalidateModContext();
    SchemaIdIndex.instance.reset();
    ActionRootingIndex.instance.reset();
    ReverseIncludeIndex.instance.reset();
    aliasRootIndex.invalidate();
    markWorkspaceReady();
    await ensureFragmentRooting(token);
}, 120_000);

afterAll(() => {
    SchemaIdIndex.instance.reset();
    ActionRootingIndex.instance.reset();
    ReverseIncludeIndex.instance.reset();
    aliasRootIndex.invalidate();
});

describe('the ids of a fragment the mod actions root', () => {
    it('harvests the id of a resource an action wires in, although the id index was built first', async () => {
        const ids = await SchemaIdIndex.instance.primaryIdsForClass(
            RESOURCE_CLASS,
            [MOD_DIR, WORKSPACE_DATA_DIR],
            token
        );
        expect([...ids]).toContain('pumpkin');
    }, 120_000);

    it('keeps harvesting a resource the game tree declares by its own path', async () => {
        const ids = await SchemaIdIndex.instance.primaryIdsForClass(
            RESOURCE_CLASS,
            [MOD_DIR, WORKSPACE_DATA_DIR],
            token
        );
        expect([...ids]).toContain('testiron');
    }, 120_000);

    it('takes no id from a file no action roots', async () => {
        const ids = await SchemaIdIndex.instance.primaryIdsForClass(
            RESOURCE_CLASS,
            [MOD_DIR, WORKSPACE_DATA_DIR],
            token
        );
        // `test.actionid` is the manifest's own id, which is not a resource and must stay out.
        expect([...ids]).not.toContain('test.actionid');
    }, 120_000);
});
