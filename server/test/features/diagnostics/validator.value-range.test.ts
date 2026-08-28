import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { validateValueRanges } from '../../../src/features/diagnostics/validator.value-range';
import { workspaceFile } from '../../workspace-helper';

const PART_PATH = workspaceFile('parts', 'range_part.rules');
const token = CancellationToken.None;

const findings = async (text: string): Promise<string[]> =>
    (await validateValueRanges(parser(lexer(text), PART_PATH).value, token)).map((error) => error.message);

/**
 * A part carrying one component of the given kind.
 *
 * @param type the component's `Type` discriminator.
 * @param body the component's members, one per line.
 * @returns the part file text.
 */
const partWith = (type: string, body: string[]): string =>
    ['Part', '{', '\tID = test.range', '\tComponents', '\t{', '\t\tX', '\t\t{', `\t\t\tType = ${type}`, ...body.map((line) => '\t\t\t' + line), '\t\t}', '\t}', '}', ''].join('\n');

// Range ordering is not judged in general: most ranges are interpolation bounds and count down on
// purpose. These are the ones whose consumer rolls or compares instead.
describe('ranges the consumer reads in a direction', () => {
    it('says nothing about a range written low to high', async () => {
        expect(await findings(partWith('BulletEmitter', ['Pellets = [1, 4]']))).toEqual([]);
    });

    it('flags a rolled range written high to low', async () => {
        expect(await findings(partWith('BulletEmitter', ['Pellets = [4, 1]']))).toEqual([
            'The game rolls a whole number between these, and refuses a high end below the low one, so it throws here with 4 above 1.',
        ]);
    });

    it('reads the group spelling of a range too', async () => {
        expect(await findings(partWith('BulletEmitter', ['Pellets', '{', '\tMin = 4', '\tMax = 1', '}']))).toEqual([
            'The game rolls a whole number between these, and refuses a high end below the low one, so it throws here with 4 above 1.',
        ]);
    });

    it('says nothing about a range whose ends are equal', async () => {
        expect(await findings(partWith('BulletEmitter', ['Pellets = [2, 2]']))).toEqual([]);
    });

    it('leaves a modifiable endpoint alone, which a buff can move', async () => {
        const text = partWith('BulletEmitter', ['Pellets', '[', '\t{ BaseValue = 4 }', '\t{ BaseValue = 1 }', ']']);
        expect(await findings(text)).toEqual([]);
    });

    it('leaves a range declaring a base alone, whose entries come first', async () => {
        expect(await findings(partWith('BulletEmitter', ['Pellets : ^/0/Pellets [4, 1]']))).toEqual([]);
    });

    it('warns rather than errors where the range is compared instead of rolled', async () => {
        const text = partWith('ModeCycle', ['ModeRange = [3, 1]']);
        expect(await findings(text)).toEqual([
            'This window is empty with 3 above 1, so nothing ever falls inside it and the feature never comes on.',
        ]);
    });

    it('leaves the same field name on a class with no such limit alone', async () => {
        expect(await findings(partWith('BulletEmitter', ['Burst = [4, 1]']))).toEqual([]);
    });
});
