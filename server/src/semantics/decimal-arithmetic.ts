/**
 * The four arithmetic operators as the game computes them.
 *
 * mXparser runs with canonical rounding on, so `MathFunctions.plus/minus/multiply/div` do not use
 * plain IEEE doubles: each operand is cast to a C# `decimal`, the operation is exact in decimal,
 * and the result is cast back. The cast from double to decimal keeps only 15 significant digits,
 * which is where the game's arithmetic visibly parts ways with JavaScript: `10 / 3 * 3` is
 * 9.99999999999999 in the game and 10 in a plain double, so `floor(10 / 3 * 3)` is 9 there and an
 * int field fed that expression refuses to load.
 *
 * Everything here mirrors the decompiled `MathFunctions` of the shipped mXparser 4.4.2. Operands
 * outside the guard band (|x| >= 792281625142.6434) or an infinite intermediate result fall back to
 * the plain double, exactly as `isNotInDecimalRange` does.
 */

/** A C# `decimal`: the value is `unscaled / 10 ** scale`, with the sign carried by `unscaled`. */
interface Decimal {
    unscaled: bigint;
    scale: number;
}

/** Largest magnitude a C# `decimal` can hold, as its 96-bit unscaled integer. */
const MAX_UNSCALED = 2n ** 96n - 1n;

/** C# `decimal` carries at most 28 digits after the point. */
const MAX_SCALE = 28;

/** mXparser's own guard band: outside it every operator stays on plain doubles. */
const DECIMAL_RANGE_LIMIT = 792281625142.6434;

/** Significant digits kept by the C# cast from `double` to `decimal`. */
const CAST_PRECISION = 15;

const TEN = 10n;

/**
 * Power of ten as a bigint.
 *
 * @param exponent how many zeros, never negative.
 * @returns ten raised to that exponent.
 */
const pow10 = (exponent: number): bigint => TEN ** BigInt(exponent);

/**
 * Divide and round half away from zero, the tie rule C# uses when a decimal result has to shed
 * digits.
 *
 * @param numerator the value being scaled down.
 * @param denominator the power of ten to divide by, always positive.
 * @returns the rounded quotient.
 */
const divRoundHalfUp = (numerator: bigint, denominator: bigint): bigint => {
    const negative = numerator < 0n;
    const magnitude = negative ? -numerator : numerator;
    const quotient = magnitude / denominator;
    const remainder = magnitude - quotient * denominator;
    const rounded = remainder * 2n >= denominator ? quotient + 1n : quotient;
    return negative ? -rounded : rounded;
};

/**
 * Drop trailing zeros from a decimal so later operations have room in the scale. The value is
 * unchanged, only its representation shrinks.
 *
 * @param value the decimal to tidy.
 * @returns an equal decimal with the smallest scale that still represents it exactly.
 */
const trim = (value: Decimal): Decimal => {
    let { unscaled, scale } = value;
    while (scale > 0 && unscaled % TEN === 0n) {
        unscaled /= TEN;
        scale--;
    }
    return { unscaled, scale };
};

/**
 * Whether a decimal still fits the 96-bit unscaled range C# enforces.
 *
 * @param value the decimal to check.
 * @returns true when the value is representable.
 */
const fits = (value: Decimal): boolean => {
    const magnitude = value.unscaled < 0n ? -value.unscaled : value.unscaled;
    return magnitude <= MAX_UNSCALED && value.scale >= 0 && value.scale <= MAX_SCALE;
};

/**
 * The C# cast from `double` to `decimal`: keep 15 significant digits, exactly.
 *
 * @param value the double to convert.
 * @returns the decimal, or null when the value cannot be represented as one.
 */
const fromDouble = (value: number): Decimal | null => {
    if (!isFinite(value)) return null;
    if (value === 0) return { unscaled: 0n, scale: 0 };
    // toPrecision is the same round-to-15-significant-digits the cast performs, and it hands back a
    // decimal spelling, which is what a decimal is. Exponential form appears for very small values.
    const text = value.toPrecision(CAST_PRECISION);
    const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
    if (!match) return null;
    const [, sign, whole, fraction = '', exponent = '0'] = match;
    let unscaled = BigInt(whole + fraction);
    let scale = fraction.length - Number(exponent);
    if (scale < 0) {
        unscaled *= pow10(-scale);
        scale = 0;
    }
    if (sign === '-') unscaled = -unscaled;
    const result = trim({ unscaled, scale });
    return fits(result) ? result : null;
};

/**
 * The C# cast from `decimal` back to `double`.
 *
 * @param value the decimal to convert.
 * @returns the nearest double.
 */
const toDouble = (value: Decimal): number => {
    if (value.scale === 0) return Number(value.unscaled);
    const negative = value.unscaled < 0n;
    const digits = (negative ? -value.unscaled : value.unscaled).toString().padStart(value.scale + 1, '0');
    const point = digits.length - value.scale;
    return Number(`${negative ? '-' : ''}${digits.slice(0, point)}.${digits.slice(point)}`);
};

/**
 * Line two decimals up on the same scale so they can be added.
 *
 * @param a the first decimal.
 * @param b the second decimal.
 * @returns both unscaled values on the shared scale.
 */
const align = (a: Decimal, b: Decimal): { left: bigint; right: bigint; scale: number } => {
    const scale = Math.max(a.scale, b.scale);
    return {
        left: a.unscaled * pow10(scale - a.scale),
        right: b.unscaled * pow10(scale - b.scale),
        scale,
    };
};

/**
 * Reduce a decimal to at most the representable range by shedding low digits, the way C# rounds a
 * product that needs more than 28 places.
 *
 * @param value the decimal that may not fit.
 * @returns a representable decimal, or null when even scale zero overflows.
 */
