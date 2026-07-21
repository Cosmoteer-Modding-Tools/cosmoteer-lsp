import { CancellationToken, TextEdit } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { AbstractNodeDocument, isAssignmentNode } from '../../core/ast/ast';
import { isModRules } from '../../document/document-kind';
import { RENAMED_MOD_RULES_FIELDS } from '../../document/schema/deprecations';
import { ValidationError } from '../diagnostics/validator';
import { validateSchema } from '../diagnostics/validator.schema';
import { validateIgnoredFields } from '../diagnostics/validator.ignored-field';
import { removalRange } from '../../utils/removal-range';

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
}

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
 * @param token cancellation token for the validators.
 * @returns the file's edits and report bookkeeping.
 */
export const collectFileMigration = async (
    documentNode: AbstractNodeDocument,
    doc: TextDocument,
    includeDeadFields: boolean,
    token: CancellationToken
): Promise<FileMigrationResult> => {
    const result: FileMigrationResult = { edits: [], byVersion: {}, manual: [], deadFieldsRemoved: 0 };
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
            if (includeDeadFields && data.remove) {
                result.edits.push({ range: removalRange(doc, data.remove.start, data.remove.end), newText: '' });
                result.deadFieldsRemoved++;
            }
            continue;
        }
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
