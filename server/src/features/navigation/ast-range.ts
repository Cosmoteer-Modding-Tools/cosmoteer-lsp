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
import { positionIn } from '../text-markup/markup-source';

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
const walkPositions = (node: AbstractNode | null | undefined, visit: (position: AstPosition) => void): void => {
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
 * Where an offset of a node really sits in the file.
 *
 * An {@link AstPosition} records one line and two columns, so a value carried across a line
 * continuation ends at a column counted from its first line, which is a column that line does not
 * have, and a verbatim string is stamped with the line it ends on while its start column belongs to
 * the line it began on. The absolute offsets are right in both cases, so the file's own text places
 * them whenever the caller holds it.
 *
 * @param offset the node's absolute offset.
 * @param fallback the line and column the position records, used when there is no text to count in.
 * @param source the file's text, when the caller holds it.
 * @returns the position to use.
 */
const placed = (
    offset: number,
    fallback: { line: number; character: number },
    source: string | undefined
): { line: number; character: number } =>
    source === undefined || offset < 0 || offset > source.length ? fallback : positionIn(source, offset);

/**
 * The full span of a node, computed from the min start / max end of every descendant
 * position. {@link AstPosition} only records a single line per node, so a container's
 * own position doesn't cover its body, but the LSP requires a symbol's `range` to
 * enclose its `selectionRange` and ideally its children, so we derive the envelope.
 *
 * @param node the node to span.
 * @param source the file's text, so a value that runs over several lines ends on the line it
 *     really ends on rather than past the end of its first one.
 * @returns the envelope covering the node and everything under it.
 */
export const enclosingRange = (node: AbstractNode, source?: string): Range => {
    let startLine = Infinity;
    let startChar = Infinity;
    let endLine = -Infinity;
    let endChar = -Infinity;
    const consider = (position: AstPosition) => {
        const from = placed(position.start, { line: position.line, character: position.characterStart }, source);
        const to = placed(position.end, { line: position.line, character: position.characterEnd }, source);
        if (from.line < startLine || (from.line === startLine && from.character < startChar)) {
            startLine = from.line;
            startChar = from.character;
        }
        if (to.line > endLine || (to.line === endLine && to.character > endChar)) {
            endLine = to.line;
            endChar = to.character;
        }
    };
    walkPositions(node, consider);
    // No descendant carried a position (shouldn't happen for a real node): degenerate range.
    if (startLine === Infinity) return Range.create(0, 0, 0, 0);
    return Range.create(startLine, startChar, endLine, endChar);
};
