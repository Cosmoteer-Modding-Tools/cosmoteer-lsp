import { CancellationToken, Range } from 'vscode-languageserver';
import { isGroupNode, isListNode, isValueNode, ValueNode } from '../../core/ast/ast';
import { AutoCompletion, Completion } from './autocompletion.service';
import { ReferenceAutoCompletionStrategy } from './strategy/reference.autocompletion-strategy';

const referenceAutoCompletionStrategy = new ReferenceAutoCompletionStrategy();

/**
 * True if `node` is one of its parent group/list's inheritance references (the value after the
 * `:` of `Child : Parent`), whose relative lookups resolve against the group's container.
 */
const isInheritanceReference = (node: ValueNode): boolean =>
    !!node.parent &&
    (isGroupNode(node.parent) || isListNode(node.parent)) &&
    !!node.parent.inheritance?.includes(node);

/**
 * The reference value text up to the cursor, or undefined when the cursor is not inside the value (so
 * the whole value is used). An unquoted reference's value text begins at its node start, so the cursor
 * offset maps directly into the value string; the result is clamped to the value's bounds.
 *
 * @param node the reference value node.
 * @param cursorOffset the document offset of the cursor, when known.
 * @returns the value substring up to the cursor, or undefined to complete the whole value.
 */
const referenceValueUpToCursor = (node: ValueNode, cursorOffset?: number): string | undefined => {
    if (cursorOffset === undefined || node.position === undefined) return undefined;
    const value = String(node.valueType.value);
    const indexInValue = cursorOffset - node.position.start;
    if (indexInValue < 0 || indexInValue >= value.length) return undefined;
    return value.slice(0, indexInValue);
};

/** The characters that close a reference path segment. `&` opens the reference, `<` and `>` bracket a
 *  file path and `/` joins the segments, so the segment being edited starts after the last of them. */
const SEGMENT_BOUNDARIES = '&<>/';

/**
 * The range a reference completion replaces. The strategy answers with leaf segments (`a.rules>`,
 * `ToB`, `parts/`), so the range must cover the segment the cursor sits in and nothing of the path
 * before it. Left to itself the client measures the range with its own word pattern, which breaks at
 * `.`, so accepting `a.rules>` over a typed `a.ru` writes `a.a.rules>`. A reference token never spans
 * lines, so the value's line and start column place the cursor exactly.
 *
 * @param node the value node the reference is typed on.
 * @param cursorOffset the document offset of the cursor, when known.
 * @param wholeValue true to cover the whole typed value instead of its last segment, for the
 * reference-start prefixes, whose labels carry the `&` themselves.
 * @returns the range to replace, or undefined when the cursor is not inside the value, which leaves
 * the client its own measurement.
 */
const referenceReplaceRange = (node: ValueNode, cursorOffset?: number, wholeValue = false): Range | undefined => {
    if (cursorOffset === undefined || node.position === undefined) return undefined;
    const value = String(node.valueType.value);
    const typedLength = cursorOffset - node.position.start;
    if (typedLength < 0 || typedLength > value.length) return undefined;
    const typed = value.slice(0, typedLength);
    let segmentStart = wholeValue ? 0 : typed.length;
    while (segmentStart > 0 && !SEGMENT_BOUNDARIES.includes(typed[segmentStart - 1])) segmentStart--;
    const cursorCharacter = node.position.characterStart + typedLength;
    return {
        start: { line: node.position.line, character: cursorCharacter - (typed.length - segmentStart) },
        end: { line: node.position.line, character: cursorCharacter },
    };
};

/**
 * Tags leaf-segment labels with the range they replace.
 *
 * @param labels the labels the strategy answered with.
 * @param range the replace range, or undefined to leave the client its own.
 * @returns the completions to offer.
 */
const withSegmentRange = (labels: string[], range: Range | undefined): Completion[] =>
    range ? labels.map((label) => ({ label, range })) : labels;

/**
 * A quoted value node that is a reference and is therefore worth offering reference-path completions for.
 */
export class AutoCompletionReference implements AutoCompletion<ValueNode> {
    public async getCompletions(
        node: ValueNode,
        cancellationToken: CancellationToken,
        cursorOffset?: number
    ): Promise<Completion[]> {
        if (isValueNode(node) && node.valueType.type === 'Reference') {
            const labels = await referenceAutoCompletionStrategy
                .complete({
                    node,
                    isInheritanceNode: isInheritanceReference(node),
                    cancellationToken,
                    // Complete the path only up to the cursor, so editing a middle segment offers that
                    // segment's members instead of resolving the whole written path (which, if a later
                    // segment is wrong, would offer the same stale suggestion at every position).
                    valueUpToCursor: referenceValueUpToCursor(node, cursorOffset),
                })
                .catch(() => []);
            return withSegmentRange(labels, referenceReplaceRange(node, cursorOffset));
        }
        // A lone `&`, the moment the user starts a reference, is lexed as a string rather than a
        // reference. Offer the reference-start prefixes (including `&^/N/` caret paths) here so the
        // suggestions appear right away instead of only once a full reference token has formed.
        if (isValueNode(node) && node.valueType.type === 'String' && node.valueType.value === '&') {
            // These labels spell out the `&` themselves, so the range covers the typed one. A segment
            // range would stop after it and produce `&&<./Data/`.
            return withSegmentRange(
                referenceAutoCompletionStrategy.completeReferenceStart(node),
                referenceReplaceRange(node, cursorOffset, true)
            );
        }
        return [];
    }
}
