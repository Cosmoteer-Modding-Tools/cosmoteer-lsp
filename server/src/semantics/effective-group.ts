import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    GroupNode,
    ListNode,
    ValueNode,
    isAssignmentNode,
    isDocumentNode,
    isGroupNode,
    isListNode,
} from '../core/ast/ast';
import { getStartOfAstNode } from '../utils/ast.utils';
import { FileTree, FileWithPath, isFile } from '../workspace/cosmoteer-workspace.service';
import { getParsedFileDocument } from '../workspace/parsed-file-cache';
import { resolveReference } from './effective-member';
import { inheritanceEntriesOf, injectedMembersOf, memberNameOf, memberValueOf } from './reference-resolver';

/**
 * Flattening a container the way the game does, for the whole member set at once.
 *
 * `findMemberThroughInheritance` answers one name at a time and stops at the first hit, which is all
 * a reference path needs. Nothing enumerated. This module adds the two operations the game performs
 * that a per-name lookup cannot express, both read out of `Halfling.ObjectText` in HalflingCore.dll:
 *
 * - `OTGroupNode.GetEnumerableIncludingInherited` yields each base's members first (recursively, in
 *   the order the bases are written), skipping every name the level below already declares, then the
 *   local members. So a local declaration shadows an inherited one, and the effective order puts
 *   surviving inherited members ahead of local ones.
 * - `OTListNode.GetEnumerableIncludingInherited` prepends the entries of every inherited list, but
 *   `GetInheritedLists` returns nothing at all when the list carries no inheritance list of its own.
 *   A plain `X [ A B ]` in a deriving group therefore replaces the base's `X` outright, while
 *   `X : ^/0/X [ C ]` yields `A B C`. That distinction is what makes an effective list decidable,
 *   and it is why the existing validators, which treat every list as undecidable, are stricter than
 *   they need to be rather than wrong.
 *
 * Where the game throws, this reports. `GetInheritedGroups` raises `OTNavigateException` when a base
 * cannot be resolved and when it resolves to the wrong kind of node, and self-inheritance raises
 * `InvalidOperationException`. The load fails outright. A language server cannot fail, and half a
 * chain silently presented as the whole answer is how a view starts lying, so every base that could
 * not be read is collected in {@link EffectiveContainer.unreadable} and callers that need certainty
 * gate on {@link EffectiveContainer.complete}.
 */

/** Why a base could not be folded in. */
export type UnreadableReason =
    | /** The inheritance reference resolved to nothing. */ 'unresolved'
    | /** The reference is one this server deliberately does not resolve (`~` roots, `:` segments). */ 'unresolvable-form'
    | /** The base resolved, but to a node of the wrong kind (the game rejects this outright). */ 'wrong-kind'
    | /** The base is already on the walk's stack, which the game treats as a load failure. */ 'cycle'
    | /** The walk was cancelled before this base was read. */ 'cancelled';

/** A base the walk could not fold in, with the reference that named it. */
export interface UnreadableBase {
    /** The reference text as written, for the message. */
    readonly reference: string;
    readonly reason: UnreadableReason;
    /** The inheritance reference node, so a diagnostic or a report row can anchor on it. */
    readonly node: AbstractNode;
    /** How many hops from the starting container this base sits at. */
    readonly hop: number;
}

/** Where a value came from. */
export interface MemberOrigin {
    /** The file declaring it. */
    readonly uri: string;
    /** The declaring element, for the range. */
    readonly node: AbstractNode;
    /** 0 for the starting container, 1 for its own base, and so on. */
    readonly hop: number;
    /** True for anything found past hop 0. */
    readonly inherited: boolean;
}

/** One member of the flattened container. */
export interface EffectiveMemberEntry {
    /** The name as written where the winning declaration lives. */
    readonly name: string;
    /** The member's value node, null for an assignment with no value yet. */
    readonly value: AbstractNode | null;
    /** Where the winning declaration lives. */
    readonly origin: MemberOrigin;
    /** The declarations this one hides, nearest first. Empty for most members. */
    readonly shadows: readonly MemberOrigin[];
}

