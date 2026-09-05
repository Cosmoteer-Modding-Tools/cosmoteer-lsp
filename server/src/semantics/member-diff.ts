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
import { EffectiveMemberEntry } from './effective-group.types';

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

/** What a member does to the declaration it is compared against. */
export type DiffVerdict =
    | /** The other side writes no member under this name. */ 'added'
    | /** Both write the name, with declarations that differ. */ 'changed'
    | /** Both write the name, with the same declaration. */ 'identical'
    | /** Only the other side writes the name. */ 'removed';

/** One member, as the two sides write it. */
export interface MemberDiffRow {
    /** The name as written on whichever side writes it. */
    readonly name: string;
    /** The declaration being compared against, null when that side does not write the name. */
    readonly theirs: AbstractNode | null;
    /** The declaration being judged, null when this side does not write the name. */
    readonly mine: AbstractNode | null;
    readonly verdict: DiffVerdict;
}

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

/**
 * Compares two flattened member sets, name by name.
 *
 * Names are matched case-insensitively, the way the game matches them. The rows come out in the
 * order the judged side writes them, with the names only the other side writes after them, so a
 * reader following the file from the top reads the table in the same order.
 *
 * @param theirs the member set being compared against.
 * @param mine the member set being judged.
 * @returns one row per name either side writes.
 */
export const diffMemberSets = (
    theirs: readonly EffectiveMemberEntry[],
    mine: readonly EffectiveMemberEntry[]
): MemberDiffRow[] => {
    const theirsByName = new Map<string, EffectiveMemberEntry>();
    for (const member of theirs) theirsByName.set(member.name.toLowerCase(), member);

    const rows: MemberDiffRow[] = [];
    const seen = new Set<string>();
    for (const member of mine) {
        const key = member.name.toLowerCase();
        seen.add(key);
        const other = theirsByName.get(key);
        rows.push({
            name: member.name,
            theirs: other?.value ?? null,
            mine: member.value,
            verdict: !other ? 'added' : declarationsMatch(other.value, member.value) ? 'identical' : 'changed',
        });
    }
    for (const member of theirs) {
        const key = member.name.toLowerCase();
        if (seen.has(key)) continue;
        rows.push({ name: member.name, theirs: member.value, mine: null, verdict: 'removed' });
    }
    return rows;
};
