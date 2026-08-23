import { TextEdit } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { removalRange } from '../../../utils/removal-range';
import { ExtractionPlan, Participant } from './plan.types';

/** Why a participant cannot be rewritten, reported instead of editing a file that has moved on. */
type RewriteRefusal = 'memberMoved' | 'inheritanceMoved';

/**
 * Confirm the file still says what the plan was built from. A plan can sit in the client between
 * being offered and being applied, and an edit computed against text that has since changed would
 * land in the wrong place, so every span the rewrite touches is re-read and compared first.
 *
 * @param text the file's current source text.
 * @param participant the participant to check.
 * @param plan the plan being applied.
 * @returns undefined when the file is unchanged where it matters, or the reason it is not.
 */
export const verifyParticipant = (
    text: string,
    participant: Participant,
    plan: ExtractionPlan
): RewriteRefusal | undefined => {
    for (const key of plan.fields) {
        const member = participant.members.get(key);
        if (!member || text.slice(member.start, member.end) !== member.raw) return 'memberMoved';
    }
    if (participant.inheritanceStart !== undefined && participant.inheritanceEnd !== undefined) {
        if (text.slice(participant.inheritanceStart, participant.inheritanceEnd) !== participant.inheritanceRef) {
            return 'inheritanceMoved';
        }
    }
    return undefined;
};

/**
 * The edits that turn one participant into a deriver of the new base file: every moved member
 * deleted, and the base file put in front of whatever the container inherited before.
 *
 * The removals are merged before they are returned. `removalRange` widens a span to whole lines when
 * nothing else shares them, so two members that sit next to a blank or comment line can widen into
 * each other, and LSP requires the edits of one file to be disjoint.
 *
 * @param doc the participant's file, as an open buffer or read from disk.
 * @param participant the container being rewritten.
 * @param plan the plan being applied.
 * @param reference the inheritance reference naming the new base file, from `relativeRulesReference`.
 * Absent when the fields move onto the base the container already inherits, where the inheritance
 * line is already right and touching it would only churn the file.
 * @returns the file's edits, in ascending order.
 */
export const buildConsumerEdits = (
    doc: TextDocument,
    participant: Participant,
    plan: ExtractionPlan,
    reference?: string
): TextEdit[] => {
    const spans: Array<{ start: number; end: number }> = [];
    for (const key of plan.fields) {
        const member = participant.members.get(key);
        if (!member) continue;
        const range = removalRange(doc, member.start, member.end);
        spans.push({ start: doc.offsetAt(range.start), end: doc.offsetAt(range.end) });
    }
    spans.sort((a, b) => a.start - b.start);
    const merged: Array<{ start: number; end: number }> = [];
    for (const span of spans) {
        const last = merged[merged.length - 1];
        if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
        else merged.push({ ...span });
    }

    const edits: TextEdit[] = merged.map((span) => ({
        range: { start: doc.positionAt(span.start), end: doc.positionAt(span.end) },
        newText: '',
    }));
    if (reference === undefined) return edits;
    if (participant.inheritanceStart !== undefined && participant.inheritanceEnd !== undefined) {
        // The base file carries the old base over, so replacing the reference keeps the whole chain
        // and its override order: the container still overrides the new base, which overrides the old.
        edits.push({
            range: {
                start: doc.positionAt(participant.inheritanceStart),
                end: doc.positionAt(participant.inheritanceEnd),
            },
            newText: reference,
        });
    } else {
        edits.push({
            range: { start: doc.positionAt(participant.nameEnd), end: doc.positionAt(participant.nameEnd) },
            newText: ` : ${reference}`,
        });
    }
    return edits.sort((a, b) => doc.offsetAt(a.range.start) - doc.offsetAt(b.range.start));
};

/**
 * Combine the edits of every container a plan rewrites in one file into a single, LSP-legal list.
 *
 * A file can hold more than one participating container (a plan over a group and a group nested in
 * it), and each is rewritten on its own, so the lists have to be merged rather than one replacing the
 * other. Removals that meet or overlap after `removalRange` widened them to whole lines are folded
 * into one, since LSP requires the edits of one file to be disjoint.
 *
 * @param doc the file the edits apply to.
 * @param edits every edit built for it, in any order.
 * @returns the merged edits, ascending and non-overlapping.
 */
export const mergeFileEdits = (doc: TextDocument, edits: readonly TextEdit[]): TextEdit[] => {
    const spans = edits
        .map((edit) => ({
            start: doc.offsetAt(edit.range.start),
            end: doc.offsetAt(edit.range.end),
            newText: edit.newText,
        }))
        .sort((a, b) => a.start - b.start || a.end - b.end);
    const merged: typeof spans = [];
    for (const span of spans) {
        const last = merged[merged.length - 1];
        if (last && span.start < last.end && last.newText === '' && span.newText === '') {
            last.end = Math.max(last.end, span.end);
            continue;
        }
        if (last && span.start < last.end) continue;
        merged.push({ ...span });
    }
    return merged.map((span) => ({
        range: { start: doc.positionAt(span.start), end: doc.positionAt(span.end) },
        newText: span.newText,
    }));
};