/** One entry of a flattened list. */
export interface EffectiveListEntry {
    readonly value: AbstractNode;
    readonly origin: MemberOrigin;
}

/** What a walk found, and what it could not read. */
export interface EffectiveContainer {
    /** Every base actually folded in, nearest first, excluding the starting container. */
    readonly bases: readonly MemberOrigin[];
    /** Bases that could not be folded in. Empty when the whole chain resolved. */
    readonly unreadable: readonly UnreadableBase[];
    /** True when nothing was skipped: only then does the result describe the whole chain. */
    readonly complete: boolean;
}

/** A flattened group: its effective members in the game's own order. */
export interface EffectiveGroup extends EffectiveContainer {
    /** Surviving inherited members first (farthest base first), then the local ones. */
    readonly members: readonly EffectiveMemberEntry[];
}

/** A flattened list: the concatenation the game builds. */
export interface EffectiveList extends EffectiveContainer {
    /** Inherited entries first, then the local ones. */
    readonly entries: readonly EffectiveListEntry[];
    /** False when the list declares no inheritance, so `entries` is just its own. */
    readonly inherits: boolean;
}

/** A container this module can flatten. */
export type FlattenableContainer = GroupNode | ListNode | AbstractNodeDocument;

/**
 * The bases of a container, resolved one hop.
 *
 * @param container the container whose inheritance list to resolve.
 * @param hop the container's own distance from the walk's start, used to stamp the results.
 * @param token cancels reference resolution.
 * @returns the resolved bases in written order, and every base that could not be read.
 */
const basesOf = async (
    container: FlattenableContainer,
    hop: number,
    token: CancellationToken
): Promise<{ bases: Array<{ node: FlattenableContainer; ref: AbstractNode }>; unreadable: UnreadableBase[] }> => {
    const bases: Array<{ node: FlattenableContainer; ref: AbstractNode }> = [];
    const unreadable: UnreadableBase[] = [];
    // A document root has no inheritance list of its own: a whole-file base is the end of the chain.
    if (isDocumentNode(container)) return { bases, unreadable };

    for (const entry of inheritanceEntriesOf(container)) {
        const reference = referenceTextOf(entry);
        if (token.isCancellationRequested) {
            unreadable.push({ reference, reason: 'cancelled', node: entry, hop: hop + 1 });
            continue;
        }
        // An `AddBase`-appended base is already a resolved node rather than a reference to follow.
        if (isGroupNode(entry) || isListNode(entry)) {
            bases.push({ node: entry, ref: entry });
            continue;
        }
        if (!isReferenceEntry(entry)) {
            unreadable.push({ reference, reason: 'unresolvable-form', node: entry, hop: hop + 1 });
            continue;
        }
        const resolved = await resolveReference(
            entry.valueType.value,
            entry,
            getStartOfAstNode(container).uri,
            token
        ).catch(() => null);
        if (!resolved) {
            unreadable.push({ reference, reason: 'unresolved', node: entry, hop: hop + 1 });
            continue;
        }
        // A whole-file base (`Comp : <shot.rules>`) resolves to a File, whose members are the parsed
        // document's root-level fields.
        if (isFile(resolved as unknown as FileTree)) {
            const document = await getParsedFileDocument(resolved as unknown as FileWithPath).catch(() => null);
            if (!document) {
                unreadable.push({ reference, reason: 'unresolved', node: entry, hop: hop + 1 });
                continue;
            }
            bases.push({ node: document, ref: entry });
            continue;
        }
        const node = resolved as AbstractNode;
        if (!isGroupNode(node) && !isListNode(node) && !isDocumentNode(node)) {
            // The game throws here rather than reading the node: a group may only inherit a group.
            unreadable.push({ reference, reason: 'wrong-kind', node: entry, hop: hop + 1 });
            continue;
        }
        bases.push({ node, ref: entry });
    }
    return { bases, unreadable };
};

