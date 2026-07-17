import { CancellationToken } from 'vscode-languageserver';
import { isGroupNode, isListNode, isValueNode, ValueNode } from '../../core/ast/ast';
import { AutoCompletion } from './autocompletion.service';
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

/**
 * A quoted value node that is a reference and is therefore worth offering reference-path completions for.
 */
export class AutoCompletionReference implements AutoCompletion<ValueNode> {
    public async getCompletions(
        node: ValueNode,
        cancellationToken: CancellationToken,
        cursorOffset?: number
    ): Promise<string[]> {
        if (isValueNode(node) && node.valueType.type === 'Reference') {
            return await referenceAutoCompletionStrategy
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
        }
        // A lone `&`, the moment the user starts a reference, is lexed as a string rather than a
        // reference. Offer the reference-start prefixes (including `&^/N/` caret paths) here so the
        // suggestions appear right away instead of only once a full reference token has formed.
        if (isValueNode(node) && node.valueType.type === 'String' && node.valueType.value === '&') {
            return referenceAutoCompletionStrategy.completeReferenceStart(node);
        }
        return [];
    }
}
