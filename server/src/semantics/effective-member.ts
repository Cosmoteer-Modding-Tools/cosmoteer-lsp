import { CancellationToken } from 'vscode-languageserver';
import { AbstractNode, GroupNode } from '../core/ast/ast';
import { FullNavigationStrategy } from '../features/navigation/full.navigation-strategy';
import { childNamed } from '../features/part-editor/vector-forms';
import { findMemberThroughInheritance, ResolveReferenceFn } from './inheritance-resolver';

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
