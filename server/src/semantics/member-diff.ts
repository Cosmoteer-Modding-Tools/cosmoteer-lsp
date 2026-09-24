import {
    AbstractNode,
    isAssignmentNode,
    isExpressionNode,
    isFunctionCallNode,
    isGroupNode,
    isIdentifierNode,
    isListNode,
    isMathExpressionNode,
    isValueNode,
} from '../core/ast/ast';

/**
 * Comparing one written declaration against another, for the reports that answer "what does this
 * change".
 *
 * The comparison is structural rather than textual. Two declarations that differ only in
 * indentation, in where their comments sit or in the order their group writes its members are the
 * same declaration to the game: `stepIntoNode` indexes numerically into lists and inheritance lists
 * only, so a group's member order is not addressable and cannot be depended on. A list's order is
 * addressable, so its entries are compared in the order they are written.
 *
 * What the signature deliberately does not do is resolve anything. A value written as a reference
 * and a literal that reference works out to are different declarations here, because they are
 * different declarations in the file, and a report that folded them together would be answering a
 * question about arithmetic rather than about what the mod writes.
 */

/**
 * The structural signature of a declaration, which two declarations are equal by.
 *
 * @param node the value node, or null for a member written with no value.
 * @returns the signature text.
 */
export const signatureOf = (node: AbstractNode | null | undefined): string => {
    if (!node) return '~';
    if (isValueNode(node)) return `v:${node.valueType.type}:${String(node.valueType.value)}`;
    if (isIdentifierNode(node)) return `i:${node.name.toLowerCase()}`;
    if (isAssignmentNode(node)) {
        return `${node.left.name.toLowerCase()}${node.assignmentType === 'Colon' ? ':' : '='}${signatureOf(node.right)}`;
    }
    if (isGroupNode(node)) {
        // A group's members are addressed by name, so the order they are written in decides nothing
        // and two groups writing the same members in a different order are the same group.
        const members = node.elements.map(signatureOf).sort();
        return `g${basesOf(node)}{${members.join(' ')}}`;
    }
    if (isListNode(node)) return `l${basesOf(node)}[${node.elements.map(signatureOf).join(' ')}]`;
    if (isFunctionCallNode(node)) return `${node.name.toLowerCase()}(${node.arguments.map(signatureOf).join(',')})`;
    if (isMathExpressionNode(node)) return `m(${node.elements.map(signatureOf).join('')})`;
    if (isExpressionNode(node)) return node.expressionType;
    return `?${node.type}`;
};

/**
 * The signature of a container's inheritance list, which is part of what the container declares:
 * the same members written over a different base are a different declaration.
 *
 * @param node the group or list.
 * @returns the signature text, empty when the container inherits nothing.
 */
const basesOf = (node: AbstractNode & { inheritance?: readonly AbstractNode[] }): string =>
    node.inheritance && node.inheritance.length > 0 ? `:${node.inheritance.map(signatureOf).join(',')}` : '';

/**
 * Whether two declarations are the same one.
 *
 * @param theirs one declaration.
 * @param mine the other.
 * @returns true when neither writes anything the other does not.
 */
export const declarationsMatch = (theirs: AbstractNode | null, mine: AbstractNode | null): boolean =>
    signatureOf(theirs) === signatureOf(mine);
