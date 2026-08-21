import { CancellationToken, TextEdit } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { AbstractNodeDocument, isAssignmentNode } from '../../core/ast/ast';
import { isModRules } from '../../document/document-kind';
import { migrationSymbolOf, RENAMED_MOD_RULES_FIELDS } from '../../document/schema/deprecations';
import { ValidationError } from '../diagnostics/validator';
import { validateSchema } from '../diagnostics/validator.schema';
import { validateIgnoredFields } from '../diagnostics/validator.ignored-field';
import { removalRange } from '../../utils/removal-range';
import { unifiedDiff } from '../../utils/unified-diff';

/**
 * The `workspace/executeCommand` id of the one-command workspace migration. Both clients invoke it
 * (VS Code from the command palette, JetBrains from an action). The server walks every rules file
 * of the workspace, applies the mechanical fixes of every deprecation-registry finding as one
 * WorkspaceEdit, and returns a {@link MigrationSummary} grouped by the game version that made each
 * change.
 */
export const MIGRATE_WORKSPACE_COMMAND = 'cosmoteer.migrateWorkspace';

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

/**
 * How many rewritten files a dry run carries in full. A migration can cover every file of a mod, and
 * the unified diff already accounts for all of them, so the side-by-side view opens on the first of
 * these and the message stays a size a client can read.
 */
export const MAX_PREVIEW_FILES = 40;

/** The largest total size of those rewritten contents, so a few very large files cannot blow it. */
export const MAX_PREVIEW_CONTENT_BYTES = 2_000_000;

/** The largest unified diff a dry run sends. Past it the diff stops and the payload says so. */
export const MAX_PREVIEW_DIFF_BYTES = 1_000_000;

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

/** Gathers a dry run's changed files, dropping whatever does not fit in one message. */
export interface MigrationPreviewCollector {
    /**
     * Records one changed file.
     *
     * @param fsPath the file's on-disk path.
     * @param label the path shown in the diff header, relative to the workspace folder.
     * @param before the file's current text.
     * @param after the text the migration would leave in it.
     */
    add(fsPath: string, label: string, before: string, after: string): void;
    /** Records a changed file the preview cannot show, so the counts stay truthful. */
    omit(): void;
    /** The payload for the client. */
    result(): MigrationPreview;
}

/**
 * Collect what a dry run would change, under a fixed size budget.
 *
 * The rewritten contents of every file of a large mod do not belong in one LSP message, so the first
 * {@link MAX_PREVIEW_FILES} files are carried in full for the editor's own side-by-side diff, and the
 * unified diff covers the rest until it reaches {@link MAX_PREVIEW_DIFF_BYTES}. What was left out is
 * counted, so the client says what the view does not show rather than implying it is the whole change.
 *
 * @returns the collector.
 */
export const createMigrationPreview = (): MigrationPreviewCollector => {
    const sections: string[] = [];
    const changed: MigrationPreviewFile[] = [];
    let contentBytes = 0;
    let diffBytes = 0;
    let omitted = 0;
    let diffTruncated = false;
    return {
        add: (fsPath, label, before, after) => {
            if (changed.length < MAX_PREVIEW_FILES && contentBytes + after.length <= MAX_PREVIEW_CONTENT_BYTES) {
                changed.push({ fsPath, after });
                contentBytes += after.length;
            } else {
                omitted++;
            }
            const section = unifiedDiff(before, after, label);
            if (section.length === 0) return;
            // The sections are joined with a newline each, so that separator is part of what the
            // message costs and has to count against the budget for the cap to be a real bound.
            const cost = section.length + (sections.length > 0 ? 1 : 0);
            if (diffBytes + cost > MAX_PREVIEW_DIFF_BYTES) {
                diffTruncated = true;
                return;
            }
            sections.push(section);
            diffBytes += cost;
        },
        omit: () => {
            omitted++;
        },
        result: () => ({ diff: sections.join('\n'), changed, omitted, diffTruncated }),
    };
};

/** The per-file slice of a migration: the edits to apply plus the report bookkeeping. */
export interface FileMigrationResult {
    edits: TextEdit[];
    byVersion: Record<string, number>;
    manual: ManualFinding[];
    deadFieldsRemoved: number;
}

