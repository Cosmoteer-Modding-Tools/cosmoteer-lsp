import { AbstractNode, isGroupNode, isValueNode, ValueNode } from '../core/ast/ast';
import { namedMembersOf } from '../utils/ast.utils';

/** How deep a chain of override sources is followed, which is more than a manifest ever writes. */
export const MAX_OVERRIDE_DEPTH = 4;

/**
 * The members an `Overrides` source supplies: an inline `{}` group's members, or whatever a
 * `&<file>[/Group]` reference dereferences to. A group that names a base carries what the base
 * supplies as well, which is the form a mod uses to add a handful of entries to a table of its own
 * (`Overrides : &<its file> { one more }`). The game merges the two before it reads the pairs, so
 * both halves are members of the override, the group's own declarations winning by name.
 *
 * @param source the action's source value.
 * @param referencedMembers the members a reference source dereferences to, resolved by the caller.
 * @param depth how many bases have been followed already.
 * @returns the merged members as `[name, node]` pairs, nearest declaration first.
 */
export const overrideMembersOf = async (
    source: AbstractNode,
    referencedMembers: (reference: ValueNode) => Promise<[string, AbstractNode][]>,
    depth = 0
): Promise<[string, AbstractNode][]> => {
    if (isGroupNode(source)) {
        const own = namedMembersOf(source);
        const bases = source.inheritance ?? [];
        if (bases.length === 0 || depth >= MAX_OVERRIDE_DEPTH) return own;
        const seen = new Set(own.map(([name]) => name.toLowerCase()));
        const merged = [...own];
        for (const base of bases) {
            for (const [name, node] of await overrideMembersOf(base, referencedMembers, depth + 1)) {
                if (seen.has(name.toLowerCase())) continue;
                seen.add(name.toLowerCase());
                merged.push([name, node]);
            }
        }
        return merged;
    }
    if (isValueNode(source) && source.valueType.type === 'Reference') return await referencedMembers(source);
    return [];
};
