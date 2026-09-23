import { afterEach, describe, expect, it } from 'vitest';
import { Position, TextEdit } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { markupColors, markupColorPresentations } from '../../../src/features/color/markup-color';
import { useMarkupSourceReader } from '../../../src/features/text-markup/markup-source';

const STRINGS = 'file:///c%3A/mod/strings/en.rules';

/** The colour the picker is dragged to, which the tags below are all rewritten to. */
const PICKED = { red: 0.25, green: 0.5, blue: 0.75, alpha: 1 };

/**
 * Parses a language file and hands its text to the markup layer, the way an open buffer does.
 *
 * @param source the whole file.
 * @returns the parsed document.
 */
const openFile = (source: string) => {
    useMarkupSourceReader((uri) => (uri === STRINGS ? source : undefined));
    return parser(lexer(source), STRINGS).value;
};

/**
 * The offset a position sits at, counted the way an editor counts it.
 *
 * @param source the file's text.
 * @param position the zero-based line and character.
 * @returns the offset.
 */
const offsetAt = (source: string, position: Position): number => {
    const lines = source.split('\n');
    let offset = 0;
    for (let line = 0; line < position.line; line++) offset += lines[line].length + 1;
    return offset + position.character;
};

/**
 * The file as it stands after the editor applies one of the picker's edits.
 *
 * @param source the file's text.
 * @param edit the edit the picker handed back.
 * @returns the rewritten file.
 */
const applied = (source: string, edit: TextEdit): string =>
    source.slice(0, offsetAt(source, edit.range.start)) + edit.newText + source.slice(offsetAt(source, edit.range.end));

/**
 * The file after the colour picker is dragged onto the first swatch the file offers.
 *
 * @param source the file's text.
 * @returns the rewritten file.
 */
const afterPicking = (source: string): string => {
    const document = openFile(source);
    const swatches = markupColors(document);
    expect(swatches).toHaveLength(1);
    const [presentation] = markupColorPresentations(document, swatches[0].range, PICKED);
    expect(presentation?.textEdit).toBeDefined();
    return applied(source, presentation.textEdit!);
};

// A value's written form and the text the parser carries are two different strings the moment the
// value is written over a line continuation or as a verbatim string, and the picker rewrites the
// file itself, so what the edit does to the file is the only thing worth asserting.
describe('the colour picker on a value that spans lines', () => {
    afterEach(() => useMarkupSourceReader(undefined));

    it('rewrites the tag of a value written on one line', () => {
        const source = ['__Name = English', `Parts/Thing = "first line with <color hex='FF0000'>red</color>"`, ''].join(
            '\n'
        );
        expect(afterPicking(source)).toBe(
            ['__Name = English', `Parts/Thing = "first line with <color hex='4080BF'>red</color>"`, ''].join('\n')
        );
    });

    it('rewrites the tag of a value carried on by a trailing backslash', () => {
        const source = [
            '__Name = English',
            `Parts/Thing = "first line with "\\`,
            `\t"<color hex='FF0000'>red</color>"`,
            '',
        ].join('\n');
        expect(afterPicking(source)).toBe(
            ['__Name = English', `Parts/Thing = "first line with "\\`, `\t"<color hex='4080BF'>red</color>"`, ''].join(
                '\n'
            )
        );
    });

    it('rewrites the tag of a verbatim string that runs over several lines', () => {
        const source = ['__Name = English', 'Parts/Thing = @"head', `<color hex='FF0000'>red</color>"`, ''].join('\n');
        expect(afterPicking(source)).toBe(
            ['__Name = English', 'Parts/Thing = @"head', `<color hex='4080BF'>red</color>"`, ''].join('\n')
        );
    });

    it('rewrites the tag of two segments joined on one line', () => {
        const source = ['__Name = English', `Parts/Thing = "<color hex='FF0000'>head</color> " "tail"`, ''].join('\n');
        expect(afterPicking(source)).toBe(
            ['__Name = English', `Parts/Thing = "<color hex='4080BF'>head</color> " "tail"`, ''].join('\n')
        );
    });

    it('offers no swatch for a tag written across the join, since no span of the file covers it', () => {
        // The game reads the two segments as one string and sees one whole tag. The file does not
        // carry it as one run, so a swatch on it could only point at the wrong characters.
        const source = ['__Name = English', `Parts/Thing = "<color "\\`, `\thex='FF0000'>red</color>"`, ''].join('\n');
        expect(markupColors(openFile(source))).toEqual([]);
    });

    it('puts the swatch on the tag itself in a value carried on by a backslash', () => {
        const source = [
            '__Name = English',
            `Parts/Thing = "first line with "\\`,
            `\t"<color hex='FF0000'>red</color>"`,
            '',
        ].join('\n');
        const [swatch] = markupColors(openFile(source));
        expect(swatch.range).toEqual({
            start: { line: 2, character: 2 },
            end: { line: 2, character: 22 },
        });
    });
});
