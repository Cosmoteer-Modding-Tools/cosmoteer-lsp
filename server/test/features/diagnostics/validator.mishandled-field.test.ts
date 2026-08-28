import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { validateMishandledFields } from '../../../src/features/diagnostics/validator.mishandled-field';
import { workspaceFile } from '../../workspace-helper';

const PART_PATH = workspaceFile('parts', 'mishandled_part.rules');
const token = CancellationToken.None;

const findings = async (text: string): Promise<string[]> =>
    (await validateMishandledFields(parser(lexer(text), PART_PATH).value, token)).map((error) => error.message);

const fixes = async (text: string): Promise<(string | undefined)[]> =>
    (await validateMishandledFields(parser(lexer(text), PART_PATH).value, token)).map(
        (error) => error.data?.quickFix?.newText
    );

/**
 * A part carrying one component of the given kind.
 *
 * @param type the component's `Type` discriminator.
 * @param body the component's members, one per line.
 * @returns the part file text.
 */
const partWith = (type: string, body: string[]): string =>
    ['Part', '{', '\tID = test.mishandled', '\tComponents', '\t{', '\t\tX', '\t\t{', `\t\t\tType = ${type}`, ...body.map((line) => '\t\t\t' + line), '\t\t}', '\t}', '}', ''].join('\n');

// Each of these loads without a word and leaves the game doing something other than what the file
// says, which is the one thing neither the schema nor the dead-field check can see.
describe('fields the game reads and then gets wrong', () => {
    it('flags an ExcludeID, which the engine adds to the list it matches', async () => {
        const text = partWith('AreaBuffProvider', ['Criteria', '{', '\tExcludeID = cosmoteer.armor', '}']);
        expect(await findings(text)).toEqual([
            "The game adds 'ExcludeID' to the list of parts this matches instead of the list it excludes, so this part becomes the only one accepted. Write it as 'ExcludeIDs' to exclude it.",
        ]);
    });

    it('offers the list form as the fix, since the game reads a list from nothing else', async () => {
        const text = partWith('AreaBuffProvider', ['Criteria', '{', '\tExcludeID = cosmoteer.armor', '}']);
        expect(await fixes(text)).toEqual(['ExcludeIDs = [cosmoteer.armor]']);
    });

    it('leaves the plural alone, which the engine reads correctly', async () => {
        const text = partWith('AreaBuffProvider', ['Criteria', '{', '\tExcludeIDs = [cosmoteer.armor]', '}']);
        expect(await findings(text)).toEqual([]);
    });

    it('leaves ExcludeCategory alone, which folds into the right list', async () => {
        const text = partWith('AreaBuffProvider', ['Criteria', '{', '\tExcludeCategory = armor', '}']);
        expect(await findings(text)).toEqual([]);
    });

    it('flags a flag the toggled blend sprite generator never reads', async () => {
        const text = partWith('ToggledBlendSprites', ['AllowUndefinedBlendSprites = true']);
        expect(await findings(text)).toEqual([
            'The toggled blend sprites are generated without reading this flag, so the game still throws on a combination of toggle states no sprite covers.',
        ]);
    });

    it('leaves the same flag alone on the plain blend sprite, which honours it', async () => {
        expect(await findings(partWith('BlendSprite', ['AllowUndefinedBlendSprites = true']))).toEqual([]);
    });

    it('leaves it alone on the grid variant too, which takes it from the same base', async () => {
        expect(await findings(partWith('BlendSpriteGrid', ['AllowUndefinedBlendSprites = true']))).toEqual([]);
    });
});
