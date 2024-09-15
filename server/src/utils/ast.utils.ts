import { Position } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    isArrayNode,
    isAssignmentNode,
    isDocumentNode,
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
            if (node.inheritance) {
                for (const inheritance of node.inheritance) {
                    const foundNode = findNodeAtPositionRecursive(
                        inheritance,
                        position
                    );
                    if (foundNode) {
                        return foundNode;
                    }
                }
            }
            const foundNode = findNodeAtPositionRecursive(property, position);
            if (foundNode) {
                return foundNode;
            }
        }
    } else if (isArrayNode(node)) {
        if (node.inheritance) {
            for (const inheritance of node.inheritance) {
                const foundNode = findNodeAtPositionRecursive(
                    inheritance,
                    position
                );
                if (foundNode) {
                    return foundNode;
                }
            }
        }
        for (const element of node.elements) {
            const foundNode = findNodeAtPositionRecursive(element, position);
            if (foundNode) {
                return foundNode;
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

export const getStartOfAstNode = (node: AbstractNode): AbstractNodeDocument => {
    if (node.parent) {
        return getStartOfAstNode(node.parent);
    }
    return node as AbstractNodeDocument;
};

export const navigate = (
    path: string,
    startNode: AbstractNode
): AbstractNode | null => {
    if (path.startsWith('&<')) {
        return navigateRules(path);
    } else if (path.startsWith('&/')) {
        return navigateSuperPath(path);
    } else if (path.startsWith('&') && startNode.parent) {
        return navigateReference(path.substring(1), startNode.parent);
    }
    return null;
};

export const navigateReference = (
    path: string,
    startNode: AbstractNode
): AbstractNode | null => {
    const substrings = extractSubstrings(path);
    let node: AbstractNode | null | undefined = startNode;
    for (const substring of substrings) {
        node = navigateReferenceRecursive(substring, node);

        if (!node) {
            return null;
        }
    }
    return node;
};

const isNumber = (value: string) => {
    return !isNaN(Number(value));
};

export const navigateReferenceRecursive = (
    substring: string,
    node: AbstractNode
) => {
    if (substring === 'Components') {
        console.log('found components');
    }
    if (isNumber(substring)) {
        const index = Number(substring);
        if (isArrayNode(node)) {
            return node.elements[index];
        }
    } else if (substring === '..') {
        return node.parent;
    } else if (substring === '~') {
        return getStartOfAstNode(node);
    } else {
        if (isObjectNode(node) || isDocumentNode(node)) {
            for (const element of node.elements) {
                if (
                    isAssignmentNode(element) &&
                    element.left.name === substring
                ) {
                    return element.right;
                } else if (
                    isObjectNode(element) &&
                    element.identifier?.name === substring
                ) {
                    return element;
                } else if (
                    isArrayNode(element) &&
                    element.identifier?.name === substring
                ) {
                    return element;
                }
            }
        }
    }
    return null;
};

export const navigateRules = (path: string) => {
    return null;
};

export const navigateSuperPath = (path: string) => {
    return null;
};

const extractSubstrings = (input: string): string[] => {
    const regex = /([^/]+)/g;
    const matches = input.matchAll(regex);
    return Array.from(matches, (match) => match[1]);
};