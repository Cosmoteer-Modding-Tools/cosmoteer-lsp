/**
 * The full vocabulary of mXparser built-in function keywords, taken from
 * https://mathparser.org/mxparser-math-collection/ (unary, binary, 3-arg and variadic).
 *
 * This is deliberately broader than {@link FUNCTIONS} in `value-evaluator.ts`: that table is only
 * the subset we can numerically evaluate, whereas Cosmoteer's expressions may legitimately use any
 * mXparser function (e.g. `deg`, `gamma`, `erf`). The validator uses this set only to tell a real
 * typo (`cel(...)`) from a valid-but-unevaluatable function — so it must list every valid keyword to
 * avoid false positives. Matching is case-insensitive (all entries are lowercased here).
 */
const MXPARSER_KEYWORDS: readonly string[] = [
    // Unary
    'sin', 'cos', 'tg', 'tan', 'ctg', 'cot', 'ctan', 'sec', 'csc', 'cosec',
    'asin', 'arsin', 'arcsin', 'acos', 'arcos', 'arccos', 'atg', 'atan', 'arctg', 'arctan',
    'actg', 'acot', 'actan', 'arcctg', 'arccot', 'arcctan', 'ln', 'log2', 'lg', 'log10',
    'rad', 'exp', 'sqrt', 'sinh', 'cosh', 'tgh', 'tanh', 'coth', 'ctgh', 'ctanh',
    'sech', 'csch', 'cosech', 'deg', 'abs', 'sgn', 'floor', 'ceil', 'not', 'asinh',
    'arsinh', 'arcsinh', 'acosh', 'arcosh', 'arccosh', 'atgh', 'atanh', 'arctgh', 'arctanh', 'acoth',
    'actgh', 'actanh', 'arcoth', 'arccoth', 'arcctgh', 'arcctanh', 'asech', 'arsech', 'arcsech', 'acsch',
    'arcsch', 'arccsch', 'acosech', 'arcosech', 'arccosech', 'sa', 'sinc', 'bell', 'luc', 'fib',
    'harm', 'ispr', 'pi', 'ei', 'li', 'erf', 'erfc', 'erfinv', 'erfcinv', 'ulp',
    'isnan', 'ndig10', 'nfact', 'arcsec', 'arccsc', 'gamma', 'lambw0', 'lambw1', 'sgngamma', 'loggamma',
    'digamma', 'rstud', 'rchi2',
    // Binary
    'log', 'mod', 'c', 'nck', 'bern', 'stirl1', 'stirl2', 'worp', 'euler', 'kdelta',
    'eulerpol', 'runi', 'runid', 'round', 'rnor', 'ndig', 'dig10', 'factval', 'factexp', 'root',
    'gammal', 'gammau', 'gammap', 'gammaregl', 'gammaq', 'gammaregu', 'npk', 'beta', 'logbeta', 'pstud',
    'cstud', 'qstud', 'pchi2', 'cchi2', 'qchi2', 'rfsned',
    // 3-arg
    'if', 'chi', 'puni', 'cuni', 'quni', 'pnor', 'cnor', 'qnor', 'dig', 'betainc',
    'betai', 'betareg', 'pfsned', 'cfsned', 'qfsned',
    // Variadic
    'iff', 'min', 'max', 'confrac', 'conpol', 'gcd', 'lcm', 'add', 'multi', 'mean',
    'var', 'std', 'rlist', 'coalesce', 'or', 'and', 'xor', 'argmin', 'argmax', 'med',
    'mode', 'base', 'ndist',
];

export const MXPARSER_FUNCTION_NAMES: ReadonlySet<string> = new Set(MXPARSER_KEYWORDS);

/**
 * Math functions Cosmoteer registers on top of mXparser, found by decompiling the `IMathFunction`
 * implementations the game discovers via reflection (see `inspect-cosmoteer-ot-format`). As of the
 * 2026-06 build the only one is `db2vol` (`DecibelsToVolumeMathFunction` in `Cosmoteer.dll`); it
 * takes a quoted string argument. Listed here so it is not flagged as an unknown function.
 */
export const COSMOTEER_FUNCTION_NAMES: ReadonlySet<string> = new Set(['db2vol']);
