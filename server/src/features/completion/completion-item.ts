import { CompletionItem, CompletionItemKind, InsertTextFormat, InsertTextMode, MarkupKind } from 'vscode-languageserver';
import { Completion } from './autocompletion.service';

/**
 * Reduce an LSP snippet string to the plain text it would insert (drop the `$0`/`$1` tab stops and
 * unwrap `${1:default}` placeholders to their default). Used as the fallback when the client does
 * not advertise snippet support.
 */
export const snippetToPlainText = (snippet: string): string =>
    snippet
        .replace(/\$\{\d+:([^}]*)\}/g, '$1') // ${1:default} -> default
        .replace(/\$\{\d+\}/g, '') // ${1} -> ''
        .replace(/\$\d+/g, ''); // $1 / $0 -> ''

/**
 * Convert a {@link Completion} into an LSP {@link CompletionItem}. Plain-string completions keep the
 * legacy `Reference` kind. Snippet completions emit `InsertTextFormat.Snippet` only when the client
 * supports it. Otherwise, their insert text is flattened to plain text so they still work.
 */
export const toCompletionItem = (completion: Completion, snippetSupported: boolean): CompletionItem => {
    if (typeof completion === 'string') {
        return { label: completion, kind: CompletionItemKind.Reference };
    }

    const item: CompletionItem = { label: completion.label, kind: completion.kind ?? CompletionItemKind.Reference };
    if (completion.detail) item.detail = completion.detail;
    if (completion.documentation) item.documentation = { kind: MarkupKind.Markdown, value: completion.documentation };
    if (completion.sortText) item.sortText = completion.sortText;

    if (completion.insertText !== undefined) {
        if (completion.isSnippet && snippetSupported) {
            item.insertText = completion.insertText;
            item.insertTextFormat = InsertTextFormat.Snippet;
            // Normalize the snippet's subsequent-line indentation to the insertion point so a
            // multi-line `{ … }` / `[ … ]` block nests correctly under the cursor's column.
            item.insertTextMode = InsertTextMode.adjustIndentation;
        } else {
            item.insertText = completion.isSnippet ? snippetToPlainText(completion.insertText) : completion.insertText;
        }
    }
    return item;
};
