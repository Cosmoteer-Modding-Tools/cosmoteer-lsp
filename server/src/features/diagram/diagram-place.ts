import { AbstractNode, isGroupNode, isListNode } from '../../core/ast/ast';
import { filePathToUri } from '../../document/reference-path';
import { getStartOfAstNode } from '../../utils/ast.utils';
import { DiagramPlace } from './diagram.types';

/**
 * Where clicking a box goes, taken from the node the box stands for.
 *
 * A part inherits most of what is drawn for it, so the node behind a box often lives in a base file.
 * Taking the file from the part being drawn instead opens the part at a line counted in another
 * file, which lands on whatever that line happens to hold. A document read through the file index is
 * parsed under its on-disk path, which no client can open, so the path becomes a uri here.
 *
 * A named container's own position starts at its brace, so the name line is taken from the
 * identifier where there is one, which is the line a reader expects to land on.
 *
 * @param node the node the box stands for.
 * @returns the file and the one-based line the box opens.
 */
export const placeOfNode = (node: AbstractNode): DiagramPlace => {
    const named = isGroupNode(node) || isListNode(node) ? node.identifier : undefined;
    return {
        uri: filePathToUri(getStartOfAstNode(node).uri),
        line: (named ?? node).position.line + 1,
    };
};
