import { describe, expect, it } from 'vitest';
import { Range } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { markupColors, markupColorPresentations } from '../../../src/features/color/markup-color';

const STRINGS = 'file:///c%3A/mod/strings/en.rules';
const OTHER = 'file:///c%3A/mod/parts/cannon.rules';

const parse = (src: string, uri = STRINGS) => parser(lexer(src), uri).value;

/**
 * A strings file declaring one key with the given text.
 *
 * @param value the translated text, already quoted.
 * @returns the strings file text.
 */
const stringsWith = (value: string): string => ['__Name = English', `Parts/Thing = ${value}`, ''].join('\n');

// The colours a language file sets live inside its strings, written as the markup tags the game
// draws the text with, so the swatch and the picker both have to work on the tag itself.
describe('markup colour swatches', () => {
    it('reads the r/g/b channels of a colour tag, alpha opaque when it is not written', () => {
        const colors = markupColors(parse(stringsWith(`"<color r='255' g='128' b='0'>Fire</color>"`)));
        expect(colors).toHaveLength(1);
        expect(colors[0].color).toEqual({ red: 1, green: 128 / 255, blue: 0, alpha: 1 });
    });

    it('reads a hex colour, alpha included', () => {
        expect(markupColors(parse(stringsWith(`"<background hex='0000FF80'>x</background>"`)))[0].color).toEqual({
            red: 0,
            green: 0,
            blue: 1,
            alpha: 128 / 255,
        });
    });

    it('reads a named colour, matched however it is cased', () => {
        expect(markupColors(parse(stringsWith(`"<color name='cyan'>x</color>"`)))[0].color).toEqual({
            red: 0,
            green: 1,
            blue: 1,
            alpha: 1,
        });
    });

    it('says nothing about a colour it cannot read, so the picker never lands on one', () => {
        expect(markupColors(parse(stringsWith(`"<color r='a lot'>x</color>"`)))).toHaveLength(0);
        expect(markupColors(parse(stringsWith(`"<color name='Chartreuse'>x</color>"`)))).toHaveLength(0);
    });

    it('leaves the colour tags of an ordinary rules file alone', () => {
        expect(markupColors(parse(stringsWith(`"<color r='255'>x</color>"`), OTHER))).toHaveLength(0);
    });

    it('spans the tag itself, so the swatch sits in front of the text it colours', () => {
        const colors = markupColors(parse(stringsWith(`"<color r='255'>Fire</color>"`)));
        const line = stringsWith(`"<color r='255'>Fire</color>"`).split('\n')[1];
        expect(colors[0].range.start).toEqual({ line: 1, character: line.indexOf('<color') });
        expect(colors[0].range.end).toEqual({ line: 1, character: line.indexOf('>') + 1 });
    });

    it('rewrites the channels the author wrote, keeping the element and the quotes', () => {
        const document = parse(stringsWith(`"<color r='255' g='128' b='0'>Fire</color>"`));
        const range = markupColors(document)[0].range;
        const [presentation] = markupColorPresentations(document, range, { red: 0, green: 0.5, blue: 1, alpha: 1 });
        expect(presentation.textEdit?.newText).toBe(`<color r='0' g='128' b='255'>`);
        expect(presentation.textEdit?.range).toEqual(range);
    });

    it('writes alpha back only where the colour has any', () => {
        const document = parse(stringsWith(`"<color r='255' g='0' b='0'>Fire</color>"`));
        const range = markupColors(document)[0].range;
        const [presentation] = markupColorPresentations(document, range, { red: 1, green: 0, blue: 0, alpha: 0.5 });
        expect(presentation.textEdit?.newText).toBe(`<color r='255' g='0' b='0' a='128'>`);
    });

    it('keeps a hex tag hexadecimal and a name tag named where the colour still has a name', () => {
        const hex = parse(stringsWith(`"<color hex='FF0000'>x</color>"`));
        expect(
            markupColorPresentations(hex, markupColors(hex)[0].range, { red: 0, green: 1, blue: 0, alpha: 1 })[0]
                .textEdit?.newText
        ).toBe(`<color hex='00FF00'>`);
        const named = parse(stringsWith(`"<color name='Red'>x</color>"`));
        expect(
            markupColorPresentations(named, markupColors(named)[0].range, { red: 0, green: 0, blue: 1, alpha: 1 })[0]
                .textEdit?.newText
        ).toBe(`<color name='Blue'>`);
    });

    it('falls back to hex when the picked colour has no name', () => {
        const named = parse(stringsWith(`"<color name='Red'>x</color>"`));
        const edit = markupColorPresentations(named, markupColors(named)[0].range, {
            red: 0.1,
            green: 0.2,
            blue: 0.3,
            alpha: 1,
        })[0].textEdit;
        expect(edit?.newText).toBe(`<color hex='1A334D'>`);
    });

    it('keeps escaped quotes escaped, so the string it is written in stays intact', () => {
        const document = parse(stringsWith(`"<color r=\\"255\\">x</color>"`));
        const range = markupColors(document)[0].range;
        const edit = markupColorPresentations(document, range, { red: 0, green: 0, blue: 0, alpha: 1 })[0].textEdit;
        expect(edit?.newText).toBe(`<color r=\\"0\\">`);
    });

    it('keeps the tag exactly as written when the pick lands back on its own colour', () => {
        // `r='127.5'` is a channel the reader takes and the byte form cannot spell, so a pick that
        // moves nothing has to leave it alone rather than round it to 128.
        const document = parse(stringsWith(`"<color r='127.5'>x</color>"`));
        const info = markupColors(document)[0];
        const edit = markupColorPresentations(document, info.range, info.color)[0].textEdit;
        expect(edit?.newText).toBe(`<color r='127.5'>`);
    });

    it('spells out only the channels the reader does not default', () => {
        // A missing `r`, `g` or `b` is 0 and a missing `a` is opaque, so neither is worth writing.
        const document = parse(stringsWith(`"<color a='0'>x</color>"`));
        const info = markupColors(document)[0];
        const edit = markupColorPresentations(document, info.range, { red: 0, green: 1, blue: 0, alpha: 0 })[0]
            .textEdit;
        expect(edit?.newText).toBe(`<color g='255' a='0'>`);
    });

    it('answers nothing for a range that is no colour tag of this file', () => {
        const document = parse(stringsWith(`"<color r='255'>x</color>"`));
        expect(markupColorPresentations(document, Range.create(9, 9, 9, 9), { red: 0, green: 0, blue: 0, alpha: 1 })).toEqual(
            []
        );
    });
});
