import { FunctionCallNode } from '../../core/ast/ast';
import { Validation } from './validator';
import { functionArgumentCount } from '../../semantics/value-evaluator';
import {
    ALL_MATH_FUNCTION_NAMES,
    KNOWN_CONSTANT_NAMES,
    KNOWN_FUNCTION_NAMES,
    mathFunction,
} from '../../semantics/math-function-registry';
import { getStartOfAstNode } from '../../utils/ast.utils';
import { isStringsFile } from '../../mod/strings-folder';
import * as l10n from '@vscode/l10n';

// A numeric literal with a unit suffix — percent `%`, degrees `d`, radians `r` — lexes as an
// unquoted String but is a valid numeric argument (e.g., the `30%` in `ceil((&A) * 30%)`).
const NUMBER_WITH_UNIT = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[%dr]$/;

// Every real math function is named like an identifier. A non-identifier "name" (a lone `&`
// operator, a stray punctuation run) is a parser artifact of text the game reads flat, not a
// typo'd function call, so no function-call rule applies to it.
const IDENTIFIER_NAME = /^[\p{L}_][\p{L}\p{N}_]*$/u;

/** Detail describing the minimum argument count a function needs, for the too-few-arguments diagnostic. */
const arityDescription = (name: string, min: number, max: number, got: number): string => {
    if (min === max) {
        return l10n.t('The "{0}" function takes exactly {1} argument(s), but got {2}', name, min, got);
    }
    return l10n.t('The "{0}" function takes at least {1} argument(s), but got {2}', name, min, got);
};

export const ValidationForFunctionCall: Validation<FunctionCallNode> = {
    type: 'FunctionCall',
    callback: async (node: FunctionCallNode, cancellationToken) => {
        const name = node.name.toLowerCase();
        if (!IDENTIFIER_NAME.test(node.name)) return undefined;
        // Language-strings files hold localization text, not expressions: a value like
        // `Desejado(s)` (vanilla `strings/pt-br.rules`) parses as a call of an unknown function.
        // The game reads the whole thing as a flat string, so skip function-call validation here.
        if (await isStringsFile(getStartOfAstNode(node).uri, cancellationToken)) return undefined;
        // A name the math-function registry does not know is almost certainly a typo.
        if (!ALL_MATH_FUNCTION_NAMES.has(name)) {
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
        // `db2vol` which takes a quoted string) have argument types we don't know, so type-checking
        // their args would false-positive.
        //
        // Arity comes from the registry for every known function, and only too few arguments are
        // flagged. A nested call in an argument position (`floor(sqrt(x) * 2)`) is flattened by the
        // parser into extra operands, which can inflate the apparent count, so an over-count is
        // unreliable and never flagged. An under-count cannot be produced that way, so "forgot an
        // argument" (`pow(&a)`, `if(a, b)`, `max()`) is reported safely.
        const arity = mathFunction(name)?.arity;
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
                // flagged. A quoted argument is valid too: the game reads the field value flat, so the
                // quotes just escape the text and the content is evaluated as an expression. Vanilla
                // `missile_launcher_thermal` has `ceil("(&~/BASE/…/MaxResources) / (&…)")`. Only an
                // unknown bare word still reports.
                const text = String(arg.valueType.value).toLowerCase();
                const isValidStringArgument =
                    arg.quoted ||
                    ALL_MATH_FUNCTION_NAMES.has(text) ||
                    KNOWN_CONSTANT_NAMES.has(text) ||
                    NUMBER_WITH_UNIT.test(text.replace(/\s+/g, ''));
                if (!isValidStringArgument) {
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