/**
 * Collect the migration edits for one parsed rules file: run the deprecation-aware validators and
 * translate every migration-tagged finding's sanctioned fix (`migration.apply` names it) into text
 * edits, using the same removal widening the interactive quick fixes use. A migration finding
 * without a sanctioned fix becomes a {@link ManualFinding}. A mod manifest gets its own tiny pass
 * (the manifest is not schema-validated), renaming fields from the manifest rename registry.
 *
 * @param documentNode the file's parsed AST.
 * @param doc the file's text document (open buffer or disk content), used for offset→position.
 * @param includeDeadFields also remove every ignored/dead-field finding without a migration tag.
 * Ignored when a `symbol` is given: a fix the author asked for one deprecation must not quietly
 * delete unrelated fields as well.
 * @param token cancellation token for the validators.
 * @param symbol collect only the findings of that one deprecation-registry entry (see
 * deprecations.ts), which is what turns the whole-file migration into a single bulk rename.
 * @returns the file's edits and report bookkeeping.
 */
export const collectFileMigration = async (
    documentNode: AbstractNodeDocument,
    doc: TextDocument,
    includeDeadFields: boolean,
    token: CancellationToken,
    symbol?: string
): Promise<FileMigrationResult> => {
    const result: FileMigrationResult = { edits: [], byVersion: {}, manual: [], deadFieldsRemoved: 0 };
    // A bulk fix rewrites files the author is not looking at, so it only ever does the one thing it
    // offered to do. The dead-field cleanup is a separate decision and stays with the command that
    // asks for it.
    const deadFields = includeDeadFields && symbol === undefined;
    const bump = (version: string | undefined): void => {
        const key = version ?? '';
        result.byVersion[key] = (result.byVersion[key] ?? 0) + 1;
    };

    if (isModRules(documentNode.uri)) {
        // The manifest loader lives outside the serialization system, so no validator flags its
        // fields and the rename registry is applied directly to the top-level assignments.
        for (const element of documentNode.elements) {
            if (!isAssignmentNode(element)) continue;
            const rename = RENAMED_MOD_RULES_FIELDS[element.left.name.toLowerCase()];
            if (!rename) continue;
            if (symbol !== undefined && migrationSymbolOf('manifestField', element.left.name) !== symbol) continue;
            result.edits.push({
                range: {
                    start: doc.positionAt(element.left.position.start),
                    end: doc.positionAt(element.left.position.end),
                },
                newText: rename.replacement,
            });
            bump(rename.version);
        }
        return result;
    }

    const errors: ValidationError[] = [
        ...(await validateSchema(documentNode, token).catch(() => [] as ValidationError[])),
        ...(await validateIgnoredFields(documentNode, token).catch(() => [] as ValidationError[])),
    ];
    for (const error of errors) {
        const data = error.data;
        if (!data) continue;
        if (!data.migration) {
            // Not a game-version change: an ordinary ignored/dead field. Only stripped on request.
            if (deadFields && data.remove) {
                result.edits.push({ range: removalRange(doc, data.remove.start, data.remove.end), newText: '' });
                result.deadFieldsRemoved++;
            }
            continue;
        }
        // The identity check is what keeps a bulk fix off every other deprecation in the file, and
        // off the many live fields and component ids that happen to spell the same word.
        if (symbol !== undefined && data.migration.symbol !== symbol) continue;
        const apply = data.migration.apply;
        if (apply === 'rewrite' && data.rewrite) {
            for (const edit of data.rewrite.edits) {
                result.edits.push(
                    edit.newText === ''
                        ? { range: removalRange(doc, edit.start, edit.end), newText: '' }
                        : {
                              range: { start: doc.positionAt(edit.start), end: doc.positionAt(edit.end) },
                              newText: edit.newText,
                          }
                );
            }
            bump(data.migration.version);
        } else if (apply === 'quickFix' && data.quickFix) {
            const start = error.range?.start ?? error.node.position.start;
            const end = error.range?.end ?? error.node.position.end;
            result.edits.push({
                range: { start: doc.positionAt(start), end: doc.positionAt(end) },
                newText: data.quickFix.newText,
            });
            bump(data.migration.version);
        } else if (apply === 'remove' && data.remove) {
            result.edits.push({ range: removalRange(doc, data.remove.start, data.remove.end), newText: '' });
            bump(data.migration.version);
        } else {
            const start = error.range?.start ?? error.node.position.start;
            result.manual.push({
                uri: doc.uri,
                line: doc.positionAt(start).line + 1,
                message: error.message,
            });
        }
    }
    return result;
};
