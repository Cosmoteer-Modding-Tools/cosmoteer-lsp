/**
 * The shapes the override-in-mod command speaks in: what a client sends, the mods it may choose
 * between, what each round answers with, and every reason it refuses. Read by the server that
 * answers the command and by every client that asks, so both sides share the one declaration.
 */

/** Why no override can be written for what the caret sits on. */
export type OverrideRefusal =
    /** The offset names no member of the file any more. */
    | 'stale'
    /** The caret sits in a `[ ]` body, whose elements the game addresses by position. */
    | 'insideList'
    /** A hop of the path is written as a number, which names a position rather than a name. */
    | 'indexSegment'
    /** The member, or a group around it, carries no name to address it by. */
    | 'unnamedMember'
    /** An earlier member of the same name is what the path would reach. */
    | 'shadowedName'
    /** The member has no value to copy. */
    | 'emptyMember'
    /** The member declares bases of its own, which a copy of its body would drop. */
    | 'inheritedMember'
    /** A quoted text in the member runs across a line break, so it cannot be re-indented. */
    | 'multiLineText'
    /** The member's value reaches outside itself, so it means something else from the mod. */
    | 'scopeRelativeValue'
    /** A path the member carries cannot be re-expressed against the game folder. */
    | 'unrebasablePath'
    /** The path that came out is not one the game addresses by plain member names. */
    | 'untypablePath';

/** What the client sends: the value, and on the second round the mod it picked. */
export interface OverrideInModArgs {
    /** The file of the game install the value is written in. */
    uri: string;
    /** The byte offset of the caret in that file. */
    offset: number;
    /** The {@link OverrideModCandidate.key} of the chosen mod. Absent means "report the candidates". */
    mod?: string;
    /** Whether the map is written into the manifest or into a file of the mod. Defaults to inline. */
    shape?: 'inline' | 'file';
}

/** Why an override cannot be written, whatever else is true of it. */
export type OverrideInModFailure =
    | OverrideRefusal
    /** The file is not one of the game install, so it is edited directly instead of overridden. */
    | 'notVanilla'
    /** Language string files are the one thing actions cannot touch. */
    | 'stringsFile'
    /** The game folder is not configured, so no target path can be expressed. */
    | 'noGamePath'
    /** The workspace holds no mod the override could go into. */
    | 'noModRoot'
    /** The mod the client picked is no longer among the candidates. */
    | 'unknownMod'
    /** The mod ships several manifests and only its author knows which get the override. */
    | 'ambiguousManifest'
    /** The manifest cannot take another action entry. */
    | 'notEditable'
    /** An action of that mod already overrides this member. */
    | 'alreadyOverridden'
    /** The client turned the edit down. */
    | 'editRejected'
    /** The fragment file could not be written. */
    | 'writeFailed';

/** One mod the override could be written into. */
export interface OverrideModCandidate {
    /** The identity the client sends back to pick this mod. */
    key: string;
    /** The mod folder's name, which is what the user recognizes it by. */
    name: string;
    /** The mod's root directory, with forward slashes. */
    modRoot: string;
    /** The manifests it ships, by base name. */
    manifests: string[];
    /** True when one of its actions already overrides this member. */
    alreadyOverridden: boolean;
    /** Why this mod cannot take the override, absent when it can. */
    blocked?: 'ambiguousManifest' | 'notEditable';
}

/** The mods the override could be written into, and what would be written. */
export interface OverrideInModScanResult {
    kind: 'scan';
    /** The name of the member being overridden, empty when there is none. */
    memberName: string;
    /** The `OverrideIn` path the action would carry. */
    target: string;
    /** The `Overrides` body that would be written, one member deep. */
    body: string;
    /** True when the member is a group or a list, so the override replaces the whole of it. */
    replacesContainer: boolean;
    /** The candidates, in the order the folders were walked. */
    candidates: OverrideModCandidate[];
    /** Why nothing could be worked out, absent on success. */
    failure?: OverrideInModFailure;
}

/** What writing the override did, or why it did nothing. */
export interface OverrideInModApplyResult {
    kind: 'apply';
    /** The mod the override went into, empty when nothing was written. */
    modRoot: string;
    /** The manifest the action was written into, empty when nothing was written. */
    manifestFsPath: string;
    /** The fragment file that was created, empty for the inline shape. */
    createdFsPath: string;
    /** Every file the command changed, so the client can save and tidy them. */
    changedFiles: string[];
    /** The `OverrideIn` path that was written. */
    target: string;
    /** The name of the member that was overridden. */
    memberName: string;
    /** True when the override replaces a whole group or list rather than a single value. */
    replacesContainer: boolean;
    /** Why nothing was written, absent on success. */
    failure?: OverrideInModFailure;
    /** The manifest names to choose between, only set for `ambiguousManifest`. */
    manifests?: string[];
}
