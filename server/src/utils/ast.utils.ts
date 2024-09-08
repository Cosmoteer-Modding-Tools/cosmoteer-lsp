import { Position } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    isArrayNode,
    isAssignmentNode,
    isInheritanceNode,
    isObjectNode,
} from '../parser/ast';

export const findNodeAtPosition = (
    document: AbstractNodeDocument,
    position: Position
) => {
    for (const node of document.elements) {
        const foundNode = findNodeAtPositionRecursive(node, position);
        if (foundNode) {
            return foundNode;
        }
    }
};

const findNodeAtPositionRecursive = (
    node: AbstractNode,
    position: Position
): AbstractNode | undefined => {
    if (isObjectNode(node)) {
        for (const property of node.elements) {
            return findNodeAtPositionRecursive(property, position);
        }
    } else if (isArrayNode(node)) {
        for (const element of node.elements) {
            return findNodeAtPositionRecursive(element, position);
        }
    } else if (isInheritanceNode(node)) {
        for (const inheritance of node.inheritance) {
            const foundNode = findNodeAtPositionRecursive(
                inheritance,
                position
            );
            if (foundNode) {
                return foundNode;
            }
        }
        if (isArrayNode(node.right)) {
            for (const element of node.right.elements) {
                return findNodeAtPositionRecursive(element, position);
            }
        } else if (isObjectNode(node.right)) {
            for (const property of node.right.elements) {
                return findNodeAtPositionRecursive(property, position);
            }
        }
    } else if (isAssignmentNode(node)) {
        if (
            position.line === node.right.position.line &&
            position.character <= node.right.position.characterEnd &&
            position.character >= node.right.position.characterStart
        ) {
            return node.right;
        }
    } else {
        if (
            node.position &&
            position.line === node.position.line &&
            position.character <= node.position.characterEnd &&
            position.character >= node.position.characterStart
        ) {
            return node;
        }
    }
    return undefined;
};
