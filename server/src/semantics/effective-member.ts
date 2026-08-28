import { CancellationToken } from 'vscode-languageserver';
import { AbstractNode, AbstractNodeDocument, GroupNode, isDocumentNode, isGroupNode } from '../core/ast/ast';
import { FullNavigationStrategy } from '../features/navigation/full.navigation-strategy';
import { childNamed } from '../features/part-editor/vector-forms';
import { findMemberThroughInheritance, inheritanceBasesOf, ResolveReferenceFn } from './inheritance-resolver';

/**
 * Reading a member as the game would: the local declaration when there is one, otherwise the value
 * the group's inheritance chain supplies. Lifted out of the part grid editor so the hover lenses
 * read the same way, since the alternative in the tree (`inheritedMembersOf` in
 * `refactor/shared-base/inherited-value.ts`) resolves only `&<file>/path` bases and answers
 * undefined for the whole walk on a caret base, which is the form most vanilla files are written in.
 */

const navigation = new FullNavigationStrategy();

/** Adapts the shared navigation strategy to the inheritance resolver's reference-resolution shape. */
export const resolveReference: ResolveReferenceFn = (path, startNode, currentLocation, token, inheritanceVisited) =>
    navigation.navigate(
        path,
        startNode,
        currentLocation,
        token,
        new Set(),
        inheritanceVisited
    ) as ReturnType<ResolveReferenceFn>;

/** A member read that remembers whether it was found locally or through inheritance. */
export interface EffectiveMember {
    readonly node: AbstractNode;
    readonly inherited: boolean;
}

/**
 * Reads a member of a group, preferring the local declaration and falling back to the group's
 * inheritance chain.
 * @param group the group to read from.
 * @param name the member name.
 * @param token cancels reference resolution.
 * @returns the member's value node with its inheritance flag, or null when absent everywhere.
 */
export const effectiveMember = async (
    group: GroupNode,
    name: string,
    token: CancellationToken
): Promise<EffectiveMember | null> => {
    const local = childNamed(group, name);
    if (local) return { node: local, inherited: false };
    const inherited = await findMemberThroughInheritance(group, name, resolveReference, token).catch(() => null);
    return inherited ? { node: inherited, inherited: true } : null;
};

/** A named sub-group of a group, with the inheritance flag of where the declaration was found. */
export interface EffectiveSubGroup {
    readonly name: string;
    readonly group: GroupNode;
    readonly inherited: boolean;
}

/**
 * The named sub-groups of a group the way the game merges them: the group's own declarations plus
 * everything its inheritance chain contributes, the nearest declaration of a name winning. Parts
 * routinely gather their components from several files at once (`Components : ^/0/Components,
 * &<walls.rules>, &<floor.rules>`), and reading only the local elements sees none of them.
 * @param group the group to enumerate.
 * @param token cancels reference resolution.
 * @returns the sub-groups, local ones first, then each base's in declaration order.
 */
export const effectiveSubGroups = async (
    group: GroupNode,
    token: CancellationToken
): Promise<EffectiveSubGroup[]> => {
    const found = new Map<string, EffectiveSubGroup>();
    const visited = new Set<AbstractNode>();

    // A base is either a group or, for a whole-file base (`&<floor.rules>`), the file's document
    // root, whose top-level groups are the members it contributes.
    const collect = async (container: GroupNode | AbstractNodeDocument, inherited: boolean): Promise<void> => {
        if (visited.has(container)) return;
        visited.add(container);
        for (const element of container.elements) {
            if (!isGroupNode(element) || !element.identifier) continue;
            if (!found.has(element.identifier.name)) {
                found.set(element.identifier.name, { name: element.identifier.name, group: element, inherited });
            }
        }
        if (!isGroupNode(container)) return;
        for await (const base of inheritanceBasesOf(container, resolveReference, token, visited)) {
            if (isGroupNode(base) || isDocumentNode(base)) await collect(base, true);
        }
    };

    await collect(group, false).catch(() => undefined);
    return [...found.values()];
};
