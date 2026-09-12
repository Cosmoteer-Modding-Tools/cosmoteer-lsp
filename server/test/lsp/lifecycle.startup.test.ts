import { describe, expect, it, vi } from 'vitest';
import type { InitializeParams } from 'vscode-languageserver/node';

// The startup runs against a stand-in connection, since the fault it guards against is invisible
// from the outside: a rejected `initialized` handler is dropped by the connection, so the server
// answers nothing for the rest of the session and writes nothing anywhere.
const harness = vi.hoisted(() => {
    const errors: string[] = [];
    const registered: unknown[] = [];
    let folders: unknown = null;
    let configuration: () => Promise<unknown> = () => Promise.resolve({});
    const progress = { begin: () => undefined, report: () => undefined, done: () => undefined };
    const handlers: Record<string, (params: unknown) => Promise<unknown> | unknown> = {};
    const connection = {
        console: {
            error: (message: string) => errors.push(message),
            warn: () => undefined,
            info: () => undefined,
            log: () => undefined,
        },
        client: { register: (...args: unknown[]) => registered.push(args) },
        window: {
            createWorkDoneProgress: () => Promise.resolve(progress),
            showErrorMessage: () => Promise.resolve(undefined),
            showWarningMessage: () => Promise.resolve(undefined),
        },
        languages: { diagnostics: { refresh: () => undefined } },
        workspace: {
            getWorkspaceFolders: () => Promise.resolve(folders),
            getConfiguration: () => configuration(),
            onWillRenameFiles: () => undefined,
            onDidChangeWorkspaceFolders: () => undefined,
        },
        sendRequest: () => Promise.resolve(undefined),
        onInitialize: (handler: (params: unknown) => unknown) => (handlers.initialize = handler),
        onInitialized: (handler: (params: unknown) => unknown) => (handlers.initialized = handler),
        onDidChangeConfiguration: (handler: (params: unknown) => unknown) => (handlers.configuration = handler),
    };
    return {
        connection,
        errors,
        registered,
        handlers,
        setFolders: (value: unknown) => (folders = value),
        setConfiguration: (value: () => Promise<unknown>) => (configuration = value),
    };
});

vi.mock('../../src/lsp/context', () => ({
    connection: harness.connection,
    documents: { all: () => [], onDidChangeContent: () => undefined, onDidClose: () => undefined },
    tokenSourceManager: { cancel: () => undefined },
}));

const { register } = await import('../../src/lsp/handlers/lifecycle.handlers');
const fragmentRooting = await import('../../src/lsp/fragment-rooting');
const { invalidateWorkspaceFoldersCache } = await import('../../src/lsp/workspace-folders');

/** The capabilities of a client that reports folders, pulls configuration, and pulls diagnostics. */
const CLIENT_CAPABILITIES = {
    workspace: { configuration: true, workspaceFolders: true },
    textDocument: { diagnostic: {} },
} as InitializeParams['capabilities'];

/**
 * Run the handshake and the startup against the stand-in connection.
 *
 * @returns when the startup has run as far as it gets.
 */
const startUp = async (): Promise<void> => {
    invalidateWorkspaceFoldersCache();
    register();
    await handlers.initialize({ capabilities: CLIENT_CAPABILITIES, initializationOptions: undefined });
    await handlers.initialized({});
};

const { errors, handlers, registered } = harness;

describe('the server startup', () => {
    it('treats an empty workspace folder answer like no folders at all', async () => {
        // A client with no folder open may answer the pull with `[]`, which used to throw on the
        // first folder's uri and leave the whole session unanswered.
        harness.setFolders([]);
        harness.setConfiguration(() => Promise.resolve({}));
        await startUp();
        expect(errors).toEqual([]);
        expect(fragmentRooting.workspaceReady).toBe(true);
    });

    it('logs a failed game-tree read and starts up anyway', async () => {
        harness.setFolders([{ uri: 'file:///c%3A/mod', name: 'mod' }]);
        harness.setConfiguration(() => Promise.reject(new Error('no configuration')));
        registered.length = 0;
        await startUp();
        expect(errors.join('\n')).toContain('no configuration');
        // The client registrations come after the failing step, so their arrival is the proof that
        // the startup carried on rather than ending at the rejection.
        expect(registered.length).toBeGreaterThan(0);
    });
});