const reduce = (value: Decimal): Decimal | null => {
    let current = trim(value);
    while (!fits(current) && current.scale > 0) {
        const shed = Math.max(1, current.scale - MAX_SCALE);
        current = trim({ unscaled: divRoundHalfUp(current.unscaled, pow10(shed)), scale: current.scale - shed });
    }
    return fits(current) ? current : null;
};

/**
 * Run a binary operator through decimal arithmetic when the game would, otherwise hand back the
 * plain double result.
 *
 * @param a the left operand.
 * @param b the right operand.
 * @param plain the IEEE result of the same operation.
 * @param exact the decimal implementation of the operation.
 * @returns the number the game's evaluator produces.
 */
const canonical = (
    a: number,
    b: number,
    plain: number,
    exact: (left: Decimal, right: Decimal) => Decimal | null
): number => {
    if (Number.isNaN(a) || Number.isNaN(b)) return NaN;
    const outOfBand = (x: number): boolean => !isFinite(x) || Math.abs(x) >= DECIMAL_RANGE_LIMIT;
    if (outOfBand(a) || outOfBand(b) || outOfBand(plain)) return plain;
    const left = fromDouble(a);
    const right = fromDouble(b);
    if (!left || !right) return plain;
    const result = exact(left, right);
    return result ? toDouble(result) : plain;
};

/**
 * Addition as the game computes it.
 *
 * @param a the left operand.
 * @param b the right operand.
 * @returns the sum.
 */
export const decimalPlus = (a: number, b: number): number =>
    canonical(a, b, a + b, (left, right) => {
        const { left: x, right: y, scale } = align(left, right);
        return reduce({ unscaled: x + y, scale });
    });

/**
 * Subtraction as the game computes it.
 *
 * @param a the left operand.
 * @param b the right operand.
 * @returns the difference.
 */
export const decimalMinus = (a: number, b: number): number =>
    canonical(a, b, a - b, (left, right) => {
        const { left: x, right: y, scale } = align(left, right);
        return reduce({ unscaled: x - y, scale });
    });

/**
 * Multiplication as the game computes it.
 *
 * @param a the left operand.
 * @param b the right operand.
 * @returns the product.
 */
export const decimalMultiply = (a: number, b: number): number =>
    canonical(a, b, a * b, (left, right) =>
        reduce({ unscaled: left.unscaled * right.unscaled, scale: left.scale + right.scale })
    );

/**
 * Exact decimal division, carrying as many places as a C# `decimal` can hold.
 *
 * @param left the dividend.
 * @param right the divisor.
 * @returns the quotient, or null when it does not fit.
 */
const divideExact = (left: Decimal, right: Decimal): Decimal | null => {
    if (right.unscaled === 0n) return null;
    // (ua / 10^sa) / (ub / 10^sb) = (ua * 10^sb) / (ub * 10^sa), so the scales move to the operands.
    const numerator = left.unscaled * pow10(right.scale);
    const denominator = right.unscaled * pow10(left.scale);
    for (let scale = MAX_SCALE; scale >= 0; scale--) {
        const unscaled = divRoundHalfUp(numerator * pow10(scale), denominator);
        const candidate = { unscaled, scale };
        if (fits(candidate)) return trim(candidate);
    }
    return null;
};

/**
 * Division as the game computes it. mXparser keeps whichever of the two results leaves the smaller
 * residual when multiplied back by the divisor, so an exactly representable quotient stays on the
 * double path.
 *
 * @param a the dividend.
 * @param b the divisor.
 * @returns the quotient, or NaN when dividing by zero.
 */
export const decimalDiv = (a: number, b: number): number => {
    if (b === 0) return NaN;
    if (Number.isNaN(a) || Number.isNaN(b)) return NaN;
    const plain = a / b;
    const outOfBand = (x: number): boolean => !isFinite(x) || Math.abs(x) >= DECIMAL_RANGE_LIMIT;
    if (outOfBand(a) || outOfBand(b) || outOfBand(plain)) return plain;
    const left = fromDouble(a);
    const right = fromDouble(b);
    if (!left || !right) return plain;
    const quotient = divideExact(left, right);
    if (!quotient) return plain;
    const plainResidual = Math.abs(a - plain * b);
    const product = reduce({
        unscaled: quotient.unscaled * right.unscaled,
        scale: quotient.scale + right.scale,
    });
    if (!product) return plain;
    const { left: x, right: y, scale } = align(left, product);
    const difference = reduce({ unscaled: x - y, scale });
    if (!difference) return plain;
    const decimalResidual = Math.abs(toDouble(difference));
    return plainResidual <= decimalResidual ? plain : toDouble(quotient);
};

/**
 * `round(x, places)` as mXparser computes it: the value is rounded in decimal, with ties going away
 * from zero, so `round(-2.5, 0)` is -3 and `round(1.005, 2)` is 1.01 rather than the 1 a binary
 * double lands on.
 *
 * @param value the number to round.
 * @param places how many decimal places to keep.
 * @returns the rounded value, or NaN when it cannot be expressed as a decimal.
 */
export const decimalRound = (value: number, places: number): number => {
    if (!isFinite(value) || !Number.isFinite(places)) return NaN;
    const whole = Math.trunc(places);
    if (whole < 0 || whole > MAX_SCALE) return NaN;
    const decimal = fromDouble(value);
    if (!decimal) return NaN;
    if (decimal.scale <= whole) return value;
    const shed = decimal.scale - whole;
    return toDouble(trim({ unscaled: divRoundHalfUp(decimal.unscaled, pow10(shed)), scale: whole }));
};
