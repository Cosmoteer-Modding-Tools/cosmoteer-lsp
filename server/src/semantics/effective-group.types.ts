/**
 * The result of flattening a container the way the game does: where each effective member or entry
 * came from, which declarations it shadows, and every base the walk could not read. The walk itself
 * lives in `effective-group.ts`.
 */

import { AbstractNode } from '../core/ast/ast';

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
    /** True when a mod's manifest merged this declaration in rather than the file writing it. Such a
     *  declaration sits at hop 0 while living in another file, so `inherited` cannot stand for it. */
    readonly injected?: boolean;
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
