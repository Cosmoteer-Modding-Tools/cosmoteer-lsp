import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../src/core/lexer/lexer';
import { parser } from '../../src/core/parser/parser';
import { AbstractNode, AbstractNodeDocument, isAssignmentNode } from '../../src/core/ast/ast';
import { evaluateNumericValue } from '../../src/semantics/value-evaluator';
import { valueOf, walkAst } from '../helpers';
import { initWorkspace } from '../workspace-helper';

// Whitespace around an operator is what makes the lexer split a value into operand and operator
// nodes. Without it the whole run arrives as one unquoted token, which the game evaluates all the
// same, so the evaluator has to fold that text itself. Mods write offsets this way constantly
// (`Location = [10-3.4, 16]`), and reading them as plain strings put every such sprite at [0, 0].
const token = CancellationToken.None;

const rhsOf = (doc: AbstractNodeDocument, name: string): AbstractNode => {
    for (const node of walkAst(doc)) if (isAssignmentNode(node) && node.left.name === name) return valueOf(node);
    throw new Error(`assignment ${name} not found`);
};

const evaluated = async (source: string): Promise<number | null> =>
    evaluateNumericValue(rhsOf(parser(lexer(`X = ${source}\n`), 'file:///unspaced.rules').value, 'X'), token);

describe('unspaced arithmetic in a single value token', () => {
    beforeAll(async () => {
        await initWorkspace();
    });

    it('folds the operators a spaced expression would have been split on', async () => {
        expect(await evaluated('10-3.4')).toBeCloseTo(6.6, 10);
        expect(await evaluated('26-10')).toBe(16);
        expect(await evaluated('2*3+4')).toBe(10);
        expect(await evaluated('2+3*4')).toBe(14);
        expect(await evaluated('7/2')).toBe(3.5);
        expect(await evaluated('2^3^2')).toBe(512); // right-associative, as mXparser folds it
    });

    it('converts the unit suffixes inside the run', async () => {
        expect(await evaluated('50%*4')).toBe(2);
    });

    it('reads a sign that belongs to the operand it precedes', async () => {
        expect(await evaluated('10*-2')).toBe(-20);
    });

    it('leaves everything that is not a numeric run alone', async () => {
        expect(await evaluated('"10-3.4"')).toBeNull(); // quoted, a real string
        expect(await evaluated('some-name')).toBeNull();
        expect(await evaluated('10-')).toBeNull();
        expect(await evaluated('1.2.3')).toBeNull();
    });
});
