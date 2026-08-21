import { Position, Range } from 'vscode-languageserver';
import { Completion, CompletionSuggestion } from './autocompletion.service';

/** The run of value characters ending at the cursor. `.` and `/` belong to it: a localization key is
 *  one slash-joined value (`Parts/CannonMed`) and a cross-file id one dotted value
 *  (`cosmoteer.cannon_med`), not several words. A quote is not a value character, so a quoted value's
 *  delimiters stay outside every range built from it. */
const VALUE_RUN_AT_CURSOR = /[A-Za-z0-9_./-]*$/;

/**
 * The value text the user has already typed left of the cursor.
 *
 * @param linePrefix the line text from its start up to the cursor.
 * @returns the run of value characters ending at the cursor, empty when the cursor follows a quote,
 * a space or an operator.
 */
export const valueRunAtCursor = (linePrefix: string): string => VALUE_RUN_AT_CURSOR.exec(linePrefix)?.[0] ?? '';

/**
 * The range a completion whose label is the complete value replaces: everything typed of that value,
 * ending at the cursor. It never reaches past the cursor, so text right of the caret (the closing
 * quote the editor auto-inserted, or the tail of a value being edited in the middle) is left alone.
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
 * accepting one replaces the typed text instead of being appended to it.
 *
 * @param completions the completions to tag.
 * @param range the replace range from {@link wholeValueRange}.
 * @param suffix text to append to the inserted value, from {@link openQuoteSuffix}.
 * @returns the tagged completions.
 */
export const withReplaceRange = (completions: Completion[], range: Range, suffix = ''): Completion[] =>
    completions.map((completion) => {
        const suggestion: CompletionSuggestion =
            typeof completion === 'string' ? { label: completion } : { ...completion };
        suggestion.range = range;
        // A snippet writes its own delimiters and tab stops, so a raw suffix would land after the
        // final stop and unbalance it.
        if (suffix && !suggestion.isSnippet) suggestion.insertText = (suggestion.insertText ?? suggestion.label) + suffix;
        return suggestion;
    });
