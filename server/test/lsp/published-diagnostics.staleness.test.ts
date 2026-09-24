import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Diagnostic, InitializeParams } from 'vscode-languageserver/node';

// The Problems panel holds an entry per scanned file, and the client only re-pulls for the editors
// it has open. So every path that changes what a scanned file would report has to re-run the pass
// itself, or the panel keeps describing the project as it was. Two such paths were not doing it: a
// `.rules` file changing on disk re-validated only that file, leaving every file that reads it on
// the pre-change answer, and switching a validator off or on re-ran nothing at all.

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

const { handlers, published } = harness;

/** A client that reports folders, pulls configuration and pulls diagnostics, the way VS Code does. */
const CLIENT_CAPABILITIES = {
    workspace: { configuration: true, workspaceFolders: true },
    textDocument: { diagnostic: {} },
} as InitializeParams['capabilities'];

/** The comment run the game's scanner does not close, which `validateUnclosedComments` warns about. */
const UNCLOSED_COMMENT = '/* note **/\nValue = 1\n';

/** A base file the file below reads a value out of. */
const BASE = 'Base {\n    VALUE = 1\n}\n';

/** The same base file after the group it declares was renamed away. */
const BASE_RENAMED = 'RenamedOnDisk {\n    VALUE = 1\n}\n';

/** A file whose only cross-file link is the reference into the base above. */
const READER = 'Thing {\n    X = &<base.rules>/Base/VALUE\n}\n';

let folder: string;

/**
 * The diagnostics last published for one of the fixture files.
 *
 * @param name the file's basename.
 * @returns the published diagnostics, or undefined when nothing was ever published for it.
 */
const publishedFor = (name: string): Diagnostic[] | undefined =>
    published.get(filePathToUri(join(folder, name)).toLowerCase()) as Diagnostic[] | undefined;

/**
 * The settings to answer the next configuration pull with.
 *
 * @param diagnostics the diagnostics settings to override.
 * @returns nothing.
 */
const useSettings = (diagnostics: Partial<(typeof defaultSettings)['diagnostics']>): void => {
    harness.setSettings({
        ...defaultSettings,
        // Anything the path does not end in leaves the game tree unread, which keeps the test off
        // whatever Cosmoteer install this machine happens to have.
        cosmoteerPath: join(folder, 'no-install'),
        diagnostics: { ...defaultSettings.diagnostics, ...diagnostics },
    });
};

describe('published diagnostics after the project moves under the server', () => {
    beforeAll(async () => {
        folder = mkdtempSync(join(tmpdir(), 'cosmoteer-staleness-'));
        writeFileSync(join(folder, 'thing.rules'), UNCLOSED_COMMENT);
        writeFileSync(join(folder, 'base.rules'), BASE);
        writeFileSync(join(folder, 'reader.rules'), READER);
        harness.setFolders([{ uri: pathToFileURL(folder).href, name: 'mod' }]);
        CosmoteerWorkspaceService.instance.setConnection(harness.connection as never);
        useSettings({});
        invalidateWorkspaceFoldersCache();
        lifecycle.register();
        watchedFiles.register();
        await handlers.initialize({
            capabilities: CLIENT_CAPABILITIES,
            initializationOptions: undefined,
        } as never);
        await handlers.initialized({} as never);
    }, 60_000);

    afterAll(() => {
        rmSync(folder, { recursive: true, force: true });
    });

    it('starts from a clean reader and a warned comment', () => {
        expect(publishedFor('reader.rules')).toEqual([]);
        expect(publishedFor('thing.rules')?.length).toBe(1);
    });

    it('re-publishes a file that reads a file which changed on disk', async () => {
        writeFileSync(join(folder, 'base.rules'), BASE_RENAMED);
        await handlers.watchedFiles({
            changes: [{ uri: pathToFileURL(join(folder, 'base.rules')).href, type: 2 }],
        } as never);
        const messages = (publishedFor('reader.rules') ?? []).map((diagnostic) => diagnostic.message);
        expect(messages.join(' | ')).toContain('not known');
    }, 60_000);

    it('re-publishes every scanned file when a validator is switched off', async () => {
        useSettings({ validateUnclosedComments: false });
        await handlers.configuration({} as never);
        expect(publishedFor('thing.rules')).toEqual([]);
    }, 60_000);

    it('re-publishes them again when the validator is switched back on', async () => {
        useSettings({ validateUnclosedComments: true });
        await handlers.configuration({} as never);
        expect(publishedFor('thing.rules')?.length).toBe(1);
    }, 60_000);
});
