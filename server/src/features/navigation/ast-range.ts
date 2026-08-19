import { Range } from 'vscode-languageserver';
import {
    AbstractNode,
    AstPosition,
    isAssignmentNode,
    isFunctionCallNode,
    isGroupNode,
    isListNode,
    isMathExpressionNode,
} from '../../core/ast/ast';

/**
 * Range arithmetic over the AST, shared by every feature that answers with a span rather than a
 * value (the outline, folding, expand selection). An {@link AstPosition} records a single line per
 * node and can come back reversed from recovered input, so each of those derives its span through
 * the same repair instead of reading `position` directly.
 */

/** True when `position` (line, character) is at or before `other`. */
export const atOrBefore = (line: number, char: number, oLine: number, oChar: number): boolean =>
    line < oLine || (line === oLine && char <= oChar);

/**
 * Return `range` with `start`/`end` swapped if they are inverted. A single AST
 * {@link AstPosition} can carry `characterEnd < characterStart` when the parser recovers from
 * malformed input (an unclosed `[` leaves the node's end column at its `0` default), which
 * produces a reversed one-line range. {@link unionRange} keys off the stored `start`/`end`, so
 * a reversed input would let the true leftmost/rightmost column escape the union. Ordering
 * first keeps the union honest.
 */
export const orderRange = (range: Range): Range =>
    atOrBefore(range.start.line, range.start.character, range.end.line, range.end.character)
        ? range
        : { start: range.end, end: range.start };

/** The smallest range covering both inputs. Assumes each input is ordered ({@link orderRange}). */
export const unionRange = (a: Range, b: Range): Range => ({
    start: atOrBefore(a.start.line, a.start.character, b.start.line, b.start.character) ? a.start : b.start,
    end: atOrBefore(a.end.line, a.end.character, b.end.line, b.end.character) ? b.end : a.end,
});

/**
 * Visit the position of `node` and every descendant, across all node shapes. Some
 * structural nodes (e.g. `Assignment`) carry no own `position`, so each visit is guarded.
 */
export const walkPositions = (node: AbstractNode | null | undefined, visit: (position: AstPosition) => void): void => {
    if (!node) return; // a bare key (`EmitPerOneShot`) parses to an assignment with no right value
    if (node.position) visit(node.position);
    if (isGroupNode(node) || isListNode(node)) {
        if (node.identifier) visit(node.identifier.position);
        node.inheritance?.forEach((ref) => walkPositions(ref, visit));
        node.elements.forEach((child) => walkPositions(child, visit));
    } else if (isAssignmentNode(node)) {
        visit(node.left.position);
        walkPositions(node.right, visit);
    } else if (isFunctionCallNode(node)) {
        node.arguments.forEach((argument) => walkPositions(argument, visit));
    } else if (isMathExpressionNode(node)) {
        node.elements.forEach((child) => walkPositions(child, visit));
    }
};

/**
 * The full span of a node, computed from the min start / max end of every descendant
 * position. {@link AstPosition} only records a single line per node, so a container's
 * own position doesn't cover its body, but the LSP requires a symbol's `range` to
 * enclose its `selectionRange` and ideally its children, so we derive the envelope.
 */
export const enclosingRange = (node: AbstractNode): Range => {
    let startLine = Infinity;
    let startChar = Infinity;
    let endLine = -Infinity;
    let endChar = -Infinity;
    const consider = (position: AstPosition) => {
        if (position.line < startLine || (position.line === startLine && position.characterStart < startChar)) {
            startLine = position.line;
            startChar = position.characterStart;
        }
        if (position.line > endLine || (position.line === endLine && position.characterEnd > endChar)) {
            endLine = position.line;
            endChar = position.characterEnd;
        }
    };
    walkPositions(node, consider);
    // No descendant carried a position (shouldn't happen for a real node): degenerate range.
    if (startLine === Infinity) return Range.create(0, 0, 0, 0);
    return Range.create(startLine, startChar, endLine, endChar);
};
