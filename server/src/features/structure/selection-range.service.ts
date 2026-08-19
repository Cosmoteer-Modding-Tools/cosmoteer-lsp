import { Position, Range, SelectionRange } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
    AbstractNode,
    AbstractNodeDocument,
    isAssignmentNode,
    isDocumentNode,
    isFunctionCallNode,
    isGroupNode,
    isListNode,
    isMathExpressionNode,
} from '../../core/ast/ast';
import { atOrBefore, enclosingRange, orderRange, unionRange } from '../navigation/ast-range';

/**
 * Selection ranges (`textDocument/selectionRange`), the chain expand-selection walks.
 *
 * Each step out is one node of the AST, from the innermost node covering the caret to the whole
 * file, so a value grows into its field, the field into the group holding it, and on out. The word
 * under the caret is not a step of its own: both clients add word-level selection themselves.
 */

/** The nodes one step further in than `node`, in source order. */
const childrenOf = (node: AbstractNode): AbstractNode[] => {
    if (isDocumentNode(node)) return node.elements;
    if (isGroupNode(node) || isListNode(node)) {
        const children: AbstractNode[] = node.identifier ? [node.identifier] : [];
        return children.concat(node.inheritance ?? [], node.elements);
    }
    if (isAssignmentNode(node)) return node.right ? [node.left, node.right] : [node.left];
    if (isFunctionCallNode(node)) return node.arguments;
    if (isMathExpressionNode(node)) return node.elements;
    return [];
};

/**
 * The full source range of a node. The envelope {@link enclosingRange} derives from the descendant
 * positions stops at the last member of a container, because the line of the closing brace is the
 * one thing an AST position never stores, only the offset one past it. Folding that offset back in
 * is what makes selecting a group take its `}` with it.
 */
const spanOf = (node: AbstractNode, document: TextDocument): Range => {
    const envelope = orderRange(enclosingRange(node));
    const position = node.position;
    if (!position || position.end <= position.start) return envelope;
    return unionRange(envelope, {
        start: document.positionAt(position.start),
        end: document.positionAt(position.end),
    });
};

/** True when `position` sits in `range`, both ends included so a caret just past a value still takes it. */
const covers = (range: Range, position: Position): boolean =>
    atOrBefore(range.start.line, range.start.character, position.line, position.character) &&
    atOrBefore(position.line, position.character, range.end.line, range.end.character);

/** True when `inner` lies within `outer`. */
const within = (inner: Range, outer: Range): boolean =>
    atOrBefore(outer.start.line, outer.start.character, inner.start.line, inner.start.character) &&
    atOrBefore(inner.end.line, inner.end.character, outer.end.line, outer.end.character);

/** True when two ranges select the same text. */
const sameRange = (a: Range, b: Range): boolean =>
    a.start.line === b.start.line &&
    a.start.character === b.start.character &&
    a.end.line === b.end.line &&
    a.end.character === b.end.character;

/** The whole file, the last step the chain can take. */
const wholeDocument = (document: TextDocument): Range => ({
    start: { line: 0, character: 0 },
    end: document.positionAt(document.getText().length),
});

/**
 * Descend from the document to the innermost node covering `position`, collecting the range of
 * every node on the way. A repaired range and the range of the value it introduces can overlap, so
 * each step takes the narrowest child that still covers the position.
 */
const chainAt = (document: TextDocument, root: AbstractNodeDocument, position: Position): Range[] => {
    const ranges: Range[] = [];
    let node: AbstractNode = root;
    for (;;) {
        let bestNode: AbstractNode | undefined;
        let bestRange: Range | undefined;
        for (const child of childrenOf(node)) {
            const range = spanOf(child, document);
            if (!covers(range, position)) continue;
            if (bestRange && !within(range, bestRange)) continue;
            bestNode = child;
            bestRange = range;
        }
        if (!bestNode || !bestRange) return ranges;
        ranges.push(bestRange);
        node = bestNode;
    }
};

/** The chain for one caret, returned innermost first with its parents linked outward. */
const selectionAt = (
    document: TextDocument,
    parserResult: AbstractNodeDocument,
    position: Position
): SelectionRange => {
    const ranges = [wholeDocument(document), ...chainAt(document, parserResult, position)];
    // The protocol requires a parent to contain its child, which a repaired child range can outgrow:
    // a container the parser never saw closed takes its span from its members, which can reach past
    // what the node above it derived. Widening outward keeps the chain valid.
    for (let index = ranges.length - 2; index >= 0; index--) {
        ranges[index] = unionRange(ranges[index], ranges[index + 1]);
    }
    let selection = SelectionRange.create(ranges[0]);
    for (const range of ranges.slice(1)) {
        // A step selecting exactly what the step before it selected is no step at all.
        if (sameRange(selection.range, range)) continue;
        selection = SelectionRange.create(range, selection);
    }
    return selection;
};

/**
 * The selection ranges of one `.rules` document.
 *
 * @param document the open document, read for the position a source offset falls on.
 * @param parserResult the parsed AST of that same text.
 * @param positions the caret positions the client asked about.
 * @returns one chain per requested position, in the same order.
 */
export const computeSelectionRanges = (
    document: TextDocument,
    parserResult: AbstractNodeDocument,
    positions: Position[]
): SelectionRange[] => positions.map((position) => selectionAt(document, parserResult, position));
