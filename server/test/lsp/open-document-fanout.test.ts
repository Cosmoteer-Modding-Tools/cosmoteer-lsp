import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { ClientCapabilities } from 'vscode-languageserver/node';

// What an open document is judged against lives in other files: an inherited base, a strings file, a
// shader's uniforms. Nothing about the other documents moves when one of them is edited, so the edit
// has to drop their results and ask for them again. Two halves of that were missing: an edited
// `.shader` buffer dropped nothing at all, because the shader branch returns before the drop, and a
// client that cannot pull diagnostics was never asked for anything, so the drop left the other
// documents with no result and no way to get one.

const harness = vi.hoisted(() => {
    const openDocuments = new Map<string, TextDocument>();
    const published: string[] = [];
    const contentHandlers: ((event: { document: TextDocument }) => void)[] = [];
    const connection = {
        console: { error: () => undefined, warn: () => undefined, info: () => undefined, log: () => undefined },
        window: {
            createWorkDoneProgress: () => Promise.resolve({ begin: () => undefined, done: () => undefined }),
            showWarningMessage: () => Promise.resolve(undefined),
        },
        languages: { diagnostics: { refresh: () => undefined, on: () => undefined } },
        workspace: { getConfiguration: () => Promise.resolve({}) },
        sendDiagnostics: (params: { uri: string }) => {
            published.push(params.uri);
            return Promise.resolve();
        },
    };
    return {
        connection,
        openDocuments,
        published,
        contentHandlers,
        documents: {
            all: () => [...openDocuments.values()],
            get: (uri: string) => openDocuments.get(uri),
            onDidChangeContent: (handler: (event: { document: TextDocument }) => void) => {
                contentHandlers.push(handler);
            },
            onDidClose: () => undefined,
        },
    };
});

vi.mock('../../src/lsp/context', () => ({
    connection: harness.connection,
    documents: harness.documents,
    tokenSourceManager: {
        cancel: () => undefined,
        cancelToken: () => undefined,
        createToken: () => ({ isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }),
    },
}));

const { registerOpenDocument, openParseCache } = await import('../../src/lsp/open-documents');
const { diagnosticsCache, inlayHintCache } = await import('../../src/lsp/document-caches');
const { refreshDependentOpenDocuments } = await import('../../src/lsp/push-diagnostics');
const { readClientCapabilities } = await import('../../src/capabilities');
const { ParserResultRegistrar } = await import('../../src/document/parser-result-registrar');
const { markWorkspaceReady } = await import('../../src/lsp/fragment-rooting');

// Nothing in this file runs the startup, and a validation waits for the workspace to be declared
// ready before it resolves anything cross-file.
markWorkspaceReady();

const SHADER_URI = 'file:///effects/glow.shader';
const BASE_URI = 'file:///base.rules';
const DERIVED_URI = 'file:///derived.rules';

/**
 * Puts a document into the open set.
 *
 * @param uri the document's uri.
 * @param text the buffer's text.
 * @returns the document.
 */
const open = (uri: string, text: string): TextDocument => {
    const document = TextDocument.create(uri, uri.endsWith('.shader') ? 'shader' : 'rules', 1, text);
    harness.openDocuments.set(uri, document);
    return document;
};

/**
 * Records a settled result for a document, the way a validation or an inlay request does.
 *
 * @param uri the document the result belongs to.
 * @returns nothing.
 */
const cacheResultsFor = (uri: string): void => {
    diagnosticsCache.set(uri, { version: 1, promise: Promise.resolve([]), resultId: 'r' });
    inlayHintCache.set(uri, {
        version: 1,
        promise: Promise.resolve([]),
        source: { cancel: () => undefined, dispose: () => undefined } as never,
    });
};

describe('an edit to one open buffer and the other open buffers', () => {
    beforeEach(() => {
        harness.openDocuments.clear();
        harness.published.length = 0;
        harness.contentHandlers.length = 0;
        diagnosticsCache.clear();
        inlayHintCache.clear();
        openParseCache.clear();
        ParserResultRegistrar.instance.clear();
    });

    it('drops the results of the rules documents a shader edit can move', () => {
        const shader = open(SHADER_URI, 'float4 main() { return 0; }\n');
        open(BASE_URI, 'Part {\n    Shader = "effects/glow.shader"\n}\n');
        cacheResultsFor(BASE_URI);
        cacheResultsFor(SHADER_URI);

        registerOpenDocument(shader);

        // The rules document that reads the shader's uniforms has to recompute; the shader's own
        // entry is the one the edit's own flow replaces, so it stays.
        expect(diagnosticsCache.has(BASE_URI)).toBe(false);
        expect(inlayHintCache.has(BASE_URI)).toBe(false);
        expect(diagnosticsCache.has(SHADER_URI)).toBe(true);
    });

    it('asks a push-only client to re-publish the other open documents, once per burst', async () => {
        readClientCapabilities({ textDocument: {} } as ClientCapabilities);
        open(BASE_URI, 'Base {\n    VALUE = 1\n}\n');
        open(DERIVED_URI, 'Thing {\n    X = &<base.rules>/Base/VALUE\n}\n');

        // Ten keystrokes in the base file. Each one drops the derived document's results, so each
        // one has to leave a request for them behind; the debounce is what keeps that at one.
        for (let keystroke = 0; keystroke < 10; keystroke++) refreshDependentOpenDocuments(BASE_URI);
        await new Promise((resolve) => setTimeout(resolve, 800));

        expect(harness.published.filter((uri) => uri === DERIVED_URI).length).toBe(1);
        expect(harness.published).not.toContain(BASE_URI);
    });

    it('leaves the publishing to a pull-capable client', async () => {
        readClientCapabilities({ textDocument: { diagnostic: {} } } as ClientCapabilities);
        open(BASE_URI, 'Base {\n    VALUE = 1\n}\n');
        open(DERIVED_URI, 'Thing {\n    X = &<base.rules>/Base/VALUE\n}\n');

        refreshDependentOpenDocuments(BASE_URI);
        await new Promise((resolve) => setTimeout(resolve, 800));

        expect(harness.published).toEqual([]);
    });
});
