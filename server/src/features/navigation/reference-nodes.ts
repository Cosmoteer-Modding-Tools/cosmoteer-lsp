/**
 * The plain syntax-tree walks every reference-shaped feature needs: where a relative reference
 * resolves from, what a bare `&…` list element stands for, and every reference value a document
 * writes. They read the tree alone, so they live apart from the index that searches with them and
 * from the id symbols that do the same walk.
 */

import {
    AbstractNode,
    ValueNode,
    isAssignmentNode,
    isDocumentNode,
    isFunctionCallNode,
    isGroupNode,
    isIdentifierNode,
    isListNode,
    isMathExpressionNode,
    isValueNode,
} from '../../core/ast/ast';

/**
 * A key for the scope an OT relative reference resolves against: its nearest enclosing group or
 * list (or the document root). Two references with the same text under the same container resolve
 * to the same target, so this keys the per-document resolution memo of every reference search.
 *
 * @param node the reference node whose resolution scope is wanted.
 * @returns the enclosing container's start offset, or 'root' at document level.
 */
export const enclosingContainerKey = (node: AbstractNode): string => {
    let current: AbstractNode | undefined = node.parent;
    while (current && !(isGroupNode(current) || isListNode(current))) current = current.parent;
    return current?.position ? String(current.position.start) : 'root';
};

/**
 * The reference value a bare `&…` list element stands for (`&/PARTICLES/Foo` inside `MediaEffects
 * [ … ]`).
 *
 * The parser gives such an element an IdentifierNode rather than a ValueNode whenever the preceding
 * sibling is not a value, which is what happens right after a `}`. The game reads it as a reference
 * all the same, so every reference-shaped feature has to see one. The wrap carries the identifier's
 * own parent and position, so the scope it resolves in and the range it reports are the written
 * element's.
 *
 * @param node the node to inspect.
 * @returns the reference value it stands for, or null when it is not a bare list reference.
 */
export const standaloneReferenceValue = (node: AbstractNode | null | undefined): ValueNode | null => {
    if (!isIdentifierNode(node) || typeof node.name !== 'string' || !node.name.startsWith('&')) return null;
    const parent = node.parent;
    if (!parent || !isListNode(parent) || !parent.elements.includes(node)) return null;
    return {
        type: 'Value',
        valueType: { type: 'Reference', value: node.name },
        parent,
        position: node.position,
    };
};

/** Every reference value node in a document, depth-first across all node shapes. */
export function* referenceNodesOf(node: AbstractNode | null | undefined): Generator<ValueNode> {
    // A document parsed with errors can have null slots (e.g. `Key =` with no value →
    // `right: null`, or a missing list element). Skip them instead of crashing the search.
    if (!node) return;
    if (isGroupNode(node) || isListNode(node)) {
        for (const ref of node.inheritance ?? []) yield* referenceNodesOf(ref);
        for (const child of node.elements) yield* referenceNodesOf(child);
    } else if (isDocumentNode(node)) {
        for (const child of node.elements) yield* referenceNodesOf(child);
    } else if (isAssignmentNode(node)) {
        yield* referenceNodesOf(node.right);
    } else if (isFunctionCallNode(node)) {
        for (const argument of node.arguments) yield* referenceNodesOf(argument);
    } else if (isMathExpressionNode(node)) {
        for (const element of node.elements) yield* referenceNodesOf(element);
    } else if (isValueNode(node) && node.valueType.type === 'Reference') {
        yield node;
    } else {
        const standalone = standaloneReferenceValue(node);
        if (standalone) yield standalone;
    }
}
