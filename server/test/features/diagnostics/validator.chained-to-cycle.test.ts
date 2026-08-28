import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { AbstractNodeDocument } from '../../../src/core/ast/ast';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { validateChainedToCycles } from '../../../src/features/diagnostics/validator.chained-to-cycle';
import { workspaceFile } from '../../workspace-helper';

const PART_PATH = workspaceFile('parts', 'chained_part.rules');
const token = CancellationToken.None;

const parse = (text: string): AbstractNodeDocument => parser(lexer(text), PART_PATH).value;

const findings = async (text: string): Promise<string[]> =>
    (await validateChainedToCycles(parse(text), token)).map((error) => error.message);

/**
 * A part carrying the given components, each written as a name and a body.
 *
 * @param components the component declarations, each `name` and the inside of its `{ }`.
 * @returns the part file text.
 */
const partWith = (...components: [string, string][]): string =>
    [
        'Part',
        '{',
        '\tID = test.chained_part',
        '\tComponents',
        '\t{',
        ...components.flatMap(([name, body]) => [`\t\t${name}`, '\t\t{', `\t\t\t${body}`, '\t\t}']),
        '\t}',
        '}',
        '',
    ].join('\n');

const CYCLE = 'This chain leads back to itself, so the game stops the moment a part with these components is created.';

// Nothing guards the chain at either end, and a stack overflow cannot be caught in the runtime the
// game is built on, so a closed chain is the quietest possible crash.
describe('component chains that close', () => {
    it('says nothing about a chain that ends', async () => {
        expect(
            await findings(
                partWith(
                    ['Hub', 'Type = Sprite'],
                    ['Barrel', 'Type = Sprite\n\t\t\tChainedTo = Hub'],
                    ['Tip', 'Type = Sprite\n\t\t\tChainedTo = Barrel']
                )
            )
        ).toEqual([]);
    });

    it('says nothing about several components chained to one hub', async () => {
        expect(
            await findings(
                partWith(
                    ['Hub', 'Type = Sprite'],
                    ['Left', 'Type = Sprite\n\t\t\tChainedTo = Hub'],
                    ['Right', 'Type = Sprite\n\t\t\tChainedTo = Hub']
                )
            )
        ).toEqual([]);
    });

    it('flags a component chained to itself', async () => {
        expect(await findings(partWith(['Barrel', 'Type = Sprite\n\t\t\tChainedTo = Barrel']))).toEqual([CYCLE]);
    });

    it('flags a pair chained to each other', async () => {
        expect(
            await findings(
                partWith(['Left', 'Type = Sprite\n\t\t\tChainedTo = Right'], ['Right', 'Type = Sprite\n\t\t\tChainedTo = Left'])
            )
        ).toEqual([CYCLE]);
    });

    it('says it once for a loop of three rather than once per component', async () => {
        expect(
            await findings(
                partWith(
                    ['A', 'Type = Sprite\n\t\t\tChainedTo = B'],
                    ['B', 'Type = Sprite\n\t\t\tChainedTo = C'],
                    ['C', 'Type = Sprite\n\t\t\tChainedTo = A']
                )
            )
        ).toEqual([CYCLE]);
    });

    it('matches the component name the case-insensitive way the game matches it', async () => {
        expect(await findings(partWith(['Barrel', 'Type = Sprite\n\t\t\tChainedTo = barrel']))).toEqual([CYCLE]);
    });

    it('leaves a chain naming a component the part does not hold alone', async () => {
        expect(await findings(partWith(['Barrel', 'Type = Sprite\n\t\t\tChainedTo = Missing']))).toEqual([]);
    });

    it('leaves a chain written as a reference alone', async () => {
        expect(await findings(partWith(['Barrel', 'Type = Sprite\n\t\t\tChainedTo = &~/HUB']))).toEqual([]);
    });
});
