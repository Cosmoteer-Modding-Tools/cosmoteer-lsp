import { isAssignmentNode, isIdentifierNode, ValueNode } from '../parser/ast';
import { Validation } from './validator';

export const ValidationForReference: Validation<ValueNode> = {
    type: 'Value',
    callback: (node: ValueNode) => {
        if (
            node.valueType === 'Reference' &&
            node.values.toString().length > 1 &&
            node.values.toString().startsWith('&') &&
            !hasIdentifier(node, (node.values as string).substring(1))
        ) {
            return {
                message: 'Reference name is not known',
                node: node,
            };
        }
        return undefined;
    },
};

const hasIdentifier = (node: ValueNode, name: string) => {
    return node.parent?.elements.some((v) => {
        if (isIdentifierNode(v) && v.name === name) {
            return v;
        }
        if (isAssignmentNode(v) && v.left.name === name) {
            return true;
        }
        return false;
    });
};
