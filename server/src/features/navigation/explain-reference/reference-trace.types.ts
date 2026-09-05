/**
 * The explanation of one reference path as the trace reports it: the verdict of the whole walk, one
 * hop per segment with what it landed on, and what the game would have found at the place the walk
 * stopped. The walk itself lives in `reference-trace.ts`.
 */

/** What the whole walk amounts to. */
export type ReferenceTraceVerdict =
    | /** Every hop resolved. */ 'resolved'
    | /** Only the mod's own additions supply it, which is how the game reads it inside that mod. */ 'resolved-via-mod'
    | /** A `~` path the file cannot answer, so the game answers it when the rule is instantiated. */ 'runtime-only'
    | /** A `:` path, answered by whichever inheritor is being built. */ 'virtual'
    | /** An inheritance reference whose base is there and simply does not declare the member, which
       *  the game allows. */ 'extends-missing-member'
    | /** A mod action target the action itself says may be missing. */ 'optional-target'
    | /** A segment of a kind the resolver does not model, so nothing is claimed about it. */ 'unmodelled-segment'
    | /** An alias chain that comes back to itself, which the game treats as a load failure. */ 'cycle'
    | /** A hop the game would not find either. */ 'broken'
    | /** The walk was stopped before it finished. */ 'cancelled';

/** What one segment of a path does. */
export type HopKind =
    | /** The `<…>` file token, resolved as one hop the way the game resolves it. */ 'file'
    | /** A named member. */ 'member'
    | /** A list position. */ 'index'
    | /** A base position, the `N` of a `^/N`. */ 'base'
    | /** `^`, the node's own base list. */ 'baseAnchor'
    | /** `..`, the containing node. */ 'parent'
    | /** `~`, the runtime root, approximated by the declaring file's root. */ 'runtimeRoot'
    | /** `:`, the most derived inheritor. */ 'virtual'
    | /** A segment the path grammar allows but the resolver has no rule for. */ 'unmodelled';

/** What a hop landed on. */
export type LandedKind = 'file' | 'document' | 'group' | 'list' | 'value' | 'other';

/** A place in the project, as a file and an optional line. */
export interface TracePlace {
    /** The file's uri or on-disk path, whichever the resolved node carries. */
    readonly uri: string;
    /** The zero-based line, absent when the place is a whole file. */
    readonly line?: number;
}

/** One segment of the path, and what happened at it. */
export interface ReferenceHop {
    /** The segment as written, with the `<…>` file token kept whole. */
    readonly segment: string;
    readonly kind: HopKind;
    /** True when the prefix ending at this segment resolved. */
    readonly resolved: boolean;
    /** False for a segment the walk never got to, because an earlier one failed. */
    readonly reached: boolean;
    /** Where the hop landed, when it resolved. */
    readonly landedOn?: TracePlace;
    readonly landedKind?: LandedKind;
    /** True when the segment is not written where it was looked up but reached through that node's
     *  inheritance chain, which is how most of the game's own parts are written. */
    readonly inherited?: boolean;
    /** The reference the hop's member holds, when the walk had to follow it to continue. */
    readonly aliasText?: string;
    /** True when the member exists but the reference it holds could not be followed. */
    readonly aliasBroken?: boolean;
    /** Where the member itself is declared, which for an alias is not where the hop lands. */
    readonly memberAt?: TracePlace;
    /** For a failed `^/N`, how many bases the container really declares. */
    readonly baseCount?: number;
}

/** One name the game would find at the place the walk stopped. */
export interface AvailableMember {
    readonly name: string;
    /** Where the winning declaration lives. */
    readonly origin: TracePlace;
    /** True when the name comes from a base rather than from the container itself. */
    readonly inherited: boolean;
}

/** What the game would have found at the place the walk stopped. */
export type AvailableAt =
    | /** Named members, the common case. */ {
          readonly kind: 'members';
          readonly names: readonly AvailableMember[];
          /** How many there are in total, which may be more than the listed ones. */
          readonly total: number;
          /** True when a base could not be read, so the list is short of what the game reads. */
          readonly incomplete: boolean;
      }
    | /** A list, which is addressed by position rather than by name. */ {
          readonly kind: 'entries';
          readonly count: number;
          readonly incomplete: boolean;
      }
    | /** The bases of a container, for a failed `^/N`. */ { readonly kind: 'bases'; readonly count: number }
    | /** The member is there, and what fails is the reference it holds. */ {
          readonly kind: 'alias';
          readonly text: string;
          /** Where the member holding that reference is declared. */
          readonly declaredAt?: TracePlace;
      }
    | /** A value, which has no members at all. */ { readonly kind: 'value'; readonly text: string }
    | /** The file lookup itself failed, so the answer is the folder that was searched. */ {
          readonly kind: 'file';
          readonly directory: string;
      }
    | /** Withheld on purpose, because the names would come from the wrong tree. */ {
          readonly kind: 'withheld';
          readonly reason: 'runtime-root' | 'virtual';
      }
    | /** Nothing to say, either because the walk succeeded or because the place is unreadable. */ {
          readonly kind: 'none';
      };

/** The whole explanation of one reference. */
export interface ReferenceTrace {
    /** The reference exactly as written. */
    readonly written: string;
    /** The path actually walked, which differs from the written one for a mod action target. */
    readonly walked: string;
    /** Where the reference itself stands. */
    readonly at: TracePlace;
    readonly verdict: ReferenceTraceVerdict;
    /** One entry per segment, in order. */
    readonly hops: readonly ReferenceHop[];
    /** The index of the first segment that did not resolve, or -1 when the whole path resolved. */
    readonly failedAt: number;
    /** The last place the walk stood, which is where {@link ReferenceTrace.available} was read. */
    readonly lastGood?: TracePlace;
    readonly available: AvailableAt;
    /** The closest available name to the failing segment, when one is close enough to be a typo. */
    readonly suggestion?: string;
    /** The written reference with only the failing segment replaced by the suggestion. */
    readonly correctedValue?: string;
    /** For a `:` path, the concrete inheritors that give the member a value. */
    readonly virtualTargets: readonly TracePlace[];
    /** Where the mod declares what only the mod's own additions supply. */
    readonly modOrigin?: TracePlace;
    /** True when the path was walked from the game Data root as a mod action target. */
    readonly actionTarget: boolean;
}
