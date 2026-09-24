import { CancellationToken } from 'vscode-languageserver';
import { AbstractNode, AbstractNodeDocument, GroupNode, isGroupNode, isListNode } from '../../../core/ast/ast';
import { editableModRootOf } from '../../../mod/write-gate';
import { isCoveredByFolders, normalizeUri } from '../../../document/reference-location';
import { uriToFsPath } from '../../../workspace/workspace-files';
import { Candidate, candidatesInFile, MIN_FIELDS } from './duplicate-field.analysis';
import { modPlans, modPlansIfBuilt } from './mod-scan';
import { ExtractionPlan, Participant } from './plan.types';

/**
 * The canonical uris of a plan's participants, worked out once per plan rather than once per file
 * that asks whether it takes part. A whole-workspace scan asks every plan the same question for
 * every file of the mod, and normalizing each participant's uri again for each of them was the
 * whole of that question's cost.
 */
const participantUriCache = new WeakMap<ExtractionPlan, Set<string>>();

/**
 * The set of canonical participant uris of a plan.
 *
 * @param plan the plan to read.
 * @returns its participants' uris, normalized, memoized for as long as the plan itself lives.
 */
const participantUris = (plan: ExtractionPlan): Set<string> => {
    let uris = participantUriCache.get(plan);
    if (!uris) {
        uris = new Set(plan.participants.map((participant) => normalizeUri(participant.uri)));
        participantUriCache.set(plan, uris);
    }
    return uris;
};

// The gate that says which trees a command may write, which lives beside the mod roots it is
// asked about. Re-exported here because every refactoring reads it through this module.
export { editableModRootOf };

/**
 * The extraction plans that involve the given document, computed against the files it is compared
 * with. The document's own text is used live, so an unsaved edit is reflected at once, while its
 * siblings are read from disk through the memo that makes the pass affordable.
 *
 * @param document the parsed document being looked at.
 * @param text that document's current source text.
 * @param folderPaths the workspace folders, used to skip a file outside the project.
 * @param cancellationToken cancels the mod walk and the sibling reads.
 * @param inScope tells whether a file is one the game actually loads. Without it a backup folder or
 * an unused template would take part, and applying the extraction would rewrite files the mod never
 * reads and drag the base file up to a directory the live files do not share.
 * @param whenPlansArrive when given, the mod's plans are not waited for: a mod whose plans are not
 * computed yet answers nothing now, the walk is started (or joined) with a token no later edit
 * cancels, and this is called once it has finished so the caller can ask again. The open editor
 * passes it, since a file being opened should not wait seconds for a whole-mod read to show its
 * problems. A whole-workspace pass leaves it out, because its results are stored.
 * @returns the plans this document takes part in, largest saving first, empty when there are none.
 */
export const plansForDocument = async (
    document: AbstractNodeDocument,
    text: string,
    folderPaths: readonly string[],
    cancellationToken: CancellationToken,
    inScope?: (fsPath: string) => boolean,
    whenPlansArrive?: () => void
): Promise<ExtractionPlan[]> => {
    if (!isCoveredByFolders(document.uri, folderPaths)) return [];
    const fsPath = uriToFsPath(document.uri);
    const modRoot = editableModRootOf(fsPath);
    if (!modRoot) return [];
    if (inScope && !inScope(fsPath)) return [];
    // The cheap early-out that keeps the pass off nearly every file: a document with nothing movable
    // never reaches the mod walk.
    const own = candidatesInFile({ document, text, fsPath, uri: document.uri }, modRoot, MIN_FIELDS);
    if (own.length === 0) return [];

    // The mod's plans do not depend on which of its files is being validated, so they are computed
    // once and every file only asks which of them it appears in.
    let plans = modPlansIfBuilt(modRoot);
    if (!plans && whenPlansArrive) {
        void modPlans(modRoot, inScope, CancellationToken.None)
            .then(() => {
                if (modPlansIfBuilt(modRoot)) whenPlansArrive();
            })
            .catch(() => undefined);
        return [];
    }
    plans ??= await modPlans(modRoot, inScope, cancellationToken);
    if (plans.length === 0) return [];

    // The memoized plans were built from what the files say on disk. This document's own containers
    // are re-read live, so a plan is only kept when the text in front of the user still says exactly
    // what the plan was built on, and the container it reports on is the live one rather than an
    // offset that an unsaved edit has already moved.
    const selfUri = normalizeUri(document.uri);
    const liveByName = new Map<string, Candidate[]>();
    for (const candidate of own) {
        const key = candidate.participant.groupName.toLowerCase();
        const list = liveByName.get(key);
        if (list) list.push(candidate);
        else liveByName.set(key, [candidate]);
    }

    const kept: ExtractionPlan[] = [];
    for (const plan of plans) {
        // A plan this document appears in nowhere is left alone without rebuilding its participants.
        if (!participantUris(plan).has(selfUri)) continue;
        const participants = plan.participants.map((participant) => {
            if (normalizeUri(participant.uri) !== selfUri) return participant;
            return (liveByName.get(participant.groupName.toLowerCase()) ?? []).find(
                (candidate) =>
                    candidate.participant.className === participant.className &&
                    plan.fields.every(
                        (key) => candidate.participant.members.get(key)?.norm === participant.members.get(key)?.norm
                    )
            )?.participant;
        });
        if (participants.some((participant) => participant === undefined)) continue;
        const resolved = participants as Participant[];
        const donorIndex = plan.participants.indexOf(plan.donor);
        kept.push({
            ...plan,
            participants: resolved,
            donor: donorIndex >= 0 ? resolved[donorIndex] : plan.donor,
        });
    }
    return kept;
};

/**
 * The named group whose name begins at a byte offset, the anchor a plan's participant records. The
 * participant carries an offset rather than a node, so a caller that wants to report on the container
 * or test the cursor against it resolves it here.
 *
 * @param document the parsed document to search.
 * @param nameStart the byte offset of the container's name.
 * @returns the group, or undefined when nothing in the document starts there any more.
 */
export const containerAtOffset = (document: AbstractNodeDocument, nameStart: number): GroupNode | undefined => {
    let found: GroupNode | undefined;
    const visit = (node: AbstractNode): void => {
        if (found) return;
        if (isGroupNode(node) && node.identifier?.position.start === nameStart) {
            found = node;
            return;
        }
        if (isGroupNode(node) || isListNode(node)) for (const child of node.elements) visit(child);
    };
    for (const element of document.elements) visit(element);
    return found;
};
