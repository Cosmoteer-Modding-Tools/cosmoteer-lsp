import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { AbstractNodeDocument } from '../../../src/core/ast/ast';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { validateIndicatorIndexes } from '../../../src/features/diagnostics/validator.indicator-index';
import { workspaceFile } from '../../workspace-helper';

const PART_PATH = workspaceFile('parts', 'indicator_part.rules');
const token = CancellationToken.None;

const parse = (text: string): AbstractNodeDocument => parser(lexer(text), PART_PATH).value;

const findings = async (text: string): Promise<string[]> =>
    (await validateIndicatorIndexes(parse(text), token)).map((error) => error.message);

/**
 * A part carrying one indicator sprite component, with the indicator bodies written in.
 *
 * @param indicators the indicator bodies, each the inside of one `{ }`.
 * @returns the part file text.
 */
const partWith = (...indicators: string[]): string =>
    [
        'Part',
        '{',
        '\tID = test.indicator_part',
        '\tComponents',
        '\t{',
        '\t\tIndicatorLamps',
        '\t\t{',
        '\t\t\tType = IndicatorSprites',
        '\t\t\tIndicators',
        '\t\t\t[',
        ...indicators.map((body) => `\t\t\t\t{ ${body} }`),
        '\t\t\t]',
        '\t\t}',
        '\t}',
        '}',
        '',
    ].join('\n');

// The engine bounds-checks its own loop counter rather than the written index, so one half of this
// is a named refusal and the other is an index error with no message at all. Both stop the load.
describe('indicator hide indexes', () => {
    it('says nothing about a list whose indices all name another indicator', async () => {
        expect(await findings(partWith('HidesIndicators = [1, 2]', 'Toggle = a', 'Toggle = b'))).toEqual([]);
    });

    it('says nothing about a list nobody hides anything in', async () => {
        expect(await findings(partWith('Toggle = a', 'Toggle = b'))).toEqual([]);
    });

    it('flags an indicator that names its own index', async () => {
        expect(await findings(partWith('Toggle = a', 'HidesIndicators = [1]'))).toEqual([
            'Indicator 1 cannot hide itself, so the game refuses to load this file.',
        ]);
    });

    it('flags an index the list does not have', async () => {
        expect(await findings(partWith('HidesIndicators = [3]', 'Toggle = b'))).toEqual([
            'There is no indicator 3 in this list of 2, so loading this file fails with an index error the game cannot name.',
        ]);
    });

    it('flags a negative index', async () => {
        expect(await findings(partWith('HidesIndicators = [-1]', 'Toggle = b'))).toEqual([
            'There is no indicator -1 in this list of 2, so loading this file fails with an index error the game cannot name.',
        ]);
    });

    it('reads a single index written without brackets', async () => {
        expect(await findings(partWith('HidesIndicators = 0', 'Toggle = b'))).toEqual([
            'Indicator 0 cannot hide itself, so the game refuses to load this file.',
        ]);
    });

    it('leaves a reference alone, since what it works out to is not in this text', async () => {
        expect(await findings(partWith('HidesIndicators = [&~/HIDDEN]', 'Toggle = b'))).toEqual([]);
    });

    it('says nothing about a list that declares a base, whose inherited entries shift every index', async () => {
        const text = partWith('HidesIndicators = [9]', 'Toggle = b').replace(
            'Indicators\n\t\t\t[',
            'Indicators : ^/0/Indicators\n\t\t\t['
        );
        expect(await findings(text)).toEqual([]);
    });
});