/** Whether an inheritance entry is a reference this module can follow. */
const isReferenceEntry = (entry: AbstractNode): entry is ValueNode & { valueType: { type: 'Reference'; value: string } } =>
    (entry as ValueNode).valueType?.type === 'Reference';

/** The written text of an inheritance entry, for messages. */
const referenceTextOf = (entry: AbstractNode): string => {
    const value = (entry as ValueNode).valueType;
    return value && typeof value.value === 'string' ? value.value : '<base>';
};

/**
 * The origin stamp of a node found at a given hop.
 *
 * An `AssignmentNode` carries no position of its own, so the anchor falls back to the name it
 * assigns, which is where a reader would point anyway.
 *
 * @param node the declaring node.
 * @param hop its distance from the walk's start.
 * @returns the stamp, anchored on a node that has a position.
 */
const originOf = (node: AbstractNode, hop: number): MemberOrigin => ({
    uri: getStartOfAstNode(node).uri,
    node: node.position ? node : (isAssignmentNode(node) ? node.left : node),
    hop,
    inherited: hop > 0,
});

/**
 * Flattens a group into the member set the game deserializes.
 *
 * Mirrors `OTGroupNode.GetEnumerableIncludingInherited`: each base contributes its own flattened
 * members first, minus every name the deriving level declares, and the deriving level's members
 * follow. Shadowed declarations are not dropped, they are recorded on the member that hides them, so
 * a view can show what an override replaced.
 *
 * @param group the group (or document root) to flatten.
 * @param token cancels the cross-file walk.
 * @returns the effective members with their provenance, plus whatever could not be read.
 */
export const flattenGroup = async (
    group: FlattenableContainer,
    token: CancellationToken
): Promise<EffectiveGroup> => {
    // One flattening per container per epoch. An edit to this file produces a new AST (new keys), and
    // an edit to a file the chain crosses bumps the epoch through the server's cross-file
    // invalidation. Without the memo, a view of a 61-field part with a three-link chain re-runs the
    // whole cross-file walk for every row it draws.
    const cached = flattenedGroups.get(group);
    if (cached && cached.epoch === chainEpoch) return cached.result;
    const epoch = chainEpoch;
    const result = flattenGroupAt(group, 0, token, new Set()).then((flattened) => {
        // A cancelled walk answers a partial chain. Serving that later would present an incomplete
        // fold as the whole truth, so drop it and let the next caller walk again.
        if (token.isCancellationRequested) flattenedGroups.delete(group);
        return flattened as EffectiveGroup;
    });
    flattenedGroups.set(group, { epoch, result });
    return result;
};

/** Per-AST memo of the flattened member set. */
const flattenedGroups: WeakMap<AbstractNode, { epoch: number; result: Promise<EffectiveGroup> }> = new WeakMap();

/** Cross-file edits change what a chain folds without changing this file's AST, so the memos carry
 *  an epoch the server bumps whenever another file may have changed. */
let chainEpoch = 0;

/** Starts a fresh memo epoch for the flattened containers after a cross-file change. */
export const invalidateEffectiveChainCache = (): void => {
    chainEpoch++;
};

/**
 * The recursive half of {@link flattenGroup}.
 *
 * @param group the container at this hop.
 * @param hop the container's distance from the walk's start.
 * @param token cancels the walk.
 * @param visited the containers already on the stack, the game's self-inheritance guard.
 * @returns this level's flattened view.
 */
