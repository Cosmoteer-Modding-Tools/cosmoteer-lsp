import { AbstractNode, ExpressionNode, isExpressionNode, isValueNode, MathExpressionNode } from '../../core/ast/ast';
import { Validation } from './validator';
import { KNOWN_CONSTANT_NAMES, mathNameWithCorrectCase } from '../../semantics/math-function-registry';
import { getStartOfAstNode } from '../../utils/ast.utils';
import { isStringsFile } from '../../mod/strings-folder';
import * as l10n from '@vscode/l10n';

/**
 * A bare mXparser math constant (`pi`, `e`) is a valid operand even though it lexes as a String.
 * The spelling is case-sensitive: the game reads `PI` as an invalid token and refuses the file.
 */
const isMathConstant = (node: AbstractNode): boolean =>
    isValueNode(node) && KNOWN_CONSTANT_NAMES.has(String(node.valueType.value));

// A numeric literal carrying a unit suffix: percent `%`, degrees `d` or radians `r` (mXparser/
// Cosmoteer expression suffixes). The lexer keeps the suffix inside the value token, so `300%`
// or `1.5r` lexes as a String even though it is a perfectly valid numeric math operand.
const NUMBER_WITH_UNIT = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[%dr]$/;
const isUnitNumber = (node: AbstractNode): boolean =>
    isValueNode(node) && NUMBER_WITH_UNIT.test(String(node.valueType.value).replace(/\s+/g, ''));

// Arithmetic written with nothing between its operators and operands (`1.5-32/64`, the `Location`
// of a mod's tiled part). Nothing separates the tokens, so the lexer hands the whole run over as
// one String where a spaced `1.5 - 32 / 64` would have become five nodes. The game evaluates the
// token's text either way, and so does the evaluator, so it is a numeric operand like any other.
const GLUED_ARITHMETIC =
    /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[%dr]?(?:[-+*/^#](?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[%dr]?)+$/;
const isGluedArithmetic = (node: AbstractNode): boolean =>
    isValueNode(node) && GLUED_ARITHMETIC.test(String(node.valueType.value).replace(/\s+/g, ''));

// `!` (factorial) is a postfix operator, it completes the value before it rather than expecting a
// value after it, so it is exempt from the binary-operator alternation rules below.
const isBinaryExpression = (node: AbstractNode | null): node is ExpressionNode =>
    !!node && isExpressionNode(node) && node.expressionType !== '!';

export const ValidationForMath: Validation<MathExpressionNode> = {
    type: 'MathExpression',
    callback: async (node: MathExpressionNode, cancellationToken) => {
        // Language-strings files hold localization text, not expressions: an unquoted value like
        // `PNG画像ファイル（*.png）` lexes a stray `*` as a multiply operator, producing a bogus
        // "Got String" operand error. The game reads the whole thing as a flat string. Skip math
        // validation here.
        if (await isStringsFile(getStartOfAstNode(node).uri, cancellationToken)) return undefined;
        let lastNode: AbstractNode | null = null;
        for (const child of node.elements) {
            // Check for double expressions (a postfix `!` followed by a binary operator is fine).
            if (isBinaryExpression(lastNode) && isBinaryExpression(child)) {
                return {
                    message: l10n.t('Two operators in a row in a math expression'),
                    node: child,
                    additionalInfo: l10n.t('There should be a value (number or reference) between two operators'),
                };
            }
            // Check for last element in the math expression (a trailing `!` is a valid value suffix).
            if (isBinaryExpression(child) && node.elements[node.elements.length - 1] === child) {
                return {
                    message: l10n.t('A math expression cannot end with an operator'),
                    node: child,
                    additionalInfo: l10n.t('Add a value (number or reference) after the trailing operator'),
                };
            }
            // A reference only reaches the expression evaluator when it is written `(&path)`: the
            // game substitutes that exact shape and reads anything else as part of a path, so
            // `&A * 2` never loads. The parser records the parentheses on the operand.
            if (child.type === 'Value' && child.valueType.type === 'Reference' && !child.parenthesized) {
                return {
                    message: l10n.t('Put this reference in parentheses'),
                    node: child,
                    additionalInfo: l10n.t(
                        'Only "({0})" is substituted into an expression. Written bare, the game reads the rest of the line as part of the path',
                        String(child.valueType.value)
                    ),
                };
            }
            if (child.type === 'Value' && child.valueType.type !== 'Number') {
                const corrected = mathNameWithCorrectCase(String(child.valueType.value));
                if (corrected) {
                    return {
                        message: l10n.t('Unknown name "{0}", did you mean "{1}"?', String(child.valueType.value), corrected),
                        node: child,
                        additionalInfo: l10n.t('Math names are case-sensitive, write "{0}"', corrected),
                        data: {
                            quickFix: { title: l10n.t('Change to "{0}"', corrected), newText: corrected },
                        },
                    };
                }
            }
            if (
                child.type === 'Value' &&
                child.valueType.type !== 'Number' &&
                child.valueType.type !== 'Reference' &&
                !isMathConstant(child) &&
                !isUnitNumber(child) &&
                !isGluedArithmetic(child)
            ) {
                return {
                    message: l10n.t(
                        'Invalid argument type, expected Number or Reference. Got {0}',
                        child.valueType.type
                    ),
                    node: child,
                    additionalInfo: l10n.t(
                        'Math expressions can only contain numbers and references ("&"), not a {0}',
                        child.valueType.type
                    ),
                };
            }
            lastNode = child;
        }
    },
};
