/**
 * The shapes the migration commands speak in: what the bulk deprecation fix is invoked with and
 * narrowed by, the per-file change a migration computes, and the summary both commands answer with,
 * preview included. Kept apart from the sweeps so the server's migration driver and a test can name
 * them without pulling the validators in.
 */

import { CancellationToken, TextEdit } from 'vscode-languageserver';

/** What the bulk fix is invoked with: the deprecation to apply, and the file it was offered in. */
export interface MigrateSymbolArgs {
    /** The deprecation-registry identity, from the diagnostic's `data.migration.symbol`. */
    symbol: string;
    /** The uri of the file the offer came from, which decides the mod the sweep stays inside. */
    uri: string;
    /** Work the rewrite out and answer with it as a diff, without changing anything. */
    dryRun?: boolean;
}

/** The lookups the bulk sweep narrows its file set with, so a test can stand in for both. */
export interface MigrateSymbolHost {
    /**
     * The indexed files under `folderPaths` whose text can contain `name`, from the mention index.
     * Undefined when the name has no word token, which means "no pre-filter available".
     */
    candidateFiles(name: string, folderPaths: string[], token: CancellationToken): Promise<string[] | undefined>;
    /** The tree a file may be rewritten within, or undefined when it must be left alone. */
    editableRootOf(fsPath: string): string | undefined;
}

/** One file a migration rewrites, with the text the edits were computed against. */
export interface MigrationChange {
    /** The uri to edit through the client, which for an open file is that buffer's own uri. */
    uri: string;
    /** The file's on-disk path, for the files written directly. */
    fsPath: string;
    /** The text the edits were computed against (the open buffer's, or what was read from disk). */
    text: string;
    /** The edits to apply to that text. */
    edits: TextEdit[];
}

/** A migration finding that needs author judgment, reported instead of auto-fixed. */
export interface ManualFinding {
    /** The file the finding is in. */
    uri: string;
    /** 1-based line of the finding, for a human-readable report. */
    line: number;
    /** The finding's diagnostic message (already carries the game version and guidance). */
    message: string;
}

/** What the workspace migration did, returned to the invoking client for display. */
export interface MigrationSummary {
    /** Files that received at least one edit. */
    files: number;
    /** Total mechanical fixes applied. */
    fixes: number;
    /**
     * Applied fix count per game version that made the change. The empty-string key collects fixes
     * whose change predates the recorded changelogs (the `Ammo*` → `Resource*` family).
     */
    byVersion: Record<string, number>;
    /** Findings the migration only reports (author judgment needed). */
    manual: ManualFinding[];
    /** Ignored/dead fields removed on top, when the caller opted in. */
    deadFieldsRemoved: number;
    /** Files skipped because they did not parse cleanly (never edited mechanically). */
    unparsable: number;
    /** What a dry run would have changed. Absent when the migration was applied. */
    preview?: MigrationPreview;
}

/** One file a dry run would change, with the text it would end up holding. */
export interface MigrationPreviewFile {
    fsPath: string;
    /** The file's contents after the migration, for a side-by-side view against what is on disk. */
    after: string;
}

/** What a dry run would change, in the formats an editor can render. */
export interface MigrationPreview {
    /** Every changed file as one unified diff, for a client without a diff view. */
    diff: string;
    /** The changed files with their rewritten contents, capped by {@link MAX_PREVIEW_FILES}. */
    changed: MigrationPreviewFile[];
    /** How many changed files are not carried in {@link MigrationPreview.changed}. */
    omitted: number;
    /** True when the diff reached {@link MAX_PREVIEW_DIFF_BYTES} and stops short of the last files. */
    diffTruncated: boolean;
}
