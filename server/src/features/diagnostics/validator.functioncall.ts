import { FunctionCallNode } from '../../core/ast/ast';
import { Validation } from './validator';
import {
    FUNCTION_ARITY,
    functionArgumentCount,
    KNOWN_CONSTANT_NAMES,
    KNOWN_FUNCTION_NAMES,
} from '../../semantics/value-evaluator';
import { COSMOTEER_FUNCTION_NAMES, MXPARSER_FUNCTION_NAMES } from '../../semantics/mxparser-functions';
import * as l10n from '@vscode/l10n';

// A numeric literal with a unit suffix — percent `%`, degrees `d`, radians `r` — lexes as an
// unquoted String but is a valid numeric argument (e.g., the `30%` in `ceil((&A) * 30%)`).
const NUMBER_WITH_UNIT = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[%dr]$/;

/** Detail describing the minimum argument count a function needs, for the too-few-arguments diagnostic. */
const arityDescription = (name: string, min: number, max: number, got: number): string => {
    if (min === max) {
        return l10n.t('The "{0}" function takes exactly {1} argument(s), but got {2}', name, min, got);
    }
    return l10n.t('The "{0}" function takes at least {1} argument(s), but got {2}', name, min, got);
};

export const ValidationForFunctionCall: Validation<FunctionCallNode> = {
    type: 'FunctionCall',
    callback: async (node: FunctionCallNode) => {
        const name = node.name.toLowerCase();
        // A name that is neither evaluatable, a recognized (but unevaluated) mXparser function, nor a
        // Cosmoteer-custom function (`db2vol`) is almost certainly a typo.
        if (
            !KNOWN_FUNCTION_NAMES.has(name) &&
            !MXPARSER_FUNCTION_NAMES.has(name) &&
            !COSMOTEER_FUNCTION_NAMES.has(name)
        ) {
            return {
                message: l10n.t('Unknown function "{0}"', node.name),
                node,
                additionalInfo: l10n.t('"{0}" is not a known math function', node.name),
            };
        }
        // Reference-syntax checks (a Reference argument must start with `&`, and be parenthesized
        // when it sits alongside other arguments) hold for every math function, so they run for the
        // whole recognized set. The argument-*type* check (below) is limited to the evaluatable
        // functions we model: other valid functions (unevaluated mXparser extras, Cosmoteer's
        // `db2vol` which takes a quoted string) have signatures we don't know, so type-checking their
        // args would false-positive. Arity is likewise checked only for the evaluatable set (below).
        //
        // Arity is only checked for functions we model (the evaluatable ones), and only for too few
        // arguments. A nested call in an argument position (`floor(sqrt(x) * 2)`) is flattened by the
        // parser into extra operands, which can inflate the apparent count, so an over-count is
        // unreliable and never flagged. An under-count cannot be produced that way, so "forgot an
        // argument" (`pow(&a)`, `max()`) is reported safely.
        const arity = FUNCTION_ARITY[name];
        if (arity) {
            const got = functionArgumentCount(node);
            if (got < arity[0]) {
                return {
                    message: l10n.t('Too few arguments for "{0}"', node.name),
                    node,
                    additionalInfo: arityDescription(node.name, arity[0], arity[1], got),
                };
            }
        }
        for (const arg of node.arguments) {
            if (arg.type === 'Value' && arg.valueType.type === 'Reference') {
                if (!(arg.valueType.value as string).startsWith('&')) {
                    return {
                        message: l10n.t('Reference in function calls needs to start with an ampersand'),
                        node: arg,
                        additionalInfo: l10n.t(
                            'Write the argument as "&{0}" so it is read as a reference',
                            String(arg.valueType.value)
                        ),
                    };
                }
                if (!arg.parenthesized && arg.delimiter === undefined && node.arguments.length > 1) {
                    return {
                        message: l10n.t('Reference in function calls needs to be parenthesized'),
                        node: arg,
                        additionalInfo: l10n.t(
                            'Wrap the reference in parentheses, e.g. "({0})", to separate it from the other arguments',
                            String(arg.valueType.value)
                        ),
                    };
                }
            } else if (
                KNOWN_FUNCTION_NAMES.has(name) &&
                arg.type === 'Value' &&
                arg.valueType.type !== 'Reference' &&
                arg.valueType.type !== 'Number'
            ) {
                // The parser flattens a nested call (`floor(sqrt(x) * 2)`) by emitting the inner
                // function name as a bare unquoted String operand, and bare constants (`pi`, `e`) also
                // lex as unquoted strings. Neither is a bad argument — skip them so valid math isn't
                // flagged. A real offender (a quoted string, or an unknown bare word) still reports.
                const text = String(arg.valueType.value).toLowerCase();
                const isMisparsedNestedCallOrConstant =
                    !arg.quoted &&
                    (KNOWN_FUNCTION_NAMES.has(text) ||
                        MXPARSER_FUNCTION_NAMES.has(text) ||
                        KNOWN_CONSTANT_NAMES.has(text) ||
                        NUMBER_WITH_UNIT.test(text.replace(/\s+/g, '')));
                if (!isMisparsedNestedCallOrConstant) {
                    return {
                        message: l10n.t(
                            'Invalid argument type, expected Reference(&) or Number. Got {0}',
                            arg.valueType.type
                        ),
                        node: arg,
                        additionalInfo: l10n.t(
                            'Function-call arguments must be a number or a reference ("&"), not a {0}',
                            arg.valueType.type
                        ),
                    };
                }
            }
        }
    },
};
