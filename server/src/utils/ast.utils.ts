import { CancellationToken, Position } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    isListNode,
    isAssignmentNode,
    isDocumentNode,
    isFunctionCallNode,
    isGroupNode,
    isMathExpressionNode,
} from '../core/ast/ast';
import { FileWithPath } from '../workspace/cosmoteer-workspace.service';
import { readFile } from 'fs/promises';
import { lexer } from '../core/lexer/lexer';
import { parser } from '../core/parser/parser';
import { CancellationError } from './cancellation';

/**
 * The named members of a group/list/document: each `key = value` assignment
 * (name -> its right-hand value) and each identified `{}`/`[]` (identifier -> itself).
 * The single definition of "named member" shared by the action parser, mod-context,
 * and completion.
 * @param node the group, list, or document whose elements are scanned
 * @returns the name/node pairs for each named member, in document order
 */
export const namedMembersOf = (node: { elements: AbstractNode[] }): [string, AbstractNode][] => {
    const members: [string, AbstractNode][] = [];
    for (const element of node.elements) {
        if (isAssignmentNode(element)) members.push([element.left.name, element.right]);
        else if ((isGroupNode(element) || isListNode(element)) && element.identifier)
            members.push([element.identifier.name, element]);
    }
    return members;
};

export const parseFile = async (file: FileWithPath): Promise<AbstractNodeDocument> => {
    const data = await readFile(file.path, { encoding: 'utf-8' });
    const document = parser(lexer(data), file.path).value;
    return document;
};

export const parseFilePath = async (path: string, cancellationToken?: CancellationToken) => {
    const data = await readFile(path, { encoding: 'utf-8' });
    if (cancellationToken?.isCancellationRequested) throw new CancellationError();
    return parseText(data, path);
};

/** Parse already-read source text into a document (avoids re-reading when the text is in hand). */
export const parseText = (text: string, path: string): AbstractNodeDocument => parser(lexer(text), path).value;

export const findNodeAtPosition = (document: AbstractNodeDocument, position: Position) => {
    for (const node of document.elements) {
        const foundNode = findNodeAtPositionRecursive(node, position);
        if (foundNode) {
            return foundNode;
        }
    }
};

const findNodeAtPositionRecursive = (node: AbstractNode, position: Position): AbstractNode | undefined => {
    if (isGroupNode(node)) {
        for (const property of node.elements) {
            if (node.inheritance) {
                for (const inheritance of node.inheritance) {
                    const foundNode = findNodeAtPositionRecursive(inheritance, position);
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
    } else if (isListNode(node)) {
        if (node.inheritance) {
            for (const inheritance of node.inheritance) {
                const foundNode = findNodeAtPositionRecursive(inheritance, position);
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
    } else if (isMathExpressionNode(node)) {
        // A math expression (`(&A) * (&B)`) flattens its operands into `elements`. Descend so the
        // cursor lands on the specific embedded value (e.g. a `&`-reference inside the math), the
        // same way the hover/reference finder does, instead of stopping at the whole expression.
        for (const element of node.elements) {
            const foundNode = findNodeAtPositionRecursive(element, position);
            if (foundNode) {
                return foundNode;
            }
        }
    } else if (isFunctionCallNode(node)) {
        // A function call (`ceil((&A) / 2)`) carries its operands in `arguments`. Descend likewise so
        // the cursor lands on an embedded reference argument rather than the call as a whole.
        for (const argument of node.arguments) {
            const foundNode = findNodeAtPositionRecursive(argument, position);
            if (foundNode) {
                return foundNode;
            }
        }
    } else if (isAssignmentNode(node)) {
        // A container/expression value: descend so the cursor lands on the specific inner element (a
        // list-element reference `Field = [ ref ]`, or a `&`-reference embedded in a math expression
        // `Field = (&A) * (&B)`), not the whole value. Falls back to the value below when the cursor
        // is in its span but on no deeper node.
        if (
            node.right &&
            (isListNode(node.right) ||
                isGroupNode(node.right) ||
                isMathExpressionNode(node.right) ||
                isFunctionCallNode(node.right))
        ) {
            const foundNode = findNodeAtPositionRecursive(node.right, position);
            if (foundNode) {
                return foundNode;
            }
        }
        if (
            node.right?.position &&
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

export const findNodeByIdentifier = (node: AbstractNode, identifier: string): AbstractNode | undefined => {
    if (isGroupNode(node) || isDocumentNode(node)) {
        return node.elements.find((element) => {
            if ((isListNode(element) || isGroupNode(element)) && element.identifier?.name === identifier) {
                return element;
            } else if (isAssignmentNode(element) && element.left.name === identifier) {
                return element;
            }
        });
    } else if (isListNode(node)) {
        return node.elements.find((element, i) => {
            if ((isListNode(element) || isGroupNode(element)) && element.identifier?.name === identifier) {
                return element;
            } else if (isAssignmentNode(element) && element.left.name === identifier) {
                return element;
            } else if (i.toString() === identifier) {
                return element;
            }
        });
    }
};

export const getStartOfAstNode = (node: AbstractNode): AbstractNodeDocument => {
    if (node.parent) {
        return getStartOfAstNode(node.parent);
    }
    return node as AbstractNodeDocument;
};
