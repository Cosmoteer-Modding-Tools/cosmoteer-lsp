import {
    CompletionItem,
    CompletionItemKind,
    InsertReplaceEdit,
    InsertTextFormat,
    InsertTextMode,
    MarkupKind,
    Range,
    TextEdit,
} from 'vscode-languageserver';
import { Completion, CompletionSuggestion } from './autocompletion.service.types';

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
 * The edit a ranged suggestion becomes. A client that takes an insert/replace edit gets both ranges,
 * so its own `insertMode` decides whether a caret parked inside a written value keeps the tail or
 * overwrites it. Every other client gets a plain edit over the replace range, which overwrites the
 * value the completer measured rather than writing the suggestion in front of its tail. The pair is
 * only shipped in the form the protocol allows, one line, one shared start and an insert end no
 * further than the replace end.
 *
 * @param suggestion the completion carrying the ranges.
 * @param newText the text the edit writes.
 * @param insertReplaceSupported whether the client declared `completionItem.insertReplaceSupport`.
 * @returns the text edit to put on the item.
 */
const editFor = (
    suggestion: CompletionSuggestion,
    newText: string,
    insertReplaceSupported: boolean
): TextEdit | InsertReplaceEdit => {
    const replace = suggestion.range as Range;
    const insert = suggestion.insertRange;
    const pairable =
        !!insert &&
        insert.start.line === replace.start.line &&
        insert.start.character === replace.start.character &&
        insert.end.line === replace.end.line &&
        insert.end.character <= replace.end.character;
    return insertReplaceSupported && pairable ? { newText, insert: insert!, replace } : { range: replace, newText };
};

/**
 * Convert a {@link Completion} into an LSP {@link CompletionItem}. Plain-string completions keep the
 * legacy `Reference` kind. Snippet completions emit `InsertTextFormat.Snippet` only when the client
 * supports it. Otherwise, their insert text is flattened to plain text so they still work. A
 * suggestion carrying a range becomes an edit over exactly that range, so the client replaces the
 * text the completer measured instead of the word its own word pattern finds.
 *
 * @param completion the suggestion to convert.
 * @param snippetSupported whether the client renders snippet insert text.
 * @param insertReplaceSupported whether the client declared `completionItem.insertReplaceSupport`.
 * @returns the completion item to ship.
 */
export const toCompletionItem = (
    completion: Completion,
    snippetSupported: boolean,
    insertReplaceSupported = false
): CompletionItem => {
    if (typeof completion === 'string') {
        return { label: completion, kind: CompletionItemKind.Reference };
    }

    const item: CompletionItem = { label: completion.label, kind: completion.kind ?? CompletionItemKind.Reference };
    if (completion.detail) item.detail = completion.detail;
    if (completion.documentation) item.documentation = { kind: MarkupKind.Markdown, value: completion.documentation };
    if (completion.sortText) item.sortText = completion.sortText;
    if (completion.filterText) item.filterText = completion.filterText;
    if (completion.preselect) item.preselect = true;

    if (completion.insertText !== undefined) {
        if (completion.isSnippet && snippetSupported) {
            item.insertText = completion.insertText;
            item.insertTextFormat = InsertTextFormat.Snippet;
            // Normalize the snippet's subsequent-line indentation to the insertion point so a
            // multi-line `{ … }` / `[ … ]` block nests correctly under the cursor's column.
            item.insertTextMode = InsertTextMode.adjustIndentation;
            // A snippet insertion fires no typing triggers, so a snippet that parks the cursor at a
            // value position asks the client to reopen the popup there itself.
            if (completion.triggerSuggest) {
                item.command = { title: 'Trigger Suggest', command: 'editor.action.triggerSuggest' };
            }
        } else {
            item.insertText = completion.isSnippet ? snippetToPlainText(completion.insertText) : completion.insertText;
        }
    }
    // The range is applied last so the edit carries whatever insert text the snippet handling above
    // settled on, and the now-redundant `insertText` is dropped because a text edit supersedes it.
    if (completion.range) {
        item.textEdit = editFor(completion, item.insertText ?? completion.label, insertReplaceSupported);
        delete item.insertText;
    }
    return item;
};
