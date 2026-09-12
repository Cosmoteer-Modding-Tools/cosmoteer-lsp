import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { evaluateNumericValue, formatNumber } from '../../src/semantics/value-evaluator';
import { AbstractNode, AbstractNodeDocument, isAssignmentNode } from '../../src/core/ast/ast';
import { parseFixture, valueOf, walkAst } from '../helpers';
import { initWorkspace } from '../workspace-helper';

const token = CancellationToken.None;

/**
 * The value of a named assignment anywhere in a document.
 *
 * @param doc the parsed document to search.
 * @param name the assignment's field name.
 * @returns the assignment's value node.
 */
const rhsOf = (doc: AbstractNodeDocument, name: string): AbstractNode => {
    for (const node of walkAst(doc)) if (isAssignmentNode(node) && node.left.name === name) return valueOf(node);
    throw new Error(`assignment ${name} not found`);
};

// Cosmoteer math is mXparser-compatible: trig in radians, `ln` natural, `log(a,b)` base a,
// `round(x,n)` to n decimals, and the `pi`/`e` constants. Every expectation here was taken from the
// game itself, by running the same text through HalflingCore's ExpressionEvaluator (a throwaway C#
// oracle referencing the game's Bin folder), which is why a call with a comma is written in quotes
// and why `pow` and `Sqrt` are expected to evaluate to nothing.
describe('mXparser-compatible functions and constants', () => {
    let doc: AbstractNodeDocument;
    beforeAll(async () => {
        await initWorkspace();
        doc = parseFixture('mxfuncs.rules', 'file:///mxfuncs.rules');
    });

    /**
     * Evaluate a named assignment of the fixture.
     *
     * @param name the assignment's field name.
     * @returns the assignment's numeric value, or null when it does not evaluate.
     */
    const eval_ = (name: string) => evaluateNumericValue(rhsOf(doc, name), token);

    it('evaluates trig (radians), exp, natural log and sign', async () => {
        expect(await eval_('Sine')).toBe(0); // sin(0)
        expect(await eval_('Cosine')).toBe(1); // cos(0)
        expect(await eval_('NatLog')).toBe(0); // ln(1)
        expect(await eval_('Exp0')).toBe(1); // exp(0)
        expect(await eval_('Sgn')).toBe(-1); // sgn(-5)
    });

    it('evaluates a quoted call, which is how a comma is written', async () => {
        expect(await eval_('LogBase')).toBe(3); // "log(2, 8)" = log2(8)
        expect(await eval_('RoundDec')).toBe(3.14); // "round(3.14159, 2)"
        expect(await eval_('MinOf')).toBe(1); // "min(3, 1, 2)"
    });

    it('rounds halves away from zero, like the decimal round the game uses', async () => {
        expect(await eval_('RoundHalf')).toBe(-3); // "round(-2.5, 0)", not -2
    });

    it('computes in decimal, so an expression the game cannot fit an int shows the drift', async () => {
        expect(await eval_('DecimalDrift')).toBe(9.99999999999999);
        expect(await eval_('FloorDrift')).toBe(9);
    });

    it('leaves names the game has no function for unevaluated', async () => {
        // mXparser has no `pow`, and it is case-sensitive, so both are load errors rather than math.
        expect(await eval_('NotAFunction')).toBeNull();
        expect(await eval_('WrongCase')).toBeNull();
    });

    it('resolves the pi and e constants', async () => {
        expect(formatNumber((await eval_('Circle'))!)).toBe('6.283185'); // pi * 2
        expect(await eval_('EulerLn')).toBe(1); // ln(e)
    });

    it('leaves domain/unknown functions unevaluated (no wrong number)', async () => {
        expect(await eval_('Unknown')).toBeNull(); // deg(90), not pure arithmetic
    });
});
