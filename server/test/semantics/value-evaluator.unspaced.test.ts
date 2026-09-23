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

    it('reads the sign of the first operand too, which is how a negative offset is written', async () => {
        // `Location = [-0.14+0.03, -0.38-0.015]` in vanilla's cannon turret sprites.
        expect(await evaluated('-0.38-0.015')).toBeCloseTo(-0.395, 10);
        expect(await evaluated('-0.14+0.03')).toBeCloseTo(-0.11, 10);
        expect(await evaluated('-5*2')).toBe(-10);
    });

    it('reads a decimal written without its leading zero, which is not a relative path', async () => {
        // `Location = [.5-8/64, 0.5+2/64]` in vanilla's factory resource sprites.
        expect(await evaluated('.5-8/64')).toBeCloseTo(0.375, 10);
        expect(await evaluated('.5+6/64')).toBeCloseTo(0.59375, 10);
    });

    it('leaves a relative path a path, and a lone signed number the literal it already was', async () => {
        // The negative control for the two above: `.` still opens a path when no digit follows it,
        // and a single signed term stays the plain literal it is read as, not a folded expression.
        expect(await evaluated('../factory_he/factory_he.rules')).toBeNull();
        expect(await evaluated('./Data/ships/terran')).toBeNull();
        expect(await evaluated('-0.38')).toBe(-0.38);
    });

    it('leaves everything that is not a numeric run alone', async () => {
        expect(await evaluated('"10-3.4"')).toBeNull(); // quoted, a real string
        expect(await evaluated('some-name')).toBeNull();
        expect(await evaluated('10-')).toBeNull();
        expect(await evaluated('1.2.3')).toBeNull();
    });
});
