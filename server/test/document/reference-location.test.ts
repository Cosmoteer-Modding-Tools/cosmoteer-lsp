import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Range } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { AbstractNode, AbstractNodeDocument, isValueNode } from '../../src/core/ast/ast';
import { walkAst } from '../helpers';

// A node's recorded position carries one line and two columns, so a value written across a `\`
// continuation or inside a verbatim `@"…"` string used to be handed to the editor as a range on a
// single line, ending at a column that line does not have. Go-to-definition, find-all-references and
// the rename edits derived from those ranges all read past the end of the line: a verbatim string is
// stamped with the line it closes on while its start column belongs to the line it opened on, and a
// continued expression ends at the column it started at. The absolute offsets were right the whole
// time, so both ends are now placed in the buffer's own text.

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

const { registerOpenDocument, openParseCache } = await import('../../src/lsp/open-documents');
const { ParserResultRegistrar } = await import('../../src/document/parser-result-registrar');
const { rangeOf, referenceSiteLocation } = await import('../../src/document/reference-location');

const URI = 'file:///spans.rules';

/** A reference carried onto the next line by a `\` continuation, and a two-line verbatim string. */
const SPANNING = [
    'Group {',
    '    Value = &<some/file.rules>/Foo \\',
    '        /Bar',
    '    Text = @"one',
    'two"',
    '}',
    '',
].join('\n');

/**
 * Opens the buffer and runs the registration the server runs on every edit.
 *
 * @param text the buffer's text.
 * @returns the registered document AST.
 */
const open = (text: string): AbstractNodeDocument => {
    const document = TextDocument.create(URI, 'rules', 1, text);
    openDocuments.set(URI, document);
    registerOpenDocument(document);
    return ParserResultRegistrar.instance.getResult(URI)!;
};

/**
 * Applies one incremental change the way the client sends it, then re-registers the buffer.
 *
 * @param range the range the client replaced.
 * @param text the text it put there.
 * @returns the re-registered document AST.
 */
const edit = (range: Range, text: string): AbstractNodeDocument => {
    const document = openDocuments.get(URI)!;
    TextDocument.update(document, [{ range, text }], document.version + 1);
    registerOpenDocument(document);
    return ParserResultRegistrar.instance.getResult(URI)!;
};

/**
 * The first node of a type whose written text is `written`.
 *
 * @param document the document to search.
 * @param type the node type wanted.
 * @param written the value's text, for a value node.
 * @returns the node.
 */
const nodeOf = (document: AbstractNodeDocument, type: string, written?: string): AbstractNode => {
    for (const node of walkAst(document)) {
        if (node.type !== type) continue;
        if (written === undefined) return node;
        if (isValueNode(node) && String(node.valueType.value) === written) return node;
    }
    throw new Error(`no ${type} node for ${written ?? 'any text'}`);
};

/**
 * Whether a range stays inside the lines of a text, which is what the editor needs to apply it.
 *
 * @param text the buffer's text.
 * @param range the range to check.
 * @returns true when both ends name a column that line really has.
 */
const insideLines = (text: string, range: Range): boolean => {
    const lines = text.split('\n');
    const fits = (line: number, character: number) => line < lines.length && character <= lines[line].length;
    return fits(range.start.line, range.start.character) && fits(range.end.line, range.end.character);
};

describe('ranges over values that span lines', () => {
    beforeEach(() => {
        openDocuments.clear();
        openParseCache.clear();
        ParserResultRegistrar.instance.clear();
    });

    it('spans a verbatim string from the line it opens on to the line it closes on', () => {
        const document = open(SPANNING);
        const range = referenceSiteLocation(nodeOf(document, 'Value', 'one\ntwo')).range;
        expect(range).toEqual(Range.create(3, 11, 4, 4));
        expect(insideLines(SPANNING, range)).toBe(true);
    });

    it('ends a continued expression on the line the continuation carried it to', () => {
        const document = open(SPANNING);
        expect(rangeOf(nodeOf(document, 'MathExpression'))).toEqual(Range.create(1, 12, 2, 12));
    });

    it('follows an incremental edit that moves the value onto other lines', () => {
        open(SPANNING);
        // One line inserted at the top, so everything below it moves down by one.
        const document = edit(Range.create(0, 0, 0, 0), 'Other = 1\n');
        const shifted = `Other = 1\n${SPANNING}`;
        const range = referenceSiteLocation(nodeOf(document, 'Value', 'one\ntwo')).range;
        expect(range).toEqual(Range.create(4, 11, 5, 4));
        expect(insideLines(shifted, range)).toBe(true);
    });

    it('leaves a single-line value exactly where its position records it', () => {
        const document = open('Group {\n    Value = Plain\n}\n');
        expect(rangeOf(nodeOf(document, 'Value', 'Plain'))).toEqual(Range.create(1, 12, 1, 17));
    });
});
