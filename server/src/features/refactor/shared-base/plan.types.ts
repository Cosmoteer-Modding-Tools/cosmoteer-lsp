/**
 * The working form of an extraction plan, which holds the records the analysis derived from the AST.
 * The JSON-safe form that crosses the client boundary is shared with the clients, in
 * shared/shared-base.types.ts.
 */

import { BaseLocation, ExtractionTier, SerializedPlan } from '../../../../../shared/shared-base.types';

/**
 * One top-level member of a container, carrying the exact source span a rewrite deletes and the
 * normalized text two containers are compared by. An AssignmentNode has no position of its own and a
 * container's `position.start` is its `{`, not its name, so the span is derived rather than read off
 * the node (see `memberSpanOf`).
 *
 * Deliberately holds no AST node: a record outlives the pass that produced it (the analysis is
 * memoized per directory), and a node keeps its whole document's AST alive with it.
 */
export interface MemberRecord {
    /** The member name folded to lower case, the identity the game itself matches by. */
    key: string;
    /** The name as the file spells it, used when the member is written into the base file. */
    name: string;
    /** Byte offset of the member's first character (its name). */
    start: number;
    /** Byte offset one past the member's last character. */
    end: number;
    /** The raw source slice `[start, end)`, the text the base file receives. */
    raw: string;
    /** {@link raw} with paths, indentation and separators normalized, the equality key across files. */
    norm: string;
    /** Zero-based line the member starts on. */
    line: number;
    /**
     * The whitespace the member's own line begins with. The span starts at the name, so the first
     * line of {@link raw} carries no indentation while its continuation lines carry this one, which
     * is what a rewrite strips before indenting the member to its depth in the base file.
     */
    indent: string;
}

/** A container that can take part in an extraction, described without holding its AST. */
export interface Participant {
    /** The canonical uri of the file the container lives in. */
    uri: string;
    /** The on-disk path of that file, in its real spelling (never a case-folded key). */
    fsPath: string;
    /** The schema class the container resolves to. Every participant of a plan shares it. */
    className: string;
    /** The container's own name, which it keeps: only the base it inherits from changes. */
    groupName: string;
    /** Byte offset of the container's name, its stable identity inside the file. */
    nameStart: number;
    /** Byte offset one past the container's name, where an inheritance list is inserted. */
    nameEnd: number;
    /** The container's single inheritance reference as written, absent when it inherits nothing. */
    inheritanceRef?: string;
    /** Byte span of that reference, the text an extraction replaces. */
    inheritanceStart?: number;
    inheritanceEnd?: number;
    /** The container's extractable members, keyed by {@link MemberRecord.key}. */
    members: Map<string, MemberRecord>;
}

/** A ready-to-apply extraction: the members to move, who they move away from, and where they go. */
export interface ExtractionPlan {
    /** Stable content hash of the participants and fields, so a plan survives a client round trip. */
    id: string;
    tier: ExtractionTier;
    /** The schema class every participant resolves to. */
    className: string;
    /** The name the extracted group gets in the base file, taken from the donor. */
    groupName: string;
    /** The extracted member keys, in the donor's document order. */
    fields: string[];
    participants: Participant[];
    /** The participant whose spelling of every field the base file receives. */
    donor: Participant;
    /**
     * The on-disk path of the base file: the one that will be created, or, for an `existingBase`
     * plan, the one that already exists and is being added to.
     */
    baseFsPath: string;
    /**
     * The inheritance reference the base file itself declares, already rebased to the base file's
     * own directory. Absent for a `cloneFamily` plan, where nothing was inherited to carry over, and
     * for an `existingBase` plan, which writes no new file.
     */
    inheritedRef?: string;
    /** The absolute identity of the base every participant inherits, absent for a clone family. */
    baseIdentity?: string;
    /** The group inside the existing base file the members move onto, only on an `existingBase` plan. */
    existingBase?: BaseLocation;
    /** Source bytes the rewrite removes across all participants, the ranking key. */
    savedBytes: number;
}

/**
 * Reduce a plan to the JSON-safe shape the client receives, keeping only what the apply step needs
 * to find the same containers again.
 *
 * @param plan the plan to serialize.
 * @param label the human-readable description for the client's picker.
 * @returns the serializable plan.
 */
export const serializePlan = (plan: ExtractionPlan, label: string): SerializedPlan => ({
    id: plan.id,
    tier: plan.tier,
    className: plan.className,
    groupName: plan.groupName,
    fields: [...plan.fields],
    participants: plan.participants.map((participant) => ({
        uri: participant.uri,
        fsPath: participant.fsPath,
        offset: participant.nameStart,
    })),
    donor: { uri: plan.donor.uri, fsPath: plan.donor.fsPath, offset: plan.donor.nameStart },
    baseFsPath: plan.baseFsPath,
    inheritedRef: plan.inheritedRef,
    existingBase: plan.existingBase
        ? { fsPath: plan.existingBase.fsPath, groupPath: [...plan.existingBase.groupPath] }
        : undefined,
    savedBytes: plan.savedBytes,
    label,
});
