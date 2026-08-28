import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { AbstractNodeDocument } from '../../../src/core/ast/ast';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { validateBlendSpriteCodes } from '../../../src/features/diagnostics/validator.blend-sprite';
import { workspaceFile } from '../../workspace-helper';

const PART_PATH = workspaceFile('parts', 'blend_part.rules');
const token = CancellationToken.None;

const parse = (text: string): AbstractNodeDocument => parser(lexer(text), PART_PATH).value;

const findings = async (text: string): Promise<string[]> =>
    (await validateBlendSpriteCodes(parse(text), token)).map((error) => error.message);

/**
 * A part carrying one blend sprite component, with the sprite entries written in.
 *
 * @param entries the sprite bodies, each the inside of one `{ }`.
 * @returns the part file text.
 */
const partWith = (...entries: string[]): string =>
    [
        'Part',
        '{',
        '\tID = test.blend_part',
        '\tComponents',
        '\t{',
        '\t\tWalls',
        '\t\t{',
        '\t\t\tType = BlendSprite',
        '\t\t\tAmbiguousSprites',
        '\t\t\t[',
        ...entries.map((body) => `\t\t\t\t{ ${body} }`),
        '\t\t\t]',
        '\t\t}',
        '\t}',
        '}',
        '',
    ].join('\n');

// The expander has a case for each of the three characters and throws on anything else, well after
// the file loaded, so nothing about this shows up at load time.
describe('blend sprite situation codes', () => {
    it('says nothing about a code written the way the game writes its own', async () => {
        expect(await findings(partWith('SituationCode = "0101****"', 'SituationCode = "********"'))).toEqual([]);
    });

    it('flags a character the expander has no case for', async () => {
        expect(await findings(partWith('SituationCode = "01x1****"'))).toEqual([
            "A situation code is written with '0', '1' and '*' only. The game throws on 'x' the first time this sprite is drawn.",
        ]);
    });

    it('flags a code the eight-neighbour slot cannot use', async () => {
        expect(await findings(partWith('SituationCode = "0101"'))).toEqual([
            'This code has 4 characters. A blend sprite here needs one per surrounding cell, so the game refuses to generate its sprites unless the code is 8 long.',
        ]);
    });

    it('says only one thing about a code that is both too short and misspelled', async () => {
        expect(await findings(partWith('SituationCode = "01x1"'))).toEqual([
            "A situation code is written with '0', '1' and '*' only. The game throws on 'x' the first time this sprite is drawn.",
        ]);
    });

    it('judges the characters of a code in a template group the schema cannot type', async () => {
        expect(await findings('HUB\n{\n\tSituationCode = "00q0"\n}\n')).toEqual([
            "A situation code is written with '0', '1' and '*' only. The game throws on 'q' the first time this sprite is drawn.",
        ]);
    });

    it('leaves the length of a code in an untyped template group alone', async () => {
        expect(await findings('HUB\n{\n\tSituationCode = "0000"\n}\n')).toEqual([]);
    });

    it('leaves a reference alone, since what it works out to is not in this text', async () => {
        expect(await findings(partWith('SituationCode = &~/CODE'))).toEqual([]);
    });
});
