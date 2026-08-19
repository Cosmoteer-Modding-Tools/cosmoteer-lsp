import { CancellationToken } from 'vscode-languageserver';
import { AbstractNodeDocument } from '../../core/ast/ast';
import { isModRules } from '../../document/document-kind';
import { containerAtOffset, plansForDocument } from '../refactor/shared-base/shared-base.analysis-entry';
import { ExtractionPlan } from '../refactor/shared-base/plan.types';
import { normalizeUri } from '../navigation/reference-location';
import { ValidationError } from './validator';
import * as l10n from '@vscode/l10n';

/**
 * Whole-document pass reporting a container that repeats, word for word, a set of fields several
 * other files of the same mod also write, when those fields could live in one shared base file the
 * lot of them inherit instead. This is the shape the game's own data and its larger mods are written
 * in: a `base_…rules` holding what a family of parts has in common, and one small file per part.
 *
 * Conservative by construction. A field is only counted when it says exactly the same thing in every
 * participating file, when the schema class declares it, when it is neither an identity field nor the
 * discriminator the class is resolved by, when it is not a list (an inherited list is prepended to
 * the deriver's own, which would move every index a reference addresses), when no reference in its
 * file reads it, when no comment touches it, and when every path it carries still names the same file
 * from the base. Fields are grouped by the exact set of files that carry them, never by a majority,
 * so applying the fix cannot give a file a field it did not already have.
 *
 * @param document the parsed document to validate.
 * @param text that document's current source text.
 * @param folderPaths the project folders, used to skip a file outside the workspace.
 * @param cancellationToken cancels the sibling walk.
 * @param inScope tells whether a file is one the game actually loads, so a backup copy or an unused
 * template never takes part in an extraction.
 * @returns one hint per container that could inherit a generated base instead.
 */
export const validateDuplicateFields = async (
    document: AbstractNodeDocument,
    text: string,
    folderPaths: string[],
    cancellationToken: CancellationToken,
    inScope?: (fsPath: string) => boolean
): Promise<ValidationError[]> => {
    if (isModRules(document.uri)) return [];
    const plans = await plansForDocument(document, text, folderPaths, cancellationToken, inScope);
    if (plans.length === 0) return [];

    // One hint per container, carrying its largest plan: a container can appear in several plans
    // (one per field set it shares), and reporting each of them would bury the file in hints.
    const selfUri = normalizeUri(document.uri);
    const best = new Map<number, ExtractionPlan>();
    for (const plan of plans) {
        for (const participant of plan.participants) {
            if (normalizeUri(participant.uri) !== selfUri) continue;
            const current = best.get(participant.nameStart);
            if (!current || current.savedBytes < plan.savedBytes) best.set(participant.nameStart, plan);
        }
    }

    const errors: ValidationError[] = [];
    for (const [offset, plan] of best) {
        if (cancellationToken.isCancellationRequested) return errors;
        const anchor = containerAtOffset(document, offset)?.identifier;
        if (!anchor) continue;
        errors.push({
            message:
                plan.tier === 'existingBase'
                    ? l10n.t(
                          '{0} fields here are written the same way in the {1} other files that inherit {2}. They could move into that base file, since nothing else inherits it.',
                          plan.fields.length,
                          plan.participants.length - 1,
                          plan.baseFsPath.split(/[\\/]/).pop() ?? plan.baseFsPath
                      )
                    : l10n.t(
                          '{0} fields here are written the same way in {1} other files of this mod. They could move into one shared base file that all of them inherit.',
                          plan.fields.length,
                          plan.participants.length - 1
                      ),
            node: anchor,
            severity: 'hint',
        });
    }
    return errors;
};
