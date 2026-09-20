import { AbstractNode, GroupNode, descendants, isAssignmentNode, isGroupNode } from '../../core/ast/ast';
import { resolveGroupClass } from '../../document/schema/schema-context';

/**
 * The part component dictionary, as the two cycle checks both need to read it.
 *
 * A component naming another component by id is resolved against the part's own `Components` map,
 * and a chain of such names is a graph the engine walks with no visited set on either the reading
 * side or the running side. Two checks look for a closed walk in that graph, over different edges,
 * so finding the map and reading a member out of it lives here rather than in each of them.
 */

/** The class whose `Components` group is the dictionary every id is resolved against. */
export const PART_RULES_CLASS = 'Cosmoteer.Ships.Parts.PartRules';

/** The member of a part holding the components the game registers by id. */
const COMPONENTS = 'components';

/**
 * The member written under `name` in a group, in both spellings the format allows.
 *
 * @param group the group to read.
 * @param name the member name, folded to lower case.
 * @returns the member's value, or undefined when the group does not write it.
 */
export const memberOf = (group: GroupNode, name: string): AbstractNode | undefined => {
    for (const element of group.elements) {
        if (isAssignmentNode(element) && element.left.name.toLowerCase() === name) return element.right ?? undefined;
        if (isGroupNode(element) && element.identifier?.name.toLowerCase() === name) return element;
    }
    return undefined;
};

/**
 * Every group a part writes its registered components into, which is the `Components` member of a
 * group the schema types as a part. A `Components` nested inside a toggled set is not one of them,
 * since the game reads those into a list of their own rather than into the part's dictionary.
 *
 * @param node the node to walk.
 * @returns a generator of the part-level component groups found under it.
 */
export function* partComponentGroupsIn(node: AbstractNode): Generator<GroupNode> {
    for (const candidate of descendants(node)) {
        if (!isGroupNode(candidate) || resolveGroupClass(candidate) !== PART_RULES_CLASS) continue;
        const components = memberOf(candidate, COMPONENTS);
        if (components && isGroupNode(components)) yield components;
    }
}