const flattenGroupAt = async (
    group: FlattenableContainer,
    hop: number,
    token: CancellationToken,
    visited: Set<AbstractNode>
): Promise<{
    members: MutableMemberEntry[];
    bases: MemberOrigin[];
    unreadable: UnreadableBase[];
    complete: boolean;
}> => {
    const local = localMembersOf(group, hop);
    // First local declaration of a name wins, matching the container's own member table.
    const localByName = new Map<string, MutableMemberEntry>();
    for (const member of local) {
        const key = member.name.toLowerCase();
        if (!localByName.has(key)) localByName.set(key, member);
    }

    const { bases, unreadable } = await basesOf(group, hop, token);
    const foldedBases: MemberOrigin[] = [];
    const inheritedMembers: MutableMemberEntry[] = [];
    const seen = new Map<string, MutableMemberEntry>();

    visited.add(group);
    for (const base of bases) {
        if (visited.has(base.node)) {
            // The game raises "inherits from itself" and fails the load.
            unreadable.push({
                reference: referenceTextOf(base.ref),
                reason: 'cycle',
                node: base.ref,
                hop: hop + 1,
            });
            continue;
        }
        if (isListNode(base.node)) {
            // The game throws: a group may only inherit a group.
            unreadable.push({
                reference: referenceTextOf(base.ref),
                reason: 'wrong-kind',
                node: base.ref,
                hop: hop + 1,
            });
            continue;
        }
        foldedBases.push(originOf(base.node, hop + 1));
        const flattened = await flattenGroupAt(base.node, hop + 1, token, visited);
        foldedBases.push(...flattened.bases);
        unreadable.push(...flattened.unreadable);
        for (const member of flattened.members) {
            const key = member.name.toLowerCase();
            // The deriving level's own declaration hides this one entirely: the game does not yield
            // it. It is still recorded on the member that hides it, so a view can show the override.
            const shadowedByLocal = localByName.get(key);
            if (shadowedByLocal) {
                shadowedByLocal.shadows.push(member.origin, ...member.shadows);
                continue;
            }
            const earlier = seen.get(key);
            if (earlier) {
                // A later base declares a name an earlier base already supplied. The earlier base
                // wins (lookup takes the first hit), so this one is recorded as shadowed.
                earlier.shadows.push(member.origin, ...member.shadows);
                continue;
            }
            seen.set(key, member);
            inheritedMembers.push(member);
        }
    }
    visited.delete(group);

    return {
        members: [...inheritedMembers, ...local],
        bases: foldedBases,
        unreadable,
        complete: unreadable.length === 0,
    };
};

/** A member entry while it is still being built, before its shadow list is final. */
type MutableMemberEntry = Omit<EffectiveMemberEntry, 'shadows'> & { shadows: MemberOrigin[] };

/**
 * The members a container declares itself, in written order.
 *
 * @param container the container to read.
 * @param hop the container's distance from the walk's start.
 * @returns one entry per named element, anonymous elements skipped.
 */
const localMembersOf = (container: FlattenableContainer, hop: number): MutableMemberEntry[] => {
    const members: MutableMemberEntry[] = [];
    for (const element of container.elements) {
        const name = memberNameOf(element);
        if (name === undefined) continue;
        members.push({
            name,
            value: memberValueOf(element),
            origin: originOf(element, hop),
            shadows: [],
        });
    }
    // A member a mod's nested `Overrides` action merges into this node is one the game reads here,
    // even though this file never wrote it. `stepIntoNode` already resolves those by name. Without
    // them the enumeration would answer a member set the game does not have.
    const written = new Set(members.map((member) => member.name.toLowerCase()));
    for (const injected of injectedMembersOf(container)) {
        if (written.has(injected.name.toLowerCase())) continue;
        members.push({
            name: injected.name,
            value: memberValueOf(injected.value),
            origin: originOf(injected.value, hop),
            shadows: [],
        });
    }
    return members;
};

/**
 * Flattens a list into the entries the game iterates.
 *
 * A list merges only when it declares an inheritance reference of its own: `GetInheritedLists`
 * returns nothing for a list with no inheritance list, so `X [ A ]` in a deriving group replaces the
 * base's `X` rather than extending it. When the list does inherit, every inherited entry is yielded
 * before the local ones, which is why an index written against such a list shifts whenever a base
 * grows.
 *
 * @param list the list to flatten.
 * @param token cancels the cross-file walk.
 * @returns the effective entries with their provenance, plus whatever could not be read.
 */
