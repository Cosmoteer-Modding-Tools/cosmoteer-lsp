import { CancellationToken } from 'vscode-languageserver';
import { AbstractNode, AbstractNodeDocument, GroupNode, isGroupNode, isListNode } from '../../../core/ast/ast';
import { findModRoot } from '../../../mod/mod-root';
import { globalSettings } from '../../../settings';
import { CosmoteerWorkspaceService } from '../../../workspace/cosmoteer-workspace.service';
import { foldPathCase } from '../../../workspace/fs-cache';
import { workshopContentDir } from '../../../workspace/workshop-dir';
import { normalizeUri } from '../../navigation/reference-location';
import { uriToFsPath } from '../../navigation/workspace-files';
import { Candidate, candidatesInFile, MIN_FIELDS } from './duplicate-field.analysis';
import { modPlans } from './mod-scan';
import { ExtractionPlan, Participant } from './plan.types';

/** Whether a folder set covers a file, so its siblings are files the user actually has open. */
export const isCovered = (uri: string, folderPaths: readonly string[]): boolean => {
    const key = normalizeUri(uri);
    return folderPaths.some((folder) => {
        const prefix = normalizeUri(folder).replace(/\/+$/, '');
        return key === prefix || key.startsWith(`${prefix}/`);
    });
};

/**
 * Whether a file is one the extraction may ever touch, and which tree it is compared within.
 *
 * Normally that is a mod the user is editing, found by its manifest, and never the game's own `Data`
 * tree or somebody else's installed workshop mod: the duplication in the game's files is real and
 * large, and offering to rewrite them would edit an install the user does not own.
 *
 * The game tree is doubly invisible, because it carries no manifest either, so a developer working on
 * the game data itself is served by `allowEditingVanillaFiles`, the one switch every refactoring
 * reads. With it on, the data root stands in for the missing manifest and becomes the tree those
 * files are compared within and the directory a generated base file is placed relative to. An
 * installed workshop mod is somebody else's either way, so that refusal has no switch.
 *
 * @param fsPath the file's on-disk path.
 * @returns the root of the tree the file is compared within, or undefined when it must be left alone.
 */
export const editableModRootOf = (fsPath: string): string | undefined => {
    const key = foldPathCase(fsPath.replace(/\\/g, '/'));
    const workshop = workshopContentDir();
    if (workshop && key.startsWith(`${foldPathCase(workshop.replace(/\\/g, '/'))}/`)) return undefined;
    const dataRoot = CosmoteerWorkspaceService.instance.dataRootPath?.replace(/\\/g, '/');
    if (dataRoot && key.startsWith(`${foldPathCase(dataRoot)}/`)) {
        if (!globalSettings.allowEditingVanillaFiles) return undefined;
        // A mod somebody unpacked into the game tree is still its own project, so a manifest inside
        // the data root keeps winning over the data root itself.
        return findModRoot(fsPath) ?? dataRoot;
    }
    return findModRoot(fsPath) ?? undefined;
};

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
 * @returns the plans this document takes part in, largest saving first, empty when there are none.
 */
export const plansForDocument = async (
    document: AbstractNodeDocument,
    text: string,
    folderPaths: readonly string[],
    cancellationToken: CancellationToken,
    inScope?: (fsPath: string) => boolean
): Promise<ExtractionPlan[]> => {
    if (!isCovered(document.uri, folderPaths)) return [];
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
    const plans = await modPlans(modRoot, inScope, cancellationToken);
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
        if (!plan.participants.some((participant) => normalizeUri(participant.uri) === selfUri)) continue;
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
