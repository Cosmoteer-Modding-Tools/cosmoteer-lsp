import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    AstType,
    isListNode,
    isAssignmentNode,
    isDocumentNode,
    isFunctionCallNode,
    isGroupNode,
    isMathExpressionNode,
} from '../../core/ast/ast';
import { globalSettings } from '../../settings';
import { expressionOperands, ValidationCallback, ValidationError } from './validator';
import { ValidationForIdentifier, ValidationForValue } from './validator.value';
import { ValidationForFunctionCall } from './validator.functioncall';
import { ValidationForAssignment } from './validator.assignment';
import { ValidationForMath } from './validator.math';
import { ValidationForGroupDuplicates } from './validator.duplicate-key';

/**
 * The node-level checks, keyed by the node type each one judges.
 *
 * A fixed table rather than a registry: the singleton this replaced carried a `registerValidation`
 * extension point fed by six calls from one startup site and nothing else, so the "registry" was a
 * fixed table wearing a lazy singleton. It lives here rather than beside the types every check
 * imports, which is the one arrangement that reads the six without importing them in a circle.
 */
const VALIDATIONS = new Map<AstType, ValidationCallback<any>>(
    [
        ValidationForValue,
        ValidationForIdentifier,
        ValidationForFunctionCall,
        ValidationForAssignment,
        ValidationForMath,
        ValidationForGroupDuplicates,
    ].map((validation): [AstType, ValidationCallback<any>] => [validation.type, validation.callback])
);

/**
 * Every node-level finding under one element of a document.
 *
 * @param node the element to judge, with its whole subtree.
 * @param cancellationToken cancels the checks.
 * @returns the findings, in no particular order.
 */
export const validate = async (
    node: AbstractNode,
    cancellationToken: CancellationToken
): Promise<ValidationError[]> => {
    const promises: Promise<ValidationError | undefined>[] = [];
    promises.push(validateRecursive(node, promises, cancellationToken));
    return (
        await Promise.all(promises).catch((error) => {
            if (globalSettings.trace.server === 'verbose') {
                console.error(error);
            }
            return [];
        })
    ).filter((v) => v !== undefined) as ValidationError[];
};

/**
 * Judges one node and descends into everything it holds.
 *
 * @param node the node to judge.
 * @param promises the run's findings, which a nested node adds to.
 * @param cancellationToken cancels the checks.
 * @returns nothing of its own, the findings arrive through `promises`.
 */
const validateRecursive = async (
    node: AbstractNode,
    promises: Promise<ValidationError | undefined>[],
    cancellationToken: CancellationToken
): Promise<ValidationError | undefined> => {
    // `node` is `null` for an incomplete `Field =` (AssignmentNode.right before a value is
    // typed). Guard it too, or dereferencing `node.type` throws and Promise.all's rejection
    // drops every diagnostic for the enclosing element while the user is mid-edit.
    if (node === undefined || node === null) return;
    const callback = VALIDATIONS.get(node.type);
    if (callback) {
        promises.push(callback(node, cancellationToken));
    }
    if (isListNode(node) || isGroupNode(node) || isDocumentNode(node)) {
        for (const child of node.elements) {
            promises.push(validateRecursive(child, promises, cancellationToken));
        }
        if ((isListNode(node) || isGroupNode(node)) && node.inheritance) {
            for (const child of node.inheritance) {
                promises.push(validateRecursive(child, promises, cancellationToken));
            }
        }
    } else if (isAssignmentNode(node)) {
        promises.push(validateRecursive(node.left, promises, cancellationToken));
        if (node.right) promises.push(validateRecursive(node.right, promises, cancellationToken));
    } else if (isFunctionCallNode(node)) {
        for (const child of node.arguments) {
            promises.push(validateRecursive(child, promises, cancellationToken));
        }
    } else if (isMathExpressionNode(node)) {
        for (const child of node.elements) {
            promises.push(validateMathOperand(child, promises, cancellationToken));
        }
    }
};

/**
 * Judges the values an expression is computed from. The shared child walk stops at the value an
 * expression is written as, so an operand is reached from here instead, and a parenthesised
 * sub-expression is opened to reach the operands inside it. The engine substitutes a `(&ref)`
 * operand before it evaluates anything, so a reference standing in one is exactly as live as a
 * reference written as the whole value.
 *
 * Only the operand values are judged. The expression itself is judged once, where it is
 * written, so its own checks are not run again on every sub-expression inside it.
 *
 * @param node the operand.
 * @param promises the run's findings, which a nested operand adds to.
 * @param cancellationToken cancels the value checks.
 * @returns nothing of its own, the findings arrive through `promises`.
 */
const validateMathOperand = async (
    node: AbstractNode,
    promises: Promise<ValidationError | undefined>[],
    cancellationToken: CancellationToken
): Promise<ValidationError | undefined> => {
    if (node === undefined || node === null) return;
    if (isMathExpressionNode(node)) {
        for (const child of node.elements) {
            promises.push(validateMathOperand(child, promises, cancellationToken));
        }
        return;
    }
    const callback = VALIDATIONS.get('Value');
    if (callback && node.type === 'Value') {
        expressionOperands.add(node);
        promises.push(callback(node, cancellationToken));
    }
};
