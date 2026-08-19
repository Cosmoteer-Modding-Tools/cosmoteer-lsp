/**
 * Full mXparser 4.4.2 operator support: every expected value below was produced by running the
 * expression through the game's shipped MathParser.org-mXparser.dll (Expression.calculate()), so
 * these tests pin our evaluator to the real engine behavior. `null` means the game result is not
 * a real number (Infinity/NaN), where we deliberately show nothing.
 *
 * Kept in its own module (not a `.test.ts`, so Vitest does not collect it) because two suites read
 * it: the operator suite that pins the numbers, and the trace suite that pins the traced entry
 * point against the untraced one over the same expressions.
 */
export const ORACLE: Array<[string, number | null]> = [
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

/** One oracle row: the expression source and the number the game's own parser answers with. */
export type MxOracleCase = (typeof ORACLE)[number];
