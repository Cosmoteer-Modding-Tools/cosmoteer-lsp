/**
 * The shapes the shared-base extraction speaks in: the plan that crosses the boundary, what a client
 * asks for, and what a sweep, an extraction and a preview answer with. Read by the server that finds
 * the duplication and rewrites the files and by every client that offers the rewrite, so both sides
 * share the one declaration. The plan's own working form, which holds AST-derived records, and the
 * facilities the command is given stay on the server.
 */

/** Which duplication a plan came from, reported so the user can tell the shapes apart. */
export type ExtractionTier =
    /** Containers that already share a base and still repeat fields it does not carry. */
    | 'sharedBase'
    /** Containers of the same schema class that share no base at all, the classic copied file. */
    | 'cloneFamily'
    /**
     * Containers that already share a base, and are the only things in the mod inheriting it, so the
     * repeated fields belong in that base rather than in a new file wedged in front of it.
     */
    | 'existingBase';

/** Where a base a container inherits actually lives, kept so it can be read and edited again. */
export interface BaseLocation {
    /** The on-disk path of the file holding the base. */
    fsPath: string;
    /** The names of the groups leading to the base inside that file, outermost first. */
    groupPath: string[];
}

/** The JSON-safe form of a plan, the shape that crosses the client boundary. */
export interface SerializedPlan {
    id: string;
    tier: ExtractionTier;
    className: string;
    groupName: string;
    fields: string[];
    /** Each participant by file uri and the byte offset of its container's name. */
    participants: Array<{ uri: string; fsPath: string; offset: number }>;
    donor: { uri: string; fsPath: string; offset: number };
    baseFsPath: string;
    inheritedRef?: string;
    /** The group inside the existing base file the members move onto, only on an `existingBase` plan. */
    existingBase?: BaseLocation;
    savedBytes: number;
    /** A one-line human description for the client's picker. */
    label: string;
}

/** What the client asks for: a sweep when no plan is given, and the extraction when one is. */
export interface ExtractSharedBaseArgs {
    /** A plan from a previous sweep. Absent means "sweep and report". */
    plan?: SerializedPlan;
    /** Replaces the generated base file's name, extension included. */
    baseFileName?: string;
    /** Work out what the plan would do and answer with a diff, without changing anything. */
    preview?: boolean;
}

/** The extractions a sweep found. */
export interface SharedBaseScanResult {
    kind: 'scan';
    plans: SerializedPlan[];
    filesScanned: number;
}

/** Why an extraction did not happen. */
export type SharedBaseFailure = 'planStale' | 'baseFileExists' | 'notEditable' | 'editRejected';

/** What an applied extraction did. */
export interface SharedBaseApplyResult {
    kind: 'apply';
    /** The on-disk path of the base file that was created or added to. */
    created: string;
    /**
     * Every file the client-side edit changed. A workspace edit leaves each of them open and unsaved,
     * which for a plan covering hundreds of files is hundreds of dirty buffers, so the client is told
     * exactly which ones to write out and tidy away.
     */
    changedFiles: string[];
    /** Whether that file was written from scratch or already existed. */
    tier: ExtractionTier;
    /** How many files now inherit it. */
    files: number;
    /** How many fields moved out of each of them. */
    fields: number;
    /** Source bytes removed across those files. */
    removedBytes: number;
    /** Why the extraction did not happen, absent on success. */
    failure?: SharedBaseFailure;
}

/** One file the extraction would change, with the text it would end up holding. */
export interface SharedBasePreviewFile {
    fsPath: string;
    /** The file's contents after the rewrite, for a side-by-side view against what is on disk. */
    after: string;
    /** True when the file does not exist yet, so there is nothing to compare against. */
    created: boolean;
}

/** What an extraction would do, in the formats an editor can render. */
export interface SharedBasePreviewResult {
    kind: 'preview';
    /** Every file the extraction touches, as one unified diff, for a client without a diff view. */
    diff: string;
    /**
     * The changed files with their rewritten contents, for a client that has a real diff view.
     * Capped, since a plan can cover hundreds of files and this crosses the wire.
     */
    changed: SharedBasePreviewFile[];
    /** How many changed files did not fit in {@link SharedBasePreviewResult.changed}. */
    omitted: number;
    /** The on-disk path of the base file that would be created or added to. */
    baseFsPath: string;
    tier: ExtractionTier;
    files: number;
    fields: number;
    removedBytes: number;
    /** Why the preview could not be built, absent on success. */
    failure?: SharedBaseFailure;
}
