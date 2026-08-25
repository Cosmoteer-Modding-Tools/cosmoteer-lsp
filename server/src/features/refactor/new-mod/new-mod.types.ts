/**
 * The shapes the new-mod command speaks in. Kept apart from the command itself so the client's
 * types can be generated from them without pulling the file writing in.
 */

/** Why the command created nothing at all. */
export type NewModFailure =
    | 'noDestination'
    | 'invalidName'
    | 'invalidAuthor'
    | 'pathTaken'
    | 'idTaken'
    | 'writeFailed';

/** What the client sends. Without a `name` the command reports where a mod could be created. */
export interface NewModArgs {
    /** The folder the mod folder is created in. Absent on the scan round. */
    destination?: string;
    /** The mod's human-readable name, which the folder name and the id are derived from. */
    name?: string;
    /** The mod author's name, which the id's first segment is derived from. */
    author?: string;
    /** A folder name of the author's own, overriding the one derived from the mod name. */
    folderName?: string;
}

/** One folder a new mod could be created in. */
export interface NewModDestination {
    /** The folder's absolute path. */
    path: string;
    /** Whether the game itself already reads mods from this folder. */
    loadedByGame: boolean;
}

/** Where a mod can be created, and what the manifest would say about the installed game. */
export interface NewModScanResult {
    kind: 'scan';
    /** The folders the game loads mods from, empty when none was found on this machine. */
    destinations: NewModDestination[];
    /** The `CompatibleGameVersions` literal the manifest gets, empty with no game install. */
    gameVersions: string;
    /** The author names the mods on this machine were written under, as suggestions. */
    knownAuthors: string[];
}

/** What creating the mod did. */
export interface NewModApplyResult {
    kind: 'apply';
    /** The created mod folder, empty when nothing was written. */
    modRoot: string;
    /** The created manifest's path, empty when nothing was written. */
    manifest: string;
    /** The id written into the manifest. */
    id: string;
    /** Every file the command wrote, manifest first. */
    createdFiles: string[];
    /** Whether the folder the mod was created in is one the game already loads mods from. */
    loadedByGame: boolean;
    /** Why nothing was created, absent on success. */
    failure?: NewModFailure;
}

/** Either round's answer. */
export type NewModResult = NewModScanResult | NewModApplyResult;
