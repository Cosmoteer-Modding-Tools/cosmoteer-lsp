import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { validateUnderlyingParts } from '../../../src/features/diagnostics/validator.underlying-part';
import { workspaceFile } from '../../workspace-helper';

const PART_PATH = workspaceFile('parts', 'underlying_part.rules');
const token = CancellationToken.None;

const findings = async (text: string): Promise<string[]> =>
    (await validateUnderlyingParts(parser(lexer(text), PART_PATH).value, token)).map((error) => error.message);

/**
 * A part with the given members written on it.
 *
 * @param members the members, one per line.
 * @returns the part file text.
 */
const partWith = (...members: string[]): string =>
    ['Part', '{', '\tID = test.armor', ...members.map((line) => '\t' + line), '}', ''].join('\n');

// Working out what a part costs beyond its replacement, and what it drops, both walk this chain
// with no visited set, so a part naming itself never comes back.
describe('parts that leave themselves behind', () => {
    it('says nothing about a part leaving another part behind', async () => {
        expect(await findings(partWith('UnderlyingPart = test.structure'))).toEqual([]);
    });

    it('says nothing about a part leaving nothing behind', async () => {
        expect(await findings(partWith('UnderlyingPart = ""'))).toEqual([]);
    });

    it('flags a part naming itself', async () => {
        expect(await findings(partWith('UnderlyingPart = test.armor'))).toEqual([
            "'test.armor' names itself as its own UnderlyingPart, so working out what it costs or drops asks the same question forever and the game stops.",
        ]);
    });

    it('flags the per-tile spelling too', async () => {
        expect(await findings(partWith('UnderlyingPartPerTile = test.armor'))).toEqual([
            "'test.armor' names itself as its own UnderlyingPartPerTile, so working out what it costs or drops asks the same question forever and the game stops.",
        ]);
    });

    it('reads the older name the game also accepts', async () => {
        expect(await findings(partWith('CreatePartWhenDestroyed = test.armor'))).toEqual([
            "'test.armor' names itself as its own UnderlyingPart, so working out what it costs or drops asks the same question forever and the game stops.",
        ]);
    });

    it('matches the id the case-insensitive way the game matches it', async () => {
        expect(await findings(partWith('UnderlyingPart = TEST.ARMOR'))).toHaveLength(1);
    });

    it('leaves a reference alone, since what it names is not in this text', async () => {
        expect(await findings(partWith('UnderlyingPart = &~/UNDER'))).toEqual([]);
    });

    it('says nothing about a template that declares no id of its own', async () => {
        const template = ['Part', '{', '\tUnderlyingPart = test.armor', '}', ''].join('\n');
        expect(await findings(template)).toEqual([]);
    });
});
