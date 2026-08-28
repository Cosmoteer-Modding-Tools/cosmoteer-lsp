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
    (await validateTextMarkup(parser(lexer(text), uri).value, token)).map((error) => error.message);

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
