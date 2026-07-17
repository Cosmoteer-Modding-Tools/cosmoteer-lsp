import { describe, expect, it } from 'vitest';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import {
    AssignmentNode,
    ExpressionNode,
    isAssignmentNode,
    MathExpressionNode,
    ValueNode,
} from '../../../src/core/ast/ast';

/**
 * Regression: mXparser's boolean AND between parenthesized operands. Vanilla `statuses/fire.rules`
 * has `SCORCH_PER_TICK = (&SCORCH_PER_SECOND) & (&TickInterval)`. The lone `&` lexes as a value
 * token, so the math chain used to stop after the first operand and the `& (…)` tail leaked out of
 * the assignment as a bogus top-level function call named "&" (reported as `Unknown function "&"`).
 */
describe('parser: standalone & as boolean-AND operator', () => {
    /**
     * Parse a source string into its document node.
     *
     * @param src the .rules source to parse.
     * @returns the parsed document node.
     */
    const parse = (src: string) => parser(lexer(src), 'file:///x.rules').value;

    it('keeps `(&A) & (&B)` a single math-expression assignment', () => {
        const doc = parse('SCORCH_PER_TICK = (&SCORCH_PER_SECOND) & (&TickInterval)\nNext = 5\n');
        expect(doc.elements).toHaveLength(2);
        const [first, second] = doc.elements as AssignmentNode[];
        expect(isAssignmentNode(first)).toBe(true);
        const math = first.right as MathExpressionNode;
        expect(math.type).toBe('MathExpression');
        expect(math.elements.map((e) => e.type)).toEqual(['Value', 'Expression', 'Value']);
        expect((math.elements[1] as ExpressionNode).expressionType).toBe('&');
        expect((math.elements[2] as ValueNode).valueType).toEqual({ type: 'Reference', value: '&TickInterval' });
        expect(isAssignmentNode(second)).toBe(true);
        expect(second.left.name).toBe('Next');
    });

    it('keeps concatenating unquoted text around a plain `&`', () => {
        const doc = parse('Foo = Guns & Roses\n');
        const assignment = doc.elements[0] as AssignmentNode;
        expect((assignment.right as ValueNode).valueType).toEqual({ type: 'String', value: 'Guns & Roses' });
    });

    it('does not fold a `& (…)` on the next line into the previous value (newline ends the value)', () => {
        const doc = parse('Foo = (&A)\n& (&B)\n');
        const assignment = doc.elements[0] as AssignmentNode;
        expect(assignment.right?.type).toBe('Value');
    });
});
