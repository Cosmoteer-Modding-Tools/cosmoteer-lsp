/**
 * The shapes the clone command speaks in: what a client sends, and what each of the command's three
 * rounds answers with. Read by the server that writes the copy and by every client that asks for one,
 * so both sides share the one declaration rather than each keeping a copy that nothing checks against
 * the other. The plan the builder hands the command, and the facilities the command is given, stay on
 * the server.
 */

/**
 * How much of the source a clone carries.
 *
 * `directory` is the normal shape for a ship part: the file sits alone in a folder with its sprites
 * and its particle fragments, and the game resolves every one of those paths against that folder, so
 * copying the folder is the only way the copy still finds its own art. `file` is the fallback for a
 * folder holding several declarations, where copying it would duplicate the neighbours' ids too.
 * `listElement` is the whole-collection shape (`Factions [ { ID = … } … ]`), where the copy is another
 * element of the very same list rather than another file.
 */
export type CloneUnit = 'directory' | 'file' | 'listElement';

/** Why the caret anchors no clone. */
export type CloneTargetRefusal = 'noDeclaration' | 'inheritedIdentity' | 'unreadableBase' | 'severalIdentities';

/** Why a clone did not happen. Every one of them is a state the copy would have been wrong in. */
export type CloneFailure =
    | CloneTargetRefusal
    | 'stale'
    | 'invalidId'
    | 'idUnchanged'
    | 'idTaken'
    | 'notEditable'
    | 'ambiguousDestination'
    | 'destinationExists'
    | 'unresolvablePath'
    | 'escapingPath'
    | 'writeFailed'
    | 'editRejected';

/** What the client sends. */
export interface CloneDeclarationArgs {
    /** The file the declaration is written in. */
    uri: string;
    /** The byte offset the offer was made at. */
    offset: number;
    /** The id the copy declares. Absent means "report what this would take". */
    newId?: string;
    /** The directory the copy lands in, absent for the default beside or below the source. */
    destinationDir?: string;
    /** Work the copy out and answer with a diff, without writing anything. */
    preview?: boolean;
}

/** What cloning this declaration would take. */
export interface CloneScanResult {
    kind: 'scan';
    /** The id the source declares. */
    id: string;
    /** The identity field's name as the source spells it. */
    identityKey: string;
    /** How much of the source the copy carries. */
    unit: CloneUnit;
    /** How many files the copy would write, the language files aside. */
    files: number;
    /** An id to start from, which the author is expected to rewrite. */
    proposedId: string;
    /** Where the copy would land with that id, empty when the destination is not decided. */
    destinationDir: string;
    /** The mods the copy could go into, for a client that has to ask. */
    modRoots: string[];
    /** Why nothing could be reported, absent on success. */
    failure?: CloneFailure;
}

/** One file the clone writes, with the text it would hold. */
export interface ClonePreviewFile {
    fsPath: string;
    /** The file's contents afterwards, for a side-by-side view against what is on disk. */
    after: string;
    /** True when the file does not exist yet, so there is nothing to compare against. */
    created: boolean;
}

/** What a clone would do, in the formats an editor can render. */
export interface ClonePreviewResult {
    kind: 'preview';
    /** Every rewritten file as one unified diff, for a client without a diff view. */
    diff: string;
    /** The written files with their contents, for a client that has a real diff view. Capped. */
    changed: ClonePreviewFile[];
    /** How many written files did not fit in {@link ClonePreviewResult.changed}. */
    omitted: number;
    /** Every path the clone writes, uncapped, so nothing is written that was not shown. */
    writes: string[];
    /** The files carried over byte for byte, which have no text to diff. */
    copied: string[];
    /** The destination mod's language files the keys are declared in. */
    stringsFiles: string[];
    destinationDir: string;
    newId: string;
    unit: CloneUnit;
    /** The `OtherIDs` aliases the copy leaves behind, as written. */
    droppedOtherIds: string[];
    /** The localization keys the copy declares in place of the source's. */
    keys: Array<{ from: string; to: string }>;
    /** Why the preview could not be built, absent on success. */
    failure?: CloneFailure;
    /** What the failure is about: a path, a file, or the mods to choose between. */
    detail?: string[];
}

/** What a clone did, or why it did nothing. */
export interface CloneApplyResult {
    kind: 'apply';
    /** The copy's own file, the one worth opening afterwards, empty when nothing was written. */
    created: string;
    /** Every path the clone created. */
    createdPaths: string[];
    /** The already-open files the clone changed through the editor, so the client can save them. */
    changedFiles: string[];
    /** The language files the keys were declared in. */
    stringsFiles: string[];
    /** The `OtherIDs` aliases the copy left behind, as written. */
    droppedOtherIds: string[];
    /** How many localization keys the copy declares. */
    keys: number;
    newId: string;
    unit: CloneUnit;
    /** Why nothing was written, absent on success. */
    failure?: CloneFailure;
    /** What the failure is about: a path, a file, or the mods to choose between. */
    detail?: string[];
}
