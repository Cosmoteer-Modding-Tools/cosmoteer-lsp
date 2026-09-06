import { describe, expect, it } from 'vitest';
import { Position } from 'vscode-languageserver';
import { markupCompletionsAt } from '../../../src/features/completion/autocompletion.text-markup';
import { CompletionSuggestion } from '../../../src/features/completion/autocompletion.service';

const STRINGS = 'file:///c%3A/mod/strings/en.rules';

/**
 * The completions offered at the end of a written line.
 *
 * @param linePrefix the line up to the cursor.
 * @param uri the file the line is in.
 * @returns the labels offered there, empty when nothing is.
 */
const labels = (linePrefix: string, uri = STRINGS): string[] =>
    (markupCompletionsAt(uri, linePrefix, Position.create(1, linePrefix.length))?.completions ?? []).map((completion) =>
        typeof completion === 'string' ? completion : completion.label
    );

/**
 * One offered completion, for the inserts and ranges the labels alone do not carry.
 *
 * @param linePrefix the line up to the cursor.
 * @param label the completion to pick out.
 * @returns the suggestion, or undefined when it was not offered.
 */
const suggestion = (linePrefix: string, label: string): CompletionSuggestion | undefined =>
    markupCompletionsAt(STRINGS, linePrefix, Position.create(1, linePrefix.length))
        ?.completions.filter((completion): completion is CompletionSuggestion => typeof completion !== 'string')
        .find((completion) => completion.label === label);

// The markup the game draws its text with is a closed vocabulary, so the whole of it can be offered
// while the author types a tag inside a language file's string.
describe('text markup completion', () => {
    it('offers the elements the reader knows after a <', () => {
        const offered = labels('Parts/Thing = "<');
        expect(offered).toContain('color');
        expect(offered).toContain('img');
        expect(offered).toContain('good');
        expect(offered).toContain('Green');
    });

    it('closes an element that wraps text, and self-closes one that does not', () => {
        expect(suggestion('Parts/Thing = "<', 'b')?.insertText).toBe('b>${1}</b>');
        expect(suggestion('Parts/Thing = "<', 'img')?.insertText).toBe("img name='${1}'/>");
    });

    it('replaces the element name the author has typed so far', () => {
        const context = markupCompletionsAt(STRINGS, 'A = "<col', Position.create(1, 9));
        expect(context?.range).toEqual({ start: { line: 1, character: 6 }, end: { line: 1, character: 9 } });
    });

    it('offers the element still open after a </', () => {
        expect(labels('A = "<good>Ready</')).toEqual(['good']);
        expect(labels('A = "<good>Ready</good> and <b>go</')).toEqual(['b']);
    });

    it('offers the attributes of the element the cursor is in', () => {
        expect(labels("A = \"<color ")).toEqual(['hex', 'name', 'r', 'g', 'b', 'a']);
        expect(labels("A = \"<img name='money' ")).toEqual(['w', 'width', 'h', 'height', 'colored']);
    });

    it('offers the values an attribute takes, inside its quotes', () => {
        expect(labels("A = \"<halign value='")).toEqual(['Left', 'Center', 'Right']);
        expect(labels("A = \"<b enable='")).toEqual(['true', 'false']);
        expect(labels("A = \"<color name='")).toContain('TransparentWhite');
    });

    it('asks for the project strings keys inside the id of a string tag', () => {
        const context = markupCompletionsAt(STRINGS, "A = \"<string id='", Position.create(1, 17));
        expect(context?.localizationKeys).toBe(true);
    });

    it('says nothing where the tag is already closed, or outside a language file', () => {
        expect(markupCompletionsAt(STRINGS, 'A = "<b>Ready', Position.create(1, 13))).toBeUndefined();
        expect(markupCompletionsAt('file:///c%3A/mod/parts/x.rules', 'A = "<', Position.create(1, 6))).toBeUndefined();
    });

    it('says nothing about an element it does not know, whose attributes it cannot name', () => {
        expect(markupCompletionsAt(STRINGS, 'A = "<glow ', Position.create(1, 11))).toBeUndefined();
    });
});
