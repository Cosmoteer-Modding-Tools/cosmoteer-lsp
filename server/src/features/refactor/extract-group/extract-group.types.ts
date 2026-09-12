/**
 * The shapes the extract-group command speaks in: what a client sends, what each round answers with,
 * and the facilities the command is given. Kept apart from the command so the code action and a test
 * can name them without pulling the file writing in with them.
 */

import { TextEdit } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';

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

/** The facilities the command reads buffers through and hands its edit to. */
export interface ExtractGroupHost {
    /** The editor's open buffers, whose unsaved text wins over disk. */
    openDocuments(): readonly TextDocument[];
    /** Hands the client the edit that replaces the group with a reference. */
    applyEdit(changes: Record<string, TextEdit[]>): Promise<boolean>;
    /** Announces the file the command wrote, so the indexes pick it up without waiting for a watcher. */
    filesChanged(paths: readonly string[]): void;
}
