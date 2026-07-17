import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { ValidationForMath } from '../../../src/features/diagnostics/validator.math';
import { valueOf } from '../../helpers';
import { evaluateNumericValue } from '../../../src/semantics/value-evaluator';
import { AbstractNode, isAssignmentNode, isMathExpressionNode, MathExpressionNode } from '../../../src/core/ast/ast';

// Regression guards from a false-positive scan over the Star Wars: A Cosmos Divided mod. A decimal
// numerator or divisor glued to `/` (`0.065/1.75*(&X)`, vanilla-style `AnimationInterval` values)
// used to stay one path-like String token because the lexer's number predicate accepted digits only.
// The `*` then opened a math expression whose first operand was that String, so the math validator
// flagged working game math with "expected Number or Reference. Got String". The predicate now
// accepts the decimal point, guarded by a seen-digit flag so `../Ref` and `./Data/…` paths never
// split at their slash.
const token = CancellationToken.None;

/**
 * Parse a source string.
 *
 * @param src the .rules source to parse.
 * @returns the parse result, carrying both the document and any parser errors.
 */
const parse = (src: string) => parser(lexer(src), 'file:///t.rules');

/**
 * The value of the top-level `A = …` assignment, which every source here declares.
 *
 * @param src the .rules source to parse.
 * @returns the assignment's value node.
 */
const rightOf = (src: string): AbstractNode => {
    const doc = parse(src).value;
    const assignment = doc.elements.find((e) => isAssignmentNode(e) && e.left.name === 'A');
    if (!assignment || !isAssignmentNode(assignment)) throw new Error(`no assignment parsed from: ${src}`);
    return valueOf(assignment);
};

/**
 * Run the math validator over a node, when it is math at all.
 *
 * @param node the value node to validate.
 * @returns the validation error, or undefined when the node is not math or the math is valid.
 */
const mathErrorOf = async (node: AbstractNode) =>
    isMathExpressionNode(node) ? await ValidationForMath.callback(node as MathExpressionNode, token) : undefined;

describe('decimal numerators and divisors split into math like integer ones', () => {
    it.each([
        ['A = 0.065/1.75*(&B)', 0.065 / 1.75],
        ['A = 0.065/2.5*(&B)', 0.065 / 2.5],
        ['A = 0.5/2*(&B)', 0.5 / 2],
        ['A = 1.5/2*(&B)', 1.5 / 2],
        ['A = 0.065/1*(&B)', 0.065],
        ['A = .5/2*(&B)', 0.25],
    ])('parses %s as math with no diagnostic', async (src, factor) => {
        const right = rightOf(`B = 4\n${src}`);
        expect(isMathExpressionNode(right)).toBe(true);
        expect(await mathErrorOf(right)).toBeUndefined();
        expect(await evaluateNumericValue(right, token)).toBeCloseTo(factor * 4, 10);
    });

    it('evaluates a bare decimal division with no trailing math', async () => {
        const right = rightOf('A = 0.065/1.75');
        expect(isMathExpressionNode(right)).toBe(true);
        expect(await evaluateNumericValue(right, token)).toBeCloseTo(0.065 / 1.75, 10);
    });

    it('keeps integer division working as before', async () => {
        for (const [src, expected] of [
            ['A = 2/27', 2 / 27],
            ['A = 1/1000', 0.001],
            ['A = 3000 / 1.0', 3000],
        ] as const) {
            const right = rightOf(src);
            expect(await evaluateNumericValue(right, token)).toBeCloseTo(expected, 10);
        }
    });
});

describe('dot-prefixed paths stay whole values (seen-digit guard)', () => {
    it('does not split an unquoted `./Data/…` asset path into math', async () => {
        // `File = ./Data/common_effects/particles/noise_gradient.png` is a game-root asset path. It
        // must stay one value, not become `.` ÷ `Data…` math flagged "Got String".
        const src = 'T\n{\n\tFile = ./Data/common_effects/particles/noise_gradient.png\n}';
        const result = parse(src);
        expect(result.parserErrors).toEqual([]);
        const group = result.value.elements[0];
        const file = (group as { elements?: AbstractNode[] }).elements?.find(
            (e) => isAssignmentNode(e) && e.left.name === 'File'
        );
        expect(file && isAssignmentNode(file) ? file.right?.type : undefined).toBe('Value');
    });

    it('does not split a `../` relative reference at its slash', () => {
        const result = parse('A = &<../../def/plume_def.rules>/color/_hotColor');
        expect(result.parserErrors).toEqual([]);
        const right = rightOf('A = &<../../def/plume_def.rules>/color/_hotColor');
        expect(right.type).toBe('Value');
    });

    it('keeps the postfix factorial split working after the predicate change', async () => {
        const right = rightOf('A = 5!');
        expect(isMathExpressionNode(right)).toBe(true);
        expect(await evaluateNumericValue(right, token)).toBe(120);
    });

    it('keeps time literals and exponent signs unsplit', () => {
        expect(rightOf('A = 30:00').type).toBe('Value');
        expect(rightOf('A = 3.4028235E+38').type).toBe('Value');
    });

    it('still flags a genuinely non-numeric operand in math', async () => {
        // In `Af = (&B) /255 normally set per effect.` the prose tail without `//` is a real mod bug
        // and must keep its diagnostic. The division leniency must not swallow it.
        const right = rightOf('B = 4\nA = (&B) /255 normally set per effect.');
        expect(isMathExpressionNode(right)).toBe(true);
        const error = await mathErrorOf(right);
        expect(error?.message).toBe('Invalid argument type, expected Number or Reference. Got String');
    });
});
