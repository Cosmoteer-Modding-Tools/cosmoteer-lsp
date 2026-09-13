import { describe, expect, it } from 'vitest';
import {
    decimalDiv,
    decimalMinus,
    decimalMultiply,
    decimalPlus,
    decimalRound,
} from '../../src/semantics/decimal-arithmetic';

// Expected values come from the game itself: each row was produced by handing the expression to
// `Halfling.Serialization.ObjectText.ExpressionEvaluator.Evaluate<double>` in HalflingCore.dll with
// the shipped mXparser 4.4.2 beside it. The oracle was a throwaway C# console app referencing the
// game's Bin folder, rebuild one like it to regenerate this table after a Cosmoteer update.
const ORACLE: [string, number][] = [
    ['10 / 3 * 3', 9.99999999999999],
    ['0.1 + 0.2', 0.3],
    ['0.3 / 0.1', 3],
    ['1 / 3', 0.3333333333333333],
    ['2 / 3 * 3', 2],
    ['100 / 7 * 7', 100.0000000000001],
    ['0.1 * 3', 0.3],
    ['4.35 * 100', 435],
    ['1.1 * 1.1', 1.21],
    ['0.07 * 100', 7],
    ['1e-7 / 3', 3.3333333333333334e-8],
    ['123456789 * 987654321', 1.2193263111263526e17],
    ['0.1 + 0.7', 0.8],
    ['2.675 * 100', 267.5],
    ['1 / 7', 0.14285714285714285],
    ['22 / 7', 3.142857142857143],
    ['355 / 113', 3.1415929203539825],
    ['1.005 * 1000', 1005],
    ['9.95 * 10', 99.5],
    ['0.615 * 100', 61.5],
    ['5 / 2', 2.5],
    ['7 / 2', 3.5],
    ['1 / 8', 0.125],
    ['3 / 8', 0.375],
    ['10 / 4', 2.5],
    ['1000000 / 3', 333333.3333333333],
    ['0.0001 / 3', 3.3333333333333335e-5],
    ['123.456 * 789.012', 97408.265472],
    ['1 - 0.9', 0.1],
    ['1.0000001 - 1', 1e-7],
    ['0.000001 * 0.000001', 1e-12],
    ['1 / 3 + 1 / 3 + 1 / 3', 1],
    ['2 / 3 + 1 / 3', 1],
    ['1 / 6 * 6', 1],
    ['1 / 9 * 9', 1],
    ['1 / 11 * 11', 1],
    ['500000000000 * 2', 1000000000000],
    ['0.5 / 0.25', 2],
    ['99999999999 / 7', 14285714285.571428],
    ['3.14159265358979 * 2', 6.28318530717958],
];

// mXparser's almost-integer rounding, applied once to the finished expression.
const snap = (value: number): number => {
    const rounded = Math.round(value);
    return Math.abs(value - rounded) <= 1e-14 ? rounded : value;
};

/**
 * Evaluate a flat arithmetic expression with the decimal operators, so a whole oracle row can be
 * compared rather than a single operation.
 *
 * @param text the expression, made of numbers and the four arithmetic operators.
 * @returns the value the game's evaluator produces for it.
 */
const evaluate = (text: string): number => {
    const tokens = text.match(/\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[+\-*/]/g) ?? [];
    const items: (number | string)[] = tokens.map((token) => (/^[+\-*/]$/.test(token) ? token : Number(token)));
    const fold = (operators: string[], apply: (op: string, a: number, b: number) => number): void => {
        for (;;) {
            const at = items.findIndex(
                (item, index) => typeof item === 'string' && operators.includes(item) && index > 0
            );
            if (at < 0) return;
            const folded = apply(items[at] as string, items[at - 1] as number, items[at + 1] as number);
            items.splice(at - 1, 3, folded);
        }
    };
    fold(['*', '/'], (op, a, b) => (op === '*' ? decimalMultiply(a, b) : decimalDiv(a, b)));
    fold(['+', '-'], (op, a, b) => (op === '+' ? decimalPlus(a, b) : decimalMinus(a, b)));
    return snap(items[0] as number);
};

describe('decimal arithmetic', () => {
    it.each(ORACLE)('evaluates %s the way the game does', (expression, expected) => {
        expect(evaluate(expression)).toBe(expected);
    });

    it('keeps the divergence a plain double would hide', () => {
        // The whole point of the decimal path: a double gives 10 here, so `floor` would read 10 and
        // an int field would look fine, while the game refuses the value.
        expect(evaluate('10 / 3 * 3')).not.toBe(10);
        expect(Math.floor(evaluate('10 / 3 * 3'))).toBe(9);
    });

    it('rounds halves away from zero on the decimal value', () => {
        expect(decimalRound(2.5, 0)).toBe(3);
        expect(decimalRound(-2.5, 0)).toBe(-3);
        expect(decimalRound(1.005, 2)).toBe(1.01);
        expect(decimalRound(-1.5, 0)).toBe(-2);
        expect(decimalRound(2.4, 0)).toBe(2);
    });

    it('leaves values outside the guard band on plain doubles', () => {
        // mXparser skips its decimal path once an operand reaches 792281625142.6434.
        expect(decimalMultiply(1e12, 3)).toBe(3e12);
        expect(decimalPlus(Infinity, 1)).toBe(Infinity);
        expect(Number.isNaN(decimalDiv(1, 0))).toBe(true);
    });
});
