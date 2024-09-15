import { isAssignmentNode, isIdentifierNode, ValueNode } from '../parser/ast';
import { navigate } from '../utils/ast.utils';
import { startsWithAmpersandAndLetter } from '../utils/reference.utils';
import { Validation } from './validator';
import * as l10n from '@vscode/l10n';

export const ValidationForReference: Validation<ValueNode> = {
    type: 'Value',
    callback: (node: ValueNode) => {
        if (
            node.valueType.type === 'Reference' &&
            node.valueType.value.length > 1
        ) {
            if (
                startsWithAmpersandAndLetter(node.valueType.value) &&
                !hasIdentifier(node, node.valueType.value.substring(1))
            ) {
                return {
                    message: l10n.t('Reference name is not known'),
                    node: node,
                    addditionalInfo: l10n.t(
                        'You either reference a non-existing identifier or a identifier that is not in scope'
                    ),
                };
            } else if (navigate(node.valueType.value, node) === null) {
                return {
                    message: l10n.t('Reference name is not known'),
                    node: node,
                    addditionalInfo: l10n.t(
                        'You either reference a non-existing identifier or a identifier that is not in scope'
                    ),
                };
            }
        }
        return undefined;
    },
};

const hasIdentifier = (node: ValueNode, name: string) => {
    return node.parent?.elements.some((v) => {
        if (isIdentifierNode(v) && v.name === name) {
            return v;
        }
        if (isAssignmentNode(v) && v.left.name === name && v.right !== node) {
            return true;
        }
        return false;
    });
};
