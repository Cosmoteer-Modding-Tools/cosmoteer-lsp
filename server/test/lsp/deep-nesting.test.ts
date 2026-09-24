import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';

// The parser is recursive descent, so a runaway `{` nesting overflows the call stack. Nothing the
// game ships comes close, but a generated or truncated file does, and the throw used to travel out
// of every request that reads the AST, which the editor reports as a failed request.
const openDocuments = new Map<string, TextDocument>();

vi.mock('../../src/lsp/context', () => ({
    connection: {
        console: { error: () => undefined, warn: () => undefined, info: () => undefined, log: () => undefined },
        languages: { diagnostics: { refresh: () => undefined } },
    },
    documents: {
        all: () => [...openDocuments.values()],
        get: (uri: string) => openDocuments.get(uri),
        onDidChangeContent: () => undefined,
        onDidClose: () => undefined,
    },
    tokenSourceManager: { cancel: () => undefined },
}));

const { lexer } = await import('../../src/core/lexer/lexer');
const { parser } = await import('../../src/core/parser/parser');
const { ensureParserResult, openParseCache, parseWithinStack, registerOpenDocument } =
    await import('../../src/lsp/open-documents');
const { ParserResultRegistrar } = await import('../../src/document/parser-result-registrar');

const URI = 'file:///deep.rules';
// Far past the depth the stack allows, so the overflow does not depend on how much stack the
// caller has already used.
const DEEP = `${'Group\n{\n'.repeat(20_000)}Value = 1\n${'}\n'.repeat(20_000)}`;
const FLAT = 'Group\n{\n\tValue = 1\n}\n';

/**
 * Opens a document for the mocked `documents` collection.
 *
 * @param text the buffer's text.
 * @returns the document.
 */
const open = (text: string): TextDocument => {
    const document = TextDocument.create(URI, 'rules', 1, text);
    openDocuments.set(URI, document);
    return document;
};

beforeEach(() => {
    openParseCache.clear();
    ParserResultRegistrar.instance.removeResult(URI);
});

describe('a document nested deeper than the parser stack reaches', () => {
    it('is what the bare parser throws on', () => {
        expect(() => parser(lexer(DEEP), URI)).toThrow(RangeError);
    });

    it('answers no parse instead of throwing', () => {
        expect(parseWithinStack(lexer(DEEP), URI)).toBeUndefined();
    });

    it('leaves the requests that read the AST with nothing to read', () => {
        open(DEEP);
        expect(ensureParserResult(URI)).toBeUndefined();
    });

    it('publishes nothing when the edit flow registers it', () => {
        const document = open(DEEP);
        expect(() => registerOpenDocument(document)).not.toThrow();
    });

    it('still parses a document the stack does reach', () => {
        open(FLAT);
        expect(parseWithinStack(lexer(FLAT), URI)).toBeDefined();
        expect(ensureParserResult(URI)?.elements.length).toBe(1);
    });
});
