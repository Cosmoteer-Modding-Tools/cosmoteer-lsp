import { describe, expect, it } from 'vitest';
import { CompletionItemKind, InsertTextFormat } from 'vscode-languageserver';
import { snippetToPlainText, toCompletionItem } from '../../../src/features/completion/completion-item';

describe('toCompletionItem', () => {
    it('maps a plain string to a Reference item', () => {
        expect(toCompletionItem('AddTo', true)).toEqual({ label: 'AddTo', kind: CompletionItemKind.Reference });
    });

    it('keeps the suggestion kind and detail', () => {
        const item = toCompletionItem({ label: 'Action', kind: CompletionItemKind.Keyword, detail: 'verb' }, true);
        expect(item).toEqual({ label: 'Action', kind: CompletionItemKind.Keyword, detail: 'verb' });
    });

    it('emits InsertTextFormat.Snippet when the client supports snippets', () => {
        const item = toCompletionItem(
            { label: 'Add', kind: CompletionItemKind.Snippet, insertText: '{\n\tAction = Add\n\tAddTo = "$1"\n}', isSnippet: true },
            true
        );
        expect(item.insertTextFormat).toBe(InsertTextFormat.Snippet);
        expect(item.insertText).toContain('$1');
    });

    it('flattens a snippet to plain text when the client does not support snippets', () => {
        const item = toCompletionItem(
            { label: 'Add', insertText: '{\n\tAction = Add\n\tAddTo = "$1"\n}', isSnippet: true },
            false
        );
        expect(item.insertTextFormat).toBeUndefined();
        expect(item.insertText).toBe('{\n\tAction = Add\n\tAddTo = ""\n}');
    });

    it('attaches the trigger-suggest command to a snippet that lands at a value position', () => {
        const suggestion = { label: 'X', insertText: 'X\n{\n\tType = $0\n}', isSnippet: true, triggerSuggest: true };
        const withSnippets = toCompletionItem(suggestion, true);
        expect(withSnippets.command).toEqual({ title: 'Trigger Suggest', command: 'editor.action.triggerSuggest' });
        // Without snippet support there is no tab stop to land on, so no command either.
        const withoutSnippets = toCompletionItem(suggestion, false);
        expect(withoutSnippets.command).toBeUndefined();
    });
});

describe('snippetToPlainText', () => {
    it('drops tab stops and unwraps placeholders', () => {
        expect(snippetToPlainText('a $1 b ${2:def} c $0')).toBe('a  b def c ');
    });
});
