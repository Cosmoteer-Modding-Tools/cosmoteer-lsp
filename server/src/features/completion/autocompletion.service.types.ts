import { CancellationToken, CompletionItemKind, Range } from 'vscode-languageserver';
import { AbstractNode } from '../../core/ast/ast';

/**
 * A richer completion than a bare label: lets a completer carry a {@link CompletionItemKind}
 * (so the UI shows Field/Keyword/Snippet icons) and an `insertText` distinct from the label:
 * an LSP snippet (`isSnippet`, with `$1`/`${1:…}` tab stops) when a whole block is inserted.
 */
export interface CompletionSuggestion {
    label: string;
    kind?: CompletionItemKind;
    insertText?: string;
    isSnippet?: boolean;
    detail?: string;
    /** Rich popup documentation (markdown), e.g. a field's full schema signature. */
    documentation?: string;
    /** Overrides lexicographic ordering by label (e.g. to sort required fields first). */
    sortText?: string;
    /** Reopens the suggestion popup after the insert, for a snippet whose final tab stop lands at a
     *  value position with its own completions (a scaffolded `Type = ` waiting for its subtype). */
    triggerSuggest?: boolean;
    /** The document text the insert replaces. Without it the client picks the range from its own word
     *  pattern, which breaks at `.` and `/`, so a slash-joined localization key or a dotted id lands
     *  after the head the user already typed (`Parts/` + `Parts/CannonMed`). A completer whose label
     *  is the whole value passes the value's range, one whose label is a path segment passes that
     *  segment's. */
    range?: Range;
    /** The text the client matches the typed prefix against. Defaults to the label. */
    filterText?: string;
    /** Marks the item the popup opens on. */
    preselect?: boolean;
}

/** A completion is either a plain label (kind defaulted) or a richer {@link CompletionSuggestion}. */
export type Completion = string | CompletionSuggestion;

/**
 * A completer for a specific AST node type, which may offer completions for that node.
 * The completer is responsible for filtering out nodes it doesn't handle (e.g. by type or quoting).
 */
export interface AutoCompletion<T extends AbstractNode> {
    /**
     *  Returns the completions for `node`, or an empty array if this completer doesn't handle it.
     * @param node  The AST node for which to provide completions.
     * @param cancellationToken A token to signal cancellation of the completion request.
     * @param cursorOffset The document offset of the cursor, when known. A completer that resolves a
     * multi-segment value (a reference path) uses it to complete the segment AT the cursor rather than
     * the whole written value, so mid-path editing offers the right members. Ignored by completers
     * whose value is atomic.
     */
    getCompletions(node: T, cancellationToken: CancellationToken, cursorOffset?: number): Promise<Completion[]>;
}
