import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { ValidationForMath } from '../../../src/features/diagnostics/validator.math';
import { AbstractNode, AstPosition, ExpressionNode, isMathExpressionNode, MathExpressionNode, ValueNode } from '../../../src/core/ast/ast';
import { walkAst } from '../../helpers';

const token = CancellationToken.None;
const pos = (): AstPosition => ({ line: 0, characterStart: 0, characterEnd: 0, start: 0, end: 0 });
const op = (t: ExpressionNode['expressionType']): ExpressionNode => ({ type: 'Expression', expressionType: t, position: pos() });
const num = (v: number): ValueNode => ({ type: 'Value', valueType: { type: 'Number', value: v }, position: pos() });
const ref = (v: string): ValueNode => ({ type: 'Value', valueType: { type: 'Reference', value: v }, position: pos() });
const str = (v: string): ValueNode => ({ type: 'Value', valueType: { type: 'String', value: v }, position: pos() });
const math = (...elements: AbstractNode[]): MathExpressionNode => ({ type: 'MathExpression', elements: elements as MathExpressionNode['elements'], position: pos() });

const run = (m: MathExpressionNode) => ValidationForMath.callback(m, token);

describe('math expression diagnostics', () => {
    it('flags two operators in a row', async () => {
        const error = await run(math(num(5), op('+'), op('*'), num(3)));
        expect(error?.message).toBe('Two operators in a row in a math expression');
        expect(error?.additionalInfo).toBe('There should be a value (number or reference) between two operators');
    });

    it('flags a math expression that ends with an operator', async () => {
        const error = await run(math(num(5), op('+')));
        expect(error?.message).toBe('A math expression cannot end with an operator');
        expect(error?.additionalInfo).toBe('Add a value (number or reference) after the trailing operator');
    });

    it('flags a non-number, non-reference operand with its concrete type', async () => {
        const error = await run(math(str('foo'), op('+'), num(3)));
        expect(error?.message).toBe('Invalid argument type, expected Number or Reference. Got String');
        expect(error?.additionalInfo).toBe('Math expressions can only contain numbers and references ("&"), not a String');
    });

    it('accepts a well-formed number/operator/reference expression', async () => {
        expect(await run(math(num(5), op('+'), ref('&A')))).toBeUndefined();
    });

    it('does not treat a trailing postfix factorial "!" as a dangling operator', async () => {
        expect(await run(math(num(5), op('!')))).toBeUndefined();
    });

    it('accepts a bare math constant (pi, e) as an operand', async () => {
        // mXparser constants lex as String but are valid numeric operands (`pi * (&R)^2`).
        expect(await run(math(str('pi'), op('*'), num(2)))).toBeUndefined();
        expect(await run(math(num(2), op('*'), str('E')))).toBeUndefined();
    });

    it('accepts a unit-suffixed number (%, d, r) as an operand', async () => {
        // `300% * (&R)`, `90d`, `1.5r`: the suffix keeps them String-typed but they are numbers.
        for (const unit of ['300%', '90d', '1.5r', '.5%']) {
            expect(await run(math(str(unit), op('*'), num(2)))).toBeUndefined();
        }
        // A genuine non-numeric String is still flagged.
        expect((await run(math(str('NotANumber'), op('*'), num(2))))?.message).toBe(
            'Invalid argument type, expected Number or Reference. Got String'
        );
    });
});

// The parser does not error on a malformed math expression; the math validator is what
// surfaces it. These prove the messages are reachable end-to-end from real source, not
// only from hand-built nodes.
describe('math diagnostics reachable from parsed source', () => {
    const validateSource = async (src: string): Promise<string[]> => {
        const doc = parser(lexer(src), 'file:///math.rules').value;
        const msgs: string[] = [];
        for (const node of walkAst(doc)) {
            if (isMathExpressionNode(node)) {
                const error = await ValidationForMath.callback(node, token);
                if (error) msgs.push(error.message);
            }
        }
        return msgs;
    };

    it('flags a trailing operator written in a real assignment', async () => {
        expect(await validateSource('X = 5 +\n')).toContain('A math expression cannot end with an operator');
    });

    it('flags a string operand written in a real assignment', async () => {
        expect(await validateSource('X = 5 + "foo"\n')).toContain('Invalid argument type, expected Number or Reference. Got String');
    });

    it('does not flag a percentage operand in a real assignment (cosmoteer uses % everywhere)', async () => {
        // Regression: `RECOIL = 300% * (&~/EMITTER/Recoil)` reported "Got String" for `300%`.
        expect(await validateSource('RECOIL = 300% * (&X)\n')).toEqual([]);
        expect(await validateSource('AreaExpand = pi * ((&R) + (&B))\n')).toEqual([]);
    });
});
