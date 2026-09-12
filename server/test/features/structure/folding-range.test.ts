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
        // Only the lexer knows the slashes sit inside a value, which is why the run detection reads
        // its spans rather than the raw text.
        const folds = foldsOf('Name = "http://example.com // not a comment"\nA = 1\n');
        expect(folds.filter((fold) => fold.kind === 'comment')).toEqual([]);
    });

    it('reads the lines after a string left open as the comments they are', () => {
        // A plain string ends at its line break, so the lines below it are ordinary source again.
        const folds = foldsOf('Name = "unterminated\n// a comment\n// and its second line\n');
        expect(folds.filter((fold) => fold.kind === 'comment')).toHaveLength(1);
    });
});
