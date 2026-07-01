import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { evaluateNumericValue, formatNumber } from '../../src/semantics/value-evaluator';
import { AbstractNodeDocument, isAssignmentNode } from '../../src/core/ast/ast';
import { parseFixture, walkAst } from '../helpers';
import { initWorkspace } from '../workspace-helper';

const token = CancellationToken.None;

const rhsOf = (doc: AbstractNodeDocument, name: string) => {
    for (const node of walkAst(doc)) if (isAssignmentNode(node) && node.left.name === name) return node.right;
    throw new Error(`assignment ${name} not found`);
};

// Cosmoteer math is mXparser-compatible: trig in radians, `ln` natural, `log(a,b)` base a,
// `round(x,n)` to n decimals, variadic aggregates, and the `pi`/`e` constants.
describe('mXparser-compatible functions and constants', () => {
    let doc: AbstractNodeDocument;
    beforeAll(async () => {
        await initWorkspace();
        doc = parseFixture('mxfuncs.rules', 'file:///mxfuncs.rules');
    });

    const eval_ = (name: string) => evaluateNumericValue(rhsOf(doc, name), token);

    it('evaluates trig (radians), exp and natural log', async () => {
        expect(await eval_('Sine')).toBe(0); // sin(0)
        expect(await eval_('Cosine')).toBe(1); // cos(0)
        expect(await eval_('NatLog')).toBe(0); // ln(1)
        expect(await eval_('Exp0')).toBe(1); // exp(0)
        expect(await eval_('Atan2')).toBe(0); // atan2(0,1)
    });

    it('evaluates binary functions: pow, log(base, x), round(x, n)', async () => {
        expect(await eval_('Pow')).toBe(1024); // pow(2,10)
        expect(await eval_('LogBase')).toBe(3); // log(2,8) = log2(8)
        expect(await eval_('RoundDec')).toBe(3.14); // round(3.14159, 2)
    });

    it('evaluates variadic aggregates: sum, avg', async () => {
        expect(await eval_('Sum')).toBe(10); // sum(1,2,3,4)
        expect(await eval_('Avg')).toBe(4); // avg(2,4,6)
    });

    it('resolves the pi and e constants', async () => {
        expect(formatNumber((await eval_('Circle'))!)).toBe('6.283185'); // pi * 2
        expect(await eval_('EulerLn')).toBe(1); // ln(e)
    });

    it('leaves domain/unknown functions unevaluated (no wrong number)', async () => {
        expect(await eval_('Unknown')).toBeNull(); // deg(90) — not pure arithmetic
    });
});
