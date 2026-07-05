import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { evaluateNumericValue } from '../../../src/semantics/value-evaluator';
import { walkAst } from '../../helpers';
import { AbstractNode, FunctionCallNode, isAssignmentNode, isFunctionCallNode } from '../../../src/core/ast/ast';

const token = CancellationToken.None;

const rhsOfX = (src: string): AbstractNode => {
    const doc = parser(lexer(src), 'file:///nested.rules').value;
    for (const node of walkAst(doc)) if (isAssignmentNode(node) && node.left.name === 'X') return node.right;
    throw new Error('no X assignment in: ' + src);
};
const evalX = (src: string) => evaluateNumericValue(rhsOfX(src), token);
const parseErrorCount = (src: string) => parser(lexer(src), 'file:///nested.rules').parserErrors.length;

describe('nested function calls in argument position', () => {
    it('parses a nested call as a FunctionCall, not a bare value', () => {
        const outer = rhsOfX('A = 16\nX = floor(sqrt(&A) * 2)\n');
        expect(isFunctionCallNode(outer)).toBe(true);
        expect((outer as FunctionCallNode).name).toBe('floor');
        const inner = (outer as FunctionCallNode).arguments.find(isFunctionCallNode);
        expect(inner?.name).toBe('sqrt');
    });

    it('does not produce a parse error for a nested call', () => {
        expect(parseErrorCount('A = 16\nX = floor(sqrt(&A) * 2)\n')).toBe(0);
    });

    it('evaluates a nested call multiplied by a scalar', async () => {
        expect(await evalX('A = 9\nX = floor(sqrt(&A) * 2)\n')).toBe(6); // floor(3 * 2)
    });

    it('evaluates a binary operator after a nested call (regression: was read as a sign)', async () => {
        expect(await evalX('A = 16\nX = floor(sqrt(&A) - 2)\n')).toBe(2); // floor(4 - 2)
    });

    it('still treats a real unary minus after an operator correctly', async () => {
        expect(await evalX('A = 9\nX = floor(sqrt(&A) * -2)\n')).toBe(-6); // floor(3 * -2)
    });

    it('evaluates a nested call added to a parenthesized reference', async () => {
        expect(await evalX('A = 9\nB = 5\nX = ceil(sqrt(&A) + (&B))\n')).toBe(8); // ceil(3 + 5)
    });

    it('evaluates deeply nested calls', async () => {
        expect(await evalX('A = 256\nX = sqrt(sqrt(sqrt(&A)))\n')).toBe(2); // 256→16→4→2
    });

    it('evaluates a nested call inside a multi-argument call', async () => {
        expect(await evalX('A = 0\nB = 0\nX = max(sin(&A), cos(&B) * 3)\n')).toBe(3); // max(0, 1*3)
    });

    it('does not regress the existing extra-parenthesized form', async () => {
        expect(await evalX('A = 4\nB = 2\nX = ceil(((&A) * 4 + (&B)) / 3)\n')).toBe(6); // ceil(18/3)
    });
});
