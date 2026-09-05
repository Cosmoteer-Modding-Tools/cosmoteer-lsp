/**
 * The shapes the shared-base extraction command speaks in: what a client asks for, what a sweep, an
 * extraction and a preview answer with, and the facilities the command is given. The plan itself is
 * described in plan.types.ts, and this file carries only what crosses the command boundary.
 */

import { TextEdit } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { ExtractionTier, SerializedPlan } from './plan.types';

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
    /** How many changed files did not fit in {@link changed}. */
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

/** The server-side facilities the command needs, injected so the module stays testable. */
export interface SharedBaseHost {
    /** The workspace folders to sweep, as on-disk paths. */
    folderPaths(): Promise<string[]>;
    /** The editor's open buffers, whose unsaved text wins over disk. */
    openDocuments(): readonly TextDocument[];
    /** Hands the client the multi-file edit. */
    applyEdit(changes: Record<string, TextEdit[]>): Promise<boolean>;
    /** Reports sweep progress, from 0 to 100. */
    report?(percent: number, message: string): void;
    /**
     * Whether a file is one the game actually loads. Without it the sweep would offer to rewrite a
     * backup folder or an unused template, and would drag the base file up to a directory the live
     * files do not share.
     */
    inScope?(fsPath: string): boolean;
    /** Announces the files the command wrote, so the indexes pick them up without waiting for a watcher. */
    filesChanged(paths: readonly string[]): void;
}
