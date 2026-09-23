import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken, Diagnostic } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { findingSpanOf, ValidationErrorData } from '../../../src/features/diagnostics/validator';
import { ValidationForValue } from '../../../src/features/diagnostics/validator.value';
import { textFixActions } from '../../../src/lsp/handlers/code-action.handlers';
import { globalSettings } from '../../../src/settings';
import { findReferenceNode } from '../../helpers';
import { initWorkspace, WORKSPACE_DATA_DIR } from '../../workspace-helper';

const token = CancellationToken.None;
const URI = 'file:///c%3A/mod/parts/paren_part.rules';

const document = (text: string) => TextDocument.create(URI, 'rules', 1, text);

/** The span the parser gives the reference written as `reference` in `source`. */
const referenceSpan = (source: string, reference: string): { start: number; end: number } => {
    const node = findReferenceNode(parser(lexer(source), URI).value, reference);
    return { start: node.position.start, end: node.position.end };
};

/** A finding underlining `span` of `doc`, carrying the fix payload a validator produced. */
const finding = (doc: TextDocument, span: { start: number; end: number }, data: ValidationErrorData): Diagnostic => ({
    range: { start: doc.positionAt(span.start), end: doc.positionAt(span.end) },
    message: 'finding',
    data,
});

/** The file as the author's first quick fix leaves it. */
const afterFirstFix = (doc: TextDocument, diagnostic: Diagnostic): string => {
    const [action] = textFixActions(doc, URI, diagnostic);
    expect(action, 'no fix was offered').toBeDefined();
    return TextDocument.applyEdits(doc, action.edit!.changes![URI]);
};

// The parser spans a parenthesized value over its closing `)` and leaves the opening `(` outside
// the span, so a fix that wrote over the whole flagged span took the `)` away and left the author
// with `A = (&Name`, which the game refuses to evaluate. The text the fix leaves behind is what
// settles this, since the span it replaces looks right either way.
describe('a quick fix on a parenthesized value', () => {
    beforeAll(async () => {
        await initWorkspace();
        globalSettings.cosmoteerPath = WORKSPACE_DATA_DIR;
    });

    it('keeps both parens when the did-you-mean fix the validator offers is applied', async () => {
        const source = 'Root = 1\nProhibitedBy = 5\nBad = (&PrhibitedBy)\n';
        const parsed = parser(lexer(source), URI).value;
        const error = await ValidationForValue.callback(findReferenceNode(parsed, '&PrhibitedBy'), token);
        expect(error?.data?.quickFix?.newText).toBe('&ProhibitedBy');
        const doc = document(source);
        const diagnostic = finding(doc, findingSpanOf(error!)!, error!.data!);
        expect(afterFirstFix(doc, diagnostic)).toBe('Root = 1\nProhibitedBy = 5\nBad = (&ProhibitedBy)\n');
    });

    it('keeps the operand parens of a reference inside a larger math expression', () => {
        const source = 'Root = 1\nProhibitedBy = 5\nBad = (&PrhibitedBy) * 2 + (&ProhibitedBy)\n';
        const doc = document(source);
        const diagnostic = finding(doc, referenceSpan(source, '&PrhibitedBy'), {
            quickFix: { title: "Change to '&ProhibitedBy'", newText: '&ProhibitedBy' },
        });
        expect(afterFirstFix(doc, diagnostic)).toBe(
            'Root = 1\nProhibitedBy = 5\nBad = (&ProhibitedBy) * 2 + (&ProhibitedBy)\n'
        );
    });

    it('keeps both levels of a doubly parenthesized value', () => {
        const source = 'Root = 1\nProhibitedBy = 5\nBad = ((&PrhibitedBy))\n';
        const doc = document(source);
        const diagnostic = finding(doc, referenceSpan(source, '&PrhibitedBy'), {
            quickFix: { title: "Change to '&ProhibitedBy'", newText: '&ProhibitedBy' },
        });
        expect(afterFirstFix(doc, diagnostic)).toBe('Root = 1\nProhibitedBy = 5\nBad = ((&ProhibitedBy))\n');
    });

    it('leaves the closing paren of a function call alone, since the span opened it itself', () => {
        const source = 'Root = 1\nProhibitedBy = 5\nBad = ceil(&PrhibitedBy)\n';
        const doc = document(source);
        const span = referenceSpan(source, '&PrhibitedBy');
        const diagnostic = finding(doc, span, {
            quickFix: { title: "Change to '&ProhibitedBy'", newText: '&ProhibitedBy' },
        });
        expect(afterFirstFix(doc, diagnostic)).toBe('Root = 1\nProhibitedBy = 5\nBad = ceil(&ProhibitedBy)\n');
    });

    it('keeps both parens when a rewrite fix writes over the same span', () => {
        const source = 'Root = 1\nProhibitedBy = 5\nBad = (&PrhibitedBy)\n';
        const doc = document(source);
        const span = referenceSpan(source, '&PrhibitedBy');
        const diagnostic = finding(doc, span, {
            rewrite: { title: 'Change it', edits: [{ ...span, newText: '&ProhibitedBy' }] },
        });
        expect(afterFirstFix(doc, diagnostic)).toBe('Root = 1\nProhibitedBy = 5\nBad = (&ProhibitedBy)\n');
    });

    it('keeps the quoting the author wrote around the narrowed value', () => {
        const source = 'Root = 1\nBad = ("icno.png")\n';
        const doc = document(source);
        const written = source.indexOf('"icno.png"');
        const span = { start: written, end: written + '"icno.png")'.length };
        const diagnostic = finding(doc, span, { quickFix: { title: "Change to 'icon.png'", newText: 'icon.png' } });
        expect(afterFirstFix(doc, diagnostic)).toBe('Root = 1\nBad = ("icon.png")\n');
    });
});
