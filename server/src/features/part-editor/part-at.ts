import { AbstractNode, AbstractNodeDocument, GroupNode, isGroupNode } from '../../core/ast/ast';
import { classAncestry } from '../../document/schema/schema';
import { findEnclosingGroup, resolveGroupClass } from '../../document/schema/schema-context';
import { PART_RULES_CLASS } from './part-fields';

/**
 * Whether a group resolves to a part, by its class or one of its bases.
 *
 * @param group the group.
 * @returns true for a part group.
 */
const isPartGroup = (group: GroupNode): boolean =>
    classAncestry(resolveGroupClass(group) ?? '').includes(PART_RULES_CLASS);

/**
 * The part group a diagram is built for: the nearest part enclosing the caret, else the part of a
 * one-part file, which is how parts are written and where a caret outside every group still means it.
 *
 * @param document the parsed document.
 * @param offset the caret's byte offset.
 * @returns the part group, or undefined when the caret is in none.
 */
export const partAt = (document: AbstractNodeDocument, offset: number): GroupNode | undefined => {
    for (let group: AbstractNode | undefined = findEnclosingGroup(document, offset); group; group = group.parent) {
        if (isGroupNode(group) && isPartGroup(group)) return group;
    }
    return document.elements.find((element): element is GroupNode => isGroupNode(element) && isPartGroup(element));
};
