import { describe, expect, it, vi } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { validateTextMarkup } from '../../../src/features/diagnostics/validator.text-markup';

vi.mock('../../../src/mod/mod-root', () => ({ findModRoot: (uri: string) => (/vanilla/.test(uri) ? undefined : 'mod') }));

const MOD_STRINGS = 'file:///c%3A/mod/strings/en.rules';
const GAME_STRINGS = 'file:///c%3A/vanilla/strings/en.rules';
const token = CancellationToken.None;

const findings = async (text: string, uri = MOD_STRINGS): Promise<string[]> =>
    (await validateTextMarkup(parser(lexer(text), uri).value, [], token)).map((error) => error.message);

/**
 * A strings file declaring one key with the given text.
 *
 * @param value the translated text, already quoted.
 * @returns the strings file text.
 */
const stringsWith = (value: string): string => ['__Name = English', `Parts/Thing = ${value}`, ''].join('\n');

// The game catches everything its markup reader throws and answers by drawing the string again with
// no markup at all, logging nothing, so the tags reach the player as text.
describe('markup the game cannot read', () => {
    it('says nothing about a string whose tags close', async () => {
        expect(await findings(stringsWith('"<good>Ready</good> to fire"'))).toEqual([]);
    });

    it('says nothing about a string with no markup in it at all', async () => {
        expect(await findings(stringsWith('"Reactor output < 50 percent & falling"'))).toEqual([]);
    });

    it('flags a tag that never closes', async () => {
        expect(await findings(stringsWith('"<gray>Salvage"'))).toEqual([
            "The 'gray' tag is never closed, so the game gives up on this string and draws its tags as plain text.",
        ]);
    });

    it('flags a closing tag for something else', async () => {
        expect(await findings(stringsWith('"<good>Ready</bad>"'))).toEqual([
            "This closes a tag other than 'good', the one still open, so the game gives up on this string and draws its tags as plain text.",
        ]);
    });

    it('flags a closing tag with nothing open', async () => {
        expect(await findings(stringsWith('"Ready</good>"'))).toEqual([
            "There is no 'good' tag open here, so the game gives up on this string and draws its tags as plain text.",
        ]);
    });

    it('flags a bare ampersand in a string that does carry markup', async () => {
        expect(await findings(stringsWith('"<good>Taim & Bak</good>"'))).toEqual([
            "A bare '&' is not markup, so the game gives up on this string and draws its tags as plain text. Write it as '&amp;'.",
        ]);
    });

    it('accepts an escaped ampersand', async () => {
        expect(await findings(stringsWith('"<good>Taim &amp; Bak</good>"'))).toEqual([]);
    });

    it('flags an attribute whose value is not quoted', async () => {
        expect(await findings(stringsWith('"<image name=sort/> Favourites"'))).toEqual([
            "The 'name' attribute needs a quoted value. Without one the game gives up on this string and draws its tags as plain text.",
        ]);
    });

    it('accepts a self-closing tag with a quoted attribute', async () => {
        expect(await findings(stringsWith('"<image name=\\"sort\\"/> Favourites"'))).toEqual([]);
    });

    it("leaves the game's own translations alone, which a mod cannot correct", async () => {
        expect(await findings(stringsWith('"<gray>Salvage"'), GAME_STRINGS)).toEqual([]);
    });

    it('leaves a file outside a strings folder alone', async () => {
        expect(await findings(stringsWith('"<gray>Salvage"'), 'file:///c%3A/mod/parts/thing.rules')).toEqual([]);
    });
});

// Beside the shape of the fragment, every tag is judged against the element the reader would run
// for it, which is a closed vocabulary read from the engine.
describe('tags the markup reader does not run', () => {
    it('flags an element the reader knows nothing about', async () => {
        expect(await findings(stringsWith('"<glow>Ready</glow>"'))).toEqual([
            "The game draws no 'glow' tag, so it gives up on this string and draws its tags as plain text.",
        ]);
    });

    it('names the case of a handler tag, which is matched ordinally', async () => {
        expect(await findings(stringsWith('"<Good>Ready</Good>"'))).toEqual([
            "The game draws no 'Good' tag, so it gives up on this string and draws its tags as plain text. Tag names are case-sensitive here, write 'good'.",
        ]);
    });

    it('takes a named colour, a size tag and a built-in however they are cased', async () => {
        expect(await findings(stringsWith('"<s14><GREEN><B>Ready</B></GREEN></s14>"'))).toEqual([]);
    });

    it('flags the attribute an element throws without', async () => {
        expect(await findings(stringsWith(`"<img/>"`))).toEqual([
            "The 'img' tag needs a 'name' attribute. Without it the game gives up on this string and draws its tags as plain text.",
        ]);
    });

    it('flags a value the element cannot parse', async () => {
        expect(await findings(stringsWith(`"<size value='12.5'>x</size>"`))).toEqual([
            "'value' takes a whole number here, so the game gives up on this string and draws its tags as plain text.",
        ]);
        expect(await findings(stringsWith(`"<color hex='#FF0000'>x</color>"`))).toEqual([
            "'hex' takes six or eight hex digits, written without a leading # here, so the game gives up on this string and draws its tags as plain text.",
        ]);
        expect(await findings(stringsWith(`"<halign value='middle'>x</halign>"`))).toEqual([
            "'value' takes one of Left, Center, Right here, so the game gives up on this string and draws its tags as plain text.",
        ]);
        expect(await findings(stringsWith(`"<color name='Chartreuse'>x</color>"`))).toEqual([
            "'name' takes one of Zero, Black, Red, Green, Blue, Yellow, Orange, Magenta, Cyan, White, Gray, TransparentWhite here, so the game gives up on this string and draws its tags as plain text.",
        ]);
    });

    it('takes the colour channels as the game parses them, which is as numbers', async () => {
        expect(await findings(stringsWith(`"<color r='250' g='176' b='86' a='255'>x</color>"`))).toEqual([]);
    });

    it('takes the lenient booleans the style toggles read', async () => {
        expect(await findings(stringsWith(`"<b enable='no'>x</b>"`))).toEqual([]);
        expect(await findings(stringsWith(`"<img name='money' colored='yes'/>"`))).toEqual([
            "'colored' takes one of true, false here, so the game gives up on this string and draws its tags as plain text.",
        ]);
    });

    it('reports an attribute the element never reads as dead weight', async () => {
        expect(await findings(stringsWith(`"<img name='money' scale='2'/>"`))).toEqual([
            "The 'img' tag reads no 'scale' attribute, so this has no effect.",
        ]);
    });

    it('reports a font tag, which reaches a table the game never fills', async () => {
        expect(await findings(stringsWith(`"<font name='big'>Fire</font>"`))).toEqual([
            "Nothing in the game registers a font, so a 'font' tag always makes it give up on this string and draw its tags as plain text.",
        ]);
    });

    it('reports a colour attribute another one on the same tag already decided', async () => {
        expect(await findings(stringsWith(`"<color hex='FF0000' r='12'>x</color>"`))).toEqual([
            "'hex' already sets the colour of this tag, so 'r' has no effect.",
        ]);
    });
});
