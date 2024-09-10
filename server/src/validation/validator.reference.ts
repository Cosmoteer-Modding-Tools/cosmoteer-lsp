import { isAssignmentNode, isIdentifierNode, ValueNode } from '../parser/ast';
import { startsWithAmpersandAndLetter } from '../utils/reference.utils';
import { Validation } from './validator';

export const ValidationForReference: Validation<ValueNode> = {
    type: 'Value',
    callback: (node: ValueNode) => {
        if (
            node.valueType === 'Reference' &&
            (node.values as string).length > 1 &&
            startsWithAmpersandAndLetter(node.values as string) &&
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
        if (isAssignmentNode(v) && v.left.name === name && v.right !== node) {
            return true;
        }
        return false;
    });
};
