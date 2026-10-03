import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Diagnostic, InitializeParams } from 'vscode-languageserver/node';

// A strings file is read by key, never by file name, so a scanned file that writes a key the
// strings file just gained or lost spells nothing the file-name lookup of the watcher finds. The
// fixture is named `ja` so its name is a substring of nothing in the manifest, which is the case a
// large mod is in once the lookup cap is full of files that only happen to contain `en`.

const harness = vi.hoisted(() => {
    const published = new Map<string, unknown[]>();
    const handlers: Record<string, (params: never) => Promise<unknown> | unknown> = {};
    let folders: unknown = null;
    let settings: unknown = {};
    const progress = { begin: () => undefined, report: () => undefined, done: () => undefined };
    const connection = {
        console: { error: () => undefined, warn: () => undefined, info: () => undefined, log: () => undefined },
        client: { register: () => undefined },
        window: {
            createWorkDoneProgress: () => Promise.resolve(progress),
            showErrorMessage: () => Promise.resolve(undefined),
            showWarningMessage: () => Promise.resolve(undefined),
            showInformationMessage: () => Promise.resolve(undefined),
        },
        languages: { diagnostics: { refresh: () => undefined } },
        workspace: {
            getWorkspaceFolders: () => Promise.resolve(folders),
            getConfiguration: () => Promise.resolve(settings),
            onWillRenameFiles: () => undefined,
            onDidChangeWorkspaceFolders: () => undefined,
        },
        sendDiagnostics: (params: { uri: string; diagnostics: unknown[] }) => {
            published.set(params.uri.toLowerCase(), params.diagnostics);
            return Promise.resolve();
        },
        sendNotification: () => Promise.resolve(undefined),
        sendRequest: () => Promise.resolve(undefined),
        onInitialize: (handler: (params: never) => unknown) => (handlers.initialize = handler),
        onInitialized: (handler: (params: never) => unknown) => (handlers.initialized = handler),
        onDidChangeConfiguration: (handler: (params: never) => unknown) => (handlers.configuration = handler),
        onDidChangeWatchedFiles: (handler: (params: never) => unknown) => (handlers.watchedFiles = handler),
    };
    return {
        connection,
        handlers,
        published,
        setFolders: (value: unknown) => (folders = value),
        setSettings: (value: unknown) => (settings = value),
    };
});

vi.mock('../../src/lsp/context', () => ({
    connection: harness.connection,
    documents: {
        all: () => [],
        get: () => undefined,
        onDidChangeContent: () => undefined,
        onDidClose: () => undefined,
    },
    tokenSourceManager: { cancel: () => undefined, cancelToken: () => undefined },
}));

const lifecycle = await import('../../src/lsp/handlers/lifecycle.handlers');
const watchedFiles = await import('../../src/lsp/handlers/watched-files.handlers');
const { invalidateWorkspaceFoldersCache } = await import('../../src/lsp/workspace-folders');
const { defaultSettings } = await import('../../src/settings');
const { filePathToUri } = await import('../../src/document/reference-path');
const { CosmoteerWorkspaceService } = await import('../../src/workspace/cosmoteer-workspace.service');
const { WORKSPACE_DATA_DIR } = await import('../workspace-helper');

const { handlers, published } = harness;

const CLIENT_CAPABILITIES = {
    workspace: { configuration: true, workspaceFolders: true },
    textDocument: { diagnostic: {} },
} as InitializeParams['capabilities'];

/** A manifest whose only localization key is `Parts/NewKey`. */
const MANIFEST = `ID = test.stringsstaleness
Name = "Strings staleness fixture"
Actions
[
    {
        Action = Add
        AddTo = "<parts/stats_part.rules>/Part/StatsByCategory"
        ToAdd
        {
            NameKey = "Parts/NewKey"
        }
    }
]
`;

let folder: string;

const keyFindings = (): string[] =>
    ((published.get(filePathToUri(join(folder, 'mod.rules')).toLowerCase()) ?? []) as Diagnostic[])
        .filter((diagnostic) => diagnostic.code === 'validateLocalizationKeys')
        .map((diagnostic) => (typeof diagnostic.message === 'string' ? diagnostic.message : diagnostic.message.value));

describe('published key diagnostics after a strings file changes on disk', () => {
    beforeAll(async () => {
        folder = mkdtempSync(join(tmpdir(), 'cosmoteer-strings-staleness-'));
        mkdirSync(join(folder, 'strings'));
        writeFileSync(join(folder, 'mod.rules'), MANIFEST);
        writeFileSync(join(folder, 'strings', 'ja.rules'), 'Parts { OldKey = "Old" }\n');
        harness.setFolders([{ uri: pathToFileURL(folder).href, name: 'mod' }]);
        CosmoteerWorkspaceService.instance.setConnection(harness.connection as never);
        harness.setSettings({ ...defaultSettings, cosmoteerPath: WORKSPACE_DATA_DIR });
        invalidateWorkspaceFoldersCache();
        lifecycle.register();
        watchedFiles.register();
        await handlers.initialize({ capabilities: CLIENT_CAPABILITIES, initializationOptions: undefined } as never);
        await handlers.initialized({} as never);
    }, 120_000);

    afterAll(() => {
        rmSync(folder, { recursive: true, force: true });
    });

    it('starts with the key reported missing', () => {
        expect(keyFindings()).toHaveLength(1);
    });

    it('clears the finding once the strings file declares the key', async () => {
        writeFileSync(join(folder, 'strings', 'ja.rules'), 'Parts { NewKey = "New" }\n');
        await handlers.watchedFiles({
            changes: [{ uri: pathToFileURL(join(folder, 'strings', 'ja.rules')).href, type: 2 }],
        } as never);
        expect(keyFindings()).toEqual([]);
    }, 60_000);
});
