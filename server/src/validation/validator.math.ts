import { AbstractNode, isExpressionNode, MathExpressionNode } from '../parser/ast';
import { Validation } from './validator';
import * as l10n from '@vscode/l10n';

export const ValidationForMath: Validation<MathExpressionNode> = {
    type: 'MathExpression',
    callback: async (node: MathExpressionNode) => {
        let lastNode: AbstractNode | null = null;
        for (const child of node.elements) {
            // Check for double expressions
            if (lastNode && isExpressionNode(lastNode) && isExpressionNode(child)) {
                return {
                    message: l10n.t('Between two expressions should be a Value'),
                    node: child,
                };
            }
            // Check for last element in MathExpression
            if (isExpressionNode(child) && node.elements[node.elements.length - 1] === child) {
                return {
                    message: l10n.t('Last element in MathExpression should be a Value'),
                    node: child,
                };
            }
            // Check for Value type
            if (child.type === 'Value' && child.valueType.type !== 'Number' && child.valueType.type !== 'Reference') {
                return {
                    message: l10n.t(
                        'Invalid argument type, expected Number or Reference. Got {0}',
                        child.valueType.type
                    ),
                    node: child,
                };
            }
            lastNode = child;
        }
    },
};
