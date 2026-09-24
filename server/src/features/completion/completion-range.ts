import { Position, Range } from 'vscode-languageserver';
import { ValueNode } from '../../core/ast/ast';
import { Completion, CompletionSuggestion } from './autocompletion.service.types';

/** The run of value characters ending at the cursor. `.` and `/` belong to it: a localization key is
 *  one slash-joined value (`Parts/CannonMed`) and a cross-file id one dotted value
 *  (`cosmoteer.cannon_med`), not several words. A quote is not a value character, so a quoted value's
 *  delimiters stay outside every range built from it. */
const VALUE_CHAR = /[A-Za-z0-9_./-]/;

/**
 * The value text the user has already typed left of the cursor. The run is walked backwards from the
 * cursor rather than matched with an end-anchored `*$` pattern, which the engine retries from every
 * position of the line and so costs the square of an unbroken value run.
 *
 * @param linePrefix the line text from its start up to the cursor.
 * @returns the run of value characters ending at the cursor, empty when the cursor follows a quote,
 * a space or an operator.
 */
export const valueRunAtCursor = (linePrefix: string): string => {
    let start = linePrefix.length;
    while (start > 0 && VALUE_CHAR.test(linePrefix[start - 1])) start--;
    return linePrefix.slice(start);
};

/**
 * The range a completion whose label is the complete value replaces when the written value is not in
 * the tree: everything typed of that value, ending at the cursor. It is the fallback for a position
 * that has nothing written past the caret, an empty `Key = ` slot or a quoted value whose closing
 * quote is still missing. A value the parser did produce a node for is measured from that node by
 * {@link writtenValueRange} instead, so a caret parked inside it replaces the whole value rather than
 * leaving its tail behind.
 *
 * @param position the cursor position.
 * @param valueRun the value text left of the cursor, from {@link valueRunAtCursor}.
 * @returns the replace range.
 */
export const wholeValueRange = (position: Position, valueRun: string): Range => ({
    start: { line: position.line, character: Math.max(0, position.character - valueRun.length) },
    end: position,
});

/**
 * The span of the value text a node has written, with a quoted value's own delimiters left outside
 * it. A completer whose label is the complete value replaces exactly this, so accepting a suggestion
 * with the caret inside the written value overwrites the value instead of writing in front of its
 * tail. A value whose text does not sit on one line as one token (a `\` continuation, a run of
 * concatenated quoted segments) is left unmeasured, which keeps the caret-bounded fallback.
 *
 * @param node the value node the caret is on.
 * @returns the range the written value occupies, or undefined when it cannot be measured.
 */
export const writtenValueRange = (node: ValueNode): Range | undefined => {
    const position = node.position;
    if (!position) return undefined;
    const written = String(node.valueType.value ?? '');
    const quoteWidth = node.quoted ? 1 : 0;
    if (position.characterEnd - position.characterStart !== written.length + 2 * quoteWidth) return undefined;
    return {
        start: { line: position.line, character: position.characterStart + quoteWidth },
        end: { line: position.line, character: position.characterEnd - quoteWidth },
    };
};

/**
 * The insert range that pairs with a replace range: the same start, ending at the caret. The client
 * picks between the two with its own `insertMode`, so an editor set to insert keeps the tail of the
 * value and one set to replace overwrites it. A caret at the end of the written value makes the two
 * ranges identical and yields none, which leaves the completion a plain replacement.
 *
 * @param replace the range the completion replaces.
 * @param caret the cursor position.
 * @returns the insert range, or undefined when it would not differ from the replace range.
 */
export const insertRangeWithin = (replace: Range, caret: Position): Range | undefined => {
    if (caret.line !== replace.start.line || replace.start.line !== replace.end.line) return undefined;
    if (caret.character < replace.start.character || caret.character >= replace.end.character) return undefined;
    return { start: replace.start, end: { line: replace.start.line, character: caret.character } };
};

/**
 * The span of the path segment the caret sits in, for a completer whose labels are single segments
 * (`terran/`, `base_part.rules>`, `Scorched`). The replace end is the segment's own end, never the
 * end of the value, so completing a middle segment leaves the rest of the path standing.
 */
export interface SegmentSpan {
    /** The line the whole segment sits on. */
    line: number;
    /** The character the segment starts at. */
    start: number;
    /** The character the segment ends at, with its closing delimiter left outside. */
    end: number;
    /** The cursor's character, which bounds the insert range. */
    caret: number;
    /** The delimiter that closes the segment (`/` or `>`), absent at the end of the written value. */
    delimiter?: string;
}

/** The text a suggestion writes, which decides whether it carries a segment's delimiter itself. */
const insertedTextOf = (suggestion: CompletionSuggestion): string => suggestion.insertText ?? suggestion.label;

/** A completion as a suggestion object the taggers can write on, copied so a shared suggestion the
 *  caller still holds keeps the range it came with. */
