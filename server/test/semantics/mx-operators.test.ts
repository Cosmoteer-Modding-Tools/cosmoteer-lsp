import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../src/core/lexer/lexer';
import { parser } from '../../src/core/parser/parser';
import { AssignmentNode, isAssignmentNode } from '../../src/core/ast/ast';
import { evaluateNumericValue } from '../../src/semantics/value-evaluator';
import { valueOf } from '../helpers';

const token = CancellationToken.None;

/**
 * Full mXparser 4.4.2 operator support: every expected value below was produced by running the
 * expression through the game's shipped MathParser.org-mXparser.dll (Expression.calculate()), so
 * these tests pin our evaluator to the real engine behavior. `null` means the game result is not
 * a real number (Infinity/NaN), where we deliberately show nothing.
 */
const ORACLE: Array<[string, number | null]> = [
    // tetration and power, both right-associative. Factorial folds after power (2^3! = (2^3)!)
    ['2 ^^ 3', 16],
    ['2 ^^ 3 ^^ 2', null], // 2^^(3^3) overflows to Infinity in the game
    ['2 ^ 3 !', 40320],
    // modulo folds before multiplication: 2 * (3 # 4) = 6
    ['7 # 3', 1],
    ['-7 # 3', -1],
    ['7.5 # 2', 1.5],
    ['2 * 3 # 4', 6],
    // binary relations (epsilon-based, 1/0 results). Equality folds before < > <= >=
    ['(5) < (3)', 0],
    ['(3) < (5)', 1],
    ['(1) <> (2)', 1],
    ['(2) <> (2)', 0],
    ['(5) = (5.000000000000001)', 1],
    ['(5) == (5)', 1],
    ['(2) <= (2)', 1],
    ['(2) >= (3)', 0],
    ['(-4) == (-5)', 0],
    ['(2) < (3) == (1)', 0], // == first: 2 < (3 == 1) = 2 < 0
    ['(2) = (2) = (1)', 1],
    ['1 + 2 == 3', 1],
    // boolean families: truthiness is |x| > 1e-14
    ['(2) & (0.5)', 1],
    ['(2) && (0)', 0],
    ['(2) ~& (3)', 0],
    ['(0) | (3)', 1],
    ['(0) || (0)', 0],
    ['(1) ~| (0)', 0],
    ['(1) (+) (1)', 0],
    ['(1) (+) (0)', 1],
    ['(1) --> (0)', 0],
    ['(0) --> (1)', 1],
    ['(1) <-- (0)', 1],
    ['(1) -/> (0)', 1],
    ['(0) </- (1)', 1],
    ['(1) <-> (1)', 1],
    ['(1) <-> (0)', 0],
    ['(1e-15) & (1)', 0],
    // bitwise operators, loosest binding. Shift counts wrap at 64 like C# long shifts
    ['(12) @& (10)', 8],
    ['(12) @| (10)', 14],
    ['(12) @^ (10)', 6],
    ['(1) @<< (3)', 8],
    ['(-8) @>> (1)', -4],
    ['(1) @<< (65)', 2],
    // almost-integer rounding at the end of every calculate()
    ['0.1 * 30', 3],
];

/**
 * The value of `X = <source>`, the assignment each oracle expression is parsed as.
 *
 * @param source the expression to parse as X's value.
 * @returns the assignment's value node.
 */
const rhsOf = (source: string) => {
    const doc = parser(lexer(`X = ${source}\n`), 'file:///mx.rules').value;
    const assignment = doc.elements.find((node) => isAssignmentNode(node)) as AssignmentNode;
    expect(assignment, `no assignment parsed from: ${source}`).toBeDefined();
    return valueOf(assignment);
};

describe('mXparser 4.4.2 operators (oracle-verified against the shipped DLL)', () => {
    for (const [source, expected] of ORACLE) {
        it(`${source} = ${expected}`, async () => {
            const right = rhsOf(source);
            expect(right.type, `${source} did not parse as math`).toBe('MathExpression');
            expect(await evaluateNumericValue(right, token)).toBe(expected);
        });
    }

    it('leaves flat text with operator characters as a plain string value', () => {
        // `a --> b` is absent: a `-` after a bare word already opened a math chain before this
        // change (pre-existing behavior), and its string operand evaluates to null anyway.
        for (const text of ['Guns & Roses', 'A | B', '5 < 3']) {
            const right = rhsOf(text);
            expect(right.type, `"${text}" must stay text`).toBe('Value');
        }
    });
});
