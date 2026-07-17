import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer, TOKEN_TYPES } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { evaluateNumericValue } from '../../../src/semantics/value-evaluator';
import { AbstractNode, AbstractNodeDocument, isListNode, isAssignmentNode, isGroupNode } from '../../../src/core/ast/ast';
import { parseFixture, readFixture, valueOf, walkAst } from '../../helpers';
import { initWorkspace } from '../../workspace-helper';

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

// mXparser `^` power, `%` percentage and `!` factorial, with the disambiguations the user flagged:
// `^` must not break `^/…` super-path inheritance, and `%` is percentage (÷100), not modulo.
describe('mXparser operators: ^ (power), % (percentage), ! (factorial)', () => {
    let doc: AbstractNodeDocument;
    beforeAll(async () => {
        await initWorkspace();
        doc = parseFixture('operators.rules', 'file:///operators.rules');
    });

    /**
     * Evaluate a named assignment of the fixture.
     *
     * @param name the assignment's field name.
     * @returns the assignment's numeric value, or null when it does not evaluate.
     */
    const eval_ = (name: string) => evaluateNumericValue(rhsOf(doc, name), token);

    it('evaluates power with correct precedence and right-associativity', async () => {
        expect(await eval_('Pow')).toBe(256); // 2 ^ 8
        expect(await eval_('PowPrec')).toBe(12); // 3 * 2^2, power binds tighter than *
        expect(await eval_('RightAssoc')).toBe(512); // 2 ^ 3 ^ 2 = 2 ^ 9
        expect(await eval_('AddPow')).toBe(9); // 1 + 2^3
    });

    it('evaluates percentage as ÷100, including inside an expression', async () => {
        expect(await eval_('Half')).toBe(0.5); // 50%
        expect(await eval_('Quarter')).toBe(0.25); // 25 %
        expect(await eval_('PctExpr')).toBe(100); // (&Base=200) * 50%
    });

    it('evaluates postfix factorial with the right precedence', async () => {
        expect(await eval_('Fact')).toBe(120); // 5!
        expect(await eval_('FactSub')).toBe(117); // 5! - 3, the `-` after `!` is binary, not a sign
        // Verified against the shipped mXparser DLL: calculate() folds the power level before the
        // factorial, so `2 ^ 3!` is `(2 ^ 3)!` = 40320, not `2 ^ (3!)` = 64.
        expect(await eval_('PowFact')).toBe(40320);
        expect(await eval_('ParenFact')).toBe(120); // (2 + 3)! = 5!
        expect(await eval_('FactInFunc')).toBe(4); // ceil(4! / 7) = ceil(24/7)
        expect(await eval_('BadFact')).toBeNull(); // 3.5!, factorial only on non-negative integers
    });

    it('keeps unary-minus working alongside the new operators', async () => {
        expect(await eval_('Neg')).toBe(-21); // 3 * -7
    });

    it('does not break `^/…` super-path inheritance', () => {
        const result = parser(lexer(readFixture('operators.rules')), 'file:///operators.rules');
        expect(result.parserErrors).toEqual([]);

        // The super-path stays one VALUE token. The power lexer must not split `^/0/Val`.
        const tokens = lexer('Child : ^/0/Val');
        const superPath = tokens.find((t) => t.value === '^/0/Val');
        expect(superPath?.type).toBe(TOKEN_TYPES.VALUE);

        // And it is captured as the child's inheritance reference.
        let captured: string | undefined;
        for (const node of walkAst(doc)) {
            if ((isGroupNode(node) || isListNode(node)) && node.inheritance?.length) {
                captured = node.inheritance[0].valueType.value as string;
            }
        }
        expect(captured).toBe('^/0/Val');
    });
});
