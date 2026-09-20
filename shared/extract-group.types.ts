/**
 * The shapes the extract-group command speaks in: what a client sends, and what each round answers
 * with. Read by the server that writes the file and by every client that asks for one, so both sides
 * share the one declaration. The facilities the command is given stay on the server.
 */

/** What the client sends: the group, and on the second round the file name it was given. */
export interface ExtractGroupArgs {
    /** The file the group is written in. */
    uri: string;
    /** The byte offset of the group's name in that file. */
    offset: number;
    /** The new file's path, relative to the folder the group's file sits in. Absent means "report". */
    fileName?: string;
}

/** Why a group cannot be moved into a file of its own. */
export type ExtractGroupFailure =
    /** The offset names no group any more. */
    | 'stale'
    /** The caret sits on nothing that can be moved: a list, an unnamed block, or the file itself. */
    | 'notAGroup'
    /** The file belongs to the game's own install rather than to a mod. */
    | 'notEditable'
    /** The group declares bases of its own, which the move would drop. */
    | 'inheritedGroup'
    /** The group is what gives the file its meaning, so moving it would leave the file empty or unrooted. */
    | 'rootGroup'
    /** A quoted text in the group runs across a line break, so it cannot be re-indented. */
    | 'multiLineText'
    /** The group reads something outside itself, so it means something else from another file. */
    | 'scopeRelativeValue'
    /** The name given is not a `.rules` file inside the folder tree of the file it comes from. */
    | 'badFileName'
    /** A file of that name is already there. */
    | 'fileExists'
    /** The editor refused the edit. */
    | 'editRejected';

/** What the first round reports: what would move, and what to call the file. */
export interface ExtractGroupOffer {
    /** The group's name. */
    name: string;
    /** The file name to start from, derived from the group's name. */
    fileName: string;
    /** How many members would move with it. */
    members: number;
}

/** What the second round reports. */
export interface ExtractGroupWritten {
    /** The file that was written, as a uri. */
    uri: string;
    /** The reference the group was replaced with. */
    reference: string;
}

/** What the command answers with, on either round. */
export type ExtractGroupResult =
    { offer: ExtractGroupOffer } | { written: ExtractGroupWritten } | { failure: ExtractGroupFailure };
