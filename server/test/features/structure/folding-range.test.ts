import { describe, expect, it } from 'vitest';
import { FoldingRange } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { BlockCommentSpan, lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { computeFoldingRanges } from '../../../src/features/structure/folding-range.service';

/** Fold the source the way the server does, from one lex of the text. */
const foldsOf = (source: string): FoldingRange[] => {
    const blockComments: BlockCommentSpan[] = [];
    const tokens = lexer(source, blockComments);
    const document = TextDocument.create('file:///t.rules', 'rules', 1, source);
    return computeFoldingRanges(document, parser(tokens, document.uri).value, tokens, blockComments);
};

describe('folding ranges', () => {
    it('folds a group body and leaves the closing brace visible', () => {
        expect(foldsOf('Part\n{\n\tA = 1\n\tB = 2\n}\n')).toContainEqual({ startLine: 1, endLine: 3 });
    });

    it('folds a nested container inside its parent', () => {
        const folds = foldsOf('Part\n{\n\tComponents\n\t[\n\t\t{\n\t\t\tA = 1\n\t\t}\n\t]\n}\n');
        expect(folds).toContainEqual({ startLine: 1, endLine: 7 });
        expect(folds).toContainEqual({ startLine: 3, endLine: 6 });
        expect(folds).toContainEqual({ startLine: 4, endLine: 5 });
    });

    it('ignores a container that opens and closes on one line', () => {
        expect(foldsOf('Part { A = 1 }\n')).toEqual([]);
    });

    it('folds an unclosed container down to its last member', () => {
        expect(foldsOf('Part\n{\n\tA = 1\n')).toContainEqual({ startLine: 1, endLine: 2 });
    });

    it('folds a multi-line block comment as a comment', () => {
        expect(foldsOf('/* one\n   two */\nA = 1\n')).toContainEqual({ startLine: 0, endLine: 1, kind: 'comment' });
    });

    it('ignores a block comment that stays on one line', () => {
        expect(foldsOf('/* one */\nA = 1\n')).toEqual([]);
    });

    it('folds a run of consecutive line comments', () => {
        expect(foldsOf('// first\n// second\nA = 1\n')).toContainEqual({ startLine: 0, endLine: 1, kind: 'comment' });
    });

    it('does not fold a lone line comment', () => {
        expect(foldsOf('// only\nA = 1\n')).toEqual([]);
    });

    it('does not treat a `//` inside a string as a comment', () => {
        // The string is never closed, so it runs to the end of the file and swallows both `//` lines.
        // Only the lexer knows that, which is why the run detection reads its spans.
        const folds = foldsOf('Name = "unterminated\n// not a comment\n// still inside the string\n');
        expect(folds.filter((fold) => fold.kind === 'comment')).toEqual([]);
    });
});
