import { CancellationToken, CodeAction, CodeActionKind } from 'vscode-languageserver';
import { AbstractNodeDocument } from '../../../core/ast/ast';
import { normalizeUri } from '../../navigation/reference-location';
import { containerAtOffset, plansForDocument } from './shared-base.analysis-entry';
import { EXTRACT_SHARED_BASE_ACTION_COMMAND } from './shared-base.command';
import { ExtractionPlan, serializePlan } from './plan.types';
import * as l10n from '@vscode/l10n';

/** How many extractions are offered at one cursor, so the menu stays readable. */
const MAX_ACTIONS = 3;

/**
 * The "extract these repeated fields into a shared base file" refactoring, offered when the cursor
 * sits in a container whose fields several other files of the mod write the same way. The action
 * carries the command rather than an edit: it creates a file and rewrites every participant, which a
 * plain `WorkspaceEdit` on one document cannot express.
 *
 * @param document the parsed document the cursor is in.
 * @param text that document's current source text.
 * @param offset the cursor's byte offset.
 * @param folderPaths the workspace folders, used to skip a file outside the project.
 * @param cancellationToken cancels the sibling walk.
 * @param inScope tells whether a file is one the game actually loads.
 * @returns the offered refactorings, innermost container first, empty when nothing applies.
 */
export const extractSharedBaseCodeActions = async (
    document: AbstractNodeDocument,
    text: string,
    offset: number,
    folderPaths: readonly string[],
    cancellationToken: CancellationToken,
    inScope?: (fsPath: string) => boolean
): Promise<CodeAction[]> => {
    const plans = await plansForDocument(document, text, folderPaths, cancellationToken, inScope);
    if (plans.length === 0) return [];
    const selfUri = normalizeUri(document.uri);

    // A plan applies at the cursor when the cursor is inside the container this file contributes.
    // The innermost container wins, so a nested group's own extraction is offered before its parent's.
    const applicable: Array<{ plan: ExtractionPlan; nameStart: number }> = [];
    for (const plan of plans) {
        for (const participant of plan.participants) {
            if (normalizeUri(participant.uri) !== selfUri) continue;
            const container = containerAtOffset(document, participant.nameStart);
            if (!container) continue;
            if (offset < participant.nameStart || offset > container.position.end) continue;
            applicable.push({ plan, nameStart: participant.nameStart });
        }
    }
    applicable.sort((a, b) => b.nameStart - a.nameStart || b.plan.savedBytes - a.plan.savedBytes);

    return applicable.slice(0, MAX_ACTIONS).map(({ plan }) => {
        const baseName = plan.baseFsPath.split(/[\\/]/).pop() ?? plan.baseFsPath;
        const title =
            plan.tier === 'existingBase'
                ? l10n.t(
                      'Move {0} repeated fields into {1}, the base all {2} files already inherit',
                      plan.fields.length,
                      baseName,
                      plan.participants.length
                  )
                : l10n.t(
                      'Extract {0} repeated fields into {1}, inherited by {2} files',
                      plan.fields.length,
                      baseName,
                      plan.participants.length
                  );
        return {
            title,
            kind: CodeActionKind.RefactorExtract,
            // The client's own command, carrying the plan and nothing else, so the editor can show
            // the rewrite as a real diff before any of it happens (see the command id's own note).
            command: {
                title,
                command: EXTRACT_SHARED_BASE_ACTION_COMMAND,
                arguments: [serializePlan(plan, title)],
            },
        };
    });
};