export const flattenList = async (list: ListNode, token: CancellationToken): Promise<EffectiveList> =>
    flattenListAt(list, 0, token, new Set());

/**
 * The recursive half of {@link flattenList}.
 *
 * @param list the list at this hop.
 * @param hop the list's distance from the walk's start.
 * @param token cancels the walk.
 * @param visited the lists already on the stack.
 * @returns this level's flattened view.
 */
const flattenListAt = async (
    list: ListNode,
    hop: number,
    token: CancellationToken,
    visited: Set<AbstractNode>
): Promise<EffectiveList> => {
    const inherits = inheritanceEntriesOf(list).length > 0;
    const local: EffectiveListEntry[] = list.elements.map((element) => ({
        value: element,
        origin: originOf(element, hop),
    }));
    if (!inherits) {
        return { entries: local, bases: [], unreadable: [], complete: true, inherits: false };
    }

    const { bases, unreadable } = await basesOf(list, hop, token);
    const foldedBases: MemberOrigin[] = [];
    const inherited: EffectiveListEntry[] = [];

    visited.add(list);
    for (const base of bases) {
        if (visited.has(base.node)) {
            unreadable.push({
                reference: referenceTextOf(base.ref),
                reason: 'cycle',
                node: base.ref,
                hop: hop + 1,
            });
            continue;
        }
        if (!isListNode(base.node)) {
            // The game throws: a list may only inherit a list.
            unreadable.push({
                reference: referenceTextOf(base.ref),
                reason: 'wrong-kind',
                node: base.ref,
                hop: hop + 1,
            });
            continue;
        }
        foldedBases.push(originOf(base.node, hop + 1));
        const flattened = await flattenListAt(base.node, hop + 1, token, visited);
        foldedBases.push(...flattened.bases);
        unreadable.push(...flattened.unreadable);
        inherited.push(...flattened.entries);
    }
    visited.delete(list);

    return {
        entries: [...inherited, ...local],
        bases: foldedBases,
        unreadable,
        complete: unreadable.length === 0,
        inherits: true,
    };
};

/**
 * Flattens a named list member of a group, following the chain to wherever the list is declared.
 *
 * This is the read `ReceivableBuffs`-style fields need: the member itself may be declared several
 * hops up, and the local override may or may not inherit from it. Both questions are answered here,
 * and a caller that needs certainty checks `complete` before drawing a conclusion from the absence
 * of an entry.
 *
 * @param group the group holding the member.
 * @param name the member name.
 * @param token cancels the walk.
 * @returns the flattened list, or null when no such member exists anywhere in the chain.
 */
export const flattenListMember = async (
    group: GroupNode,
    name: string,
    token: CancellationToken
): Promise<EffectiveList | null> => {
    const flattened = await flattenGroup(group, token);
    const key = name.toLowerCase();
    const member = flattened.members.find((entry) => entry.name.toLowerCase() === key);
    if (!member || !member.value || !isListNode(member.value)) {
        // Not declared anywhere readable. Report the chain's own gaps so an absent member is never
        // mistaken for a member that is genuinely not there.
        return flattened.unreadable.length > 0
            ? {
                  entries: [],
                  bases: flattened.bases,
                  unreadable: flattened.unreadable,
                  complete: false,
                  inherits: false,
              }
            : null;
    }
    const list = await flattenList(member.value, token);
    // A member found through inheritance was reached across bases the group walk had to read, so its
    // gaps belong to this answer too.
    return {
        ...list,
        entries: list.entries,
        bases: [...flattened.bases, ...list.bases],
        unreadable: [...flattened.unreadable, ...list.unreadable],
        complete: flattened.complete && list.complete,
    };
};
