import { AssignmentNode } from '../parser/ast';
import { getStartOfAstNode } from '../utils/ast.utils';
import { Validation } from './validator';

export const ValidationForAssignment: Validation<AssignmentNode> = {
    type: 'Assignment',
    callback: async (node: AssignmentNode) => {
        if (getStartOfAstNode(node).uri.includes('mod.rules')) return; // We can't validate mod.rules at the moment
        if (node.right && node.right.type === 'Value' && node.right.valueType.type === 'Reference') {
            if (node.right.quoted && node.right.valueType.value.startsWith('&')) {
                return {
                    message: 'Reference should not be quoted',
                    node: node.right,
                };
            } else if (
                node.right.valueType.value.startsWith('<') ||
                node.right.valueType.value.startsWith('..') ||
                node.right.valueType.value.startsWith('~') ||
                node.right.valueType.value.startsWith('^')
            ) {
                return {
                    message: 'Reference should start with an ampersand',
                    node: node.right,
                };
            }
        }
    },
};
