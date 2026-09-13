import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { AbstractNodeDocument } from '../../../src/core/ast/ast';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { validateDivisionByZero } from '../../../src/features/diagnostics/validator.division-by-zero';
import { initWorkspace, workspaceFile } from '../../workspace-helper';

const PART_PATH = workspaceFile('parts', 'divzero_part.rules');
const token = CancellationToken.None;

const parse = (text: string): AbstractNodeDocument => parser(lexer(text), PART_PATH).value;

/**
 * A part file carrying the given field lines.
 *
 * @param lines the fields to write into the part.
 * @returns the part file text.
 */
const partWith = (...lines: string[]): string =>
    ['Part', '{', '\tID = test.divzero_part', ...lines.map((line) => `\t${line}`), '}', ''].join('\n');

const findings = async (...lines: string[]): Promise<string[]> =>
    (await validateDivisionByZero(parse(partWith(...lines)), token)).map((error) => error.message);

const severities = async (...lines: string[]): Promise<(string | undefined)[]> =>
    (await validateDivisionByZero(parse(partWith(...lines)), token)).map((error) => error.severity);

describe('division by zero', () => {
    beforeAll(async () => {
        await initWorkspace();
    });

    it('reports a whole-number field as a file the game refuses', async () => {
        expect(await findings('MaxHealth = 100 / 0')).toEqual([
            "This value divides by zero, which the game reads as NaN. 'MaxHealth' is a whole-number field, so the conversion throws and the game refuses to load the file.",
        ]);
        expect(await severities('MaxHealth = 100 / 0')).toEqual(['error']);
    });

    it('reports a fractional field as a stored NaN', async () => {
        expect(await findings('Density = 1 / 0')).toEqual([
            "This value divides by zero, so the game stores NaN in 'Density' instead of a number.",
        ]);
        expect(await severities('Density = 1 / 0')).toEqual(['warning']);
    });

    it('reads a zero divisor that the expression works out to', async () => {
        expect(await findings('Density = 1 / (2 - 2)')).toHaveLength(1);
        expect(await findings('Density = 1 / (3 - 2)')).toEqual([]);
    });

    it('reads an unspaced division, the shape a mod writes inside a vector', async () => {
        expect(await findings('Density = 1/0')).toHaveLength(1);
    });

    it('reads the modulo operator, which the game answers with NaN as well', async () => {
        expect(await findings('Density = 10 # 0')).toHaveLength(1);
    });

    it('says nothing about a division that works out', async () => {
        expect(await findings('MaxHealth = 100 / 4', 'Density = 0.5 / 2', 'ConstructionWork = 3 # 2')).toEqual([]);
    });

    it('says nothing about a percentage, whose `%` is a suffix rather than an operator', async () => {
        expect(await findings('Density = 50%')).toEqual([]);
    });

    it('says nothing about a value it cannot resolve', async () => {
        expect(await findings('Density = &~/Missing / &~/AlsoMissing')).toEqual([]);
    });

    it('says nothing about a field that reads text', async () => {
        expect(await findings('Name = 10/0')).toEqual([]);
    });
});