const asSuggestion = (completion: Completion): CompletionSuggestion =>
    typeof completion === 'string' ? { label: completion } : { ...completion };

/** Writes the range a suggestion replaces and the insert range that pairs with it, which is left off
 *  when the caret does not fall inside the replaced span. */
const applyRange = (
    suggestion: CompletionSuggestion,
    replace: Range,
    caret: Position | undefined
): CompletionSuggestion => {
    suggestion.range = replace;
    const insertRange = caret && insertRangeWithin(replace, caret);
    if (insertRange) suggestion.insertRange = insertRange;
    return suggestion;
};

/**
 * Tags single-segment completions with the segment they replace. A label that spells out the
 * segment's delimiter (a folder's `terran/`, a file's `base_part.rules>`) replaces that delimiter as
 * well, or accepting it would double it. A label without one (a member name) leaves the delimiter in
 * place, so the path after it still reads.
 *
 * @param completions the completions the strategy answered with.
 * @param span the segment the caret sits in, or undefined to leave the client its own measurement.
 * @returns the tagged completions.
 */
export const withSegmentEdit = (completions: Completion[], span: SegmentSpan | undefined): Completion[] => {
    if (!span) return completions;
    const start = { line: span.line, character: span.start };
    return completions.map((completion) => {
        const suggestion = asSuggestion(completion);
        const carriesDelimiter = !!span.delimiter && insertedTextOf(suggestion).endsWith(span.delimiter);
        const end = { line: span.line, character: span.end + (carriesDelimiter ? 1 : 0) };
        return applyRange(suggestion, { start, end }, { line: span.line, character: span.caret });
    });
};

/**
 * The cursor's position inside a value node, when it sits in the value's own text. A value token
 * never spans lines, so the node's line and start column place the caret exactly.
 *
 * @param node the value node the caret is on.
 * @param cursorOffset the document offset of the cursor, when known.
 * @returns the caret position, or undefined when the cursor is not inside the node.
 */
export const caretInValue = (node: ValueNode, cursorOffset?: number): Position | undefined => {
    const position = node.position;
    if (cursorOffset === undefined || !position) return undefined;
    if (cursorOffset < position.start || cursorOffset > position.end) return undefined;
    return { line: position.line, character: position.characterStart + (cursorOffset - position.start) };
};

/**
 * Tags completions whose label is the complete value with the range they replace and the caret the
 * insert range ends at.
 *
 * @param completions the completions to tag.
 * @param range the written value's range, from {@link writtenValueRange}.
 * @param caret the cursor position, absent when the completer does not know it and the caller's
 * fallback range supplies it.
 * @returns the tagged completions.
 */
export const withValueEdit = (completions: Completion[], range: Range | undefined, caret?: Position): Completion[] => {
    if (!range) return completions;
    return completions.map((completion) => applyRange(asSuggestion(completion), range, caret));
};

/**
 * The text a whole-value completion must append to leave the value well formed: the closing quote of
 * a quoted value the user opened but has not closed. An editor that auto-closes quotes writes it
 * already, and JetBrains and hand-typed values do not, so it is derived from the buffer rather than
 * assumed either way.
 *
 * @param linePrefix the line text from its start up to the cursor.
 * @param lineSuffix the line text from the cursor to the line end.
 * @returns `"` when the cursor sits in an unclosed quoted value, otherwise the empty string.
 */
export const openQuoteSuffix = (linePrefix: string, lineSuffix: string): string => {
    const quotesBefore = (linePrefix.match(/"/g) ?? []).length;
    if (quotesBefore % 2 === 0) return '';
    return lineSuffix.includes('"') ? '' : '"';
};

/**
 * Tags completions whose label is the complete value with the range that value occupies, so
 * accepting one replaces the typed text instead of being appended to it. A completion that already
 * carries a range measured it against the tree or against the segment the caret sits in, which knows
 * the text right of the caret that a line prefix cannot, so that measurement is kept and only the
 * caret it inserts up to is filled in.
 *
 * @param completions the completions to tag.
 * @param range the caret-bounded fallback range from {@link wholeValueRange}.
 * @param suffix text to append to the inserted value, from {@link openQuoteSuffix}.
 * @returns the tagged completions.
 */
export const withReplaceRange = (completions: Completion[], range: Range, suffix = ''): Completion[] =>
    completions.map((completion) => {
        const suggestion = asSuggestion(completion);
        suggestion.range = suggestion.range ?? range;
        const insertRange = suggestion.insertRange ?? insertRangeWithin(suggestion.range, range.end);
        if (insertRange) suggestion.insertRange = insertRange;
        // A snippet writes its own delimiters and tab stops, so a raw suffix would land after the
        // final stop and unbalance it.
        if (suffix && !suggestion.isSnippet)
            suggestion.insertText = (suggestion.insertText ?? suggestion.label) + suffix;
        return suggestion;
    });
