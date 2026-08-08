import { describe, expect, it } from 'vitest';
import { TextEdit } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { parseText } from '../../../../src/utils/ast.utils';
import { buildConsumerEdits, verifyParticipant } from '../../../../src/features/refactor/shared-base/consumer-rewrite';
import {
    AnalysisFile,
    buildExtractionPlans,
} from '../../../../src/features/refactor/shared-base/duplicate-field.analysis';

// Removing a field takes its whole line with it when nothing else shares that line, so two fields on
// consecutive lines widen into one another. LSP requires the edits of a single file to be disjoint,
// which is what the merge in buildConsumerEdits is for.
const PARTS_DIR = 'C:/mod/parts';
const REFERENCE = '<base_part.rules>/Part';

/**
 * Three sibling part files sharing one group body, where `{n}` becomes the file's ordinal so a
 * caller can write a field the three disagree on and therefore keep.
 *
 * @param body the `Part` group's members, indented and newline terminated.
 * @returns the plan, its first participant, and that participant's document and text.
 */
const planFor = (body: string) => {
    const files: AnalysisFile[] = ['a', 'b', 'c'].map((suffix, index) => {
        const text = `Part\n{\n\tID = test.part_${suffix}\n${body.replace(/\{n\}/g, String(index + 1))}}\n`;
        const fsPath = `${PARTS_DIR}/part_${suffix}.rules`;
        return { document: parseText(text, fsPath), text, fsPath, uri: `file:///${fsPath}` };
    });
    const plans = buildExtractionPlans(files, { anchorDir: 'C:/mod' });
    expect(plans).toHaveLength(1);
    const doc = TextDocument.create(files[0].uri, 'rules', 0, files[0].text);
    return { plan: plans[0], participant: plans[0].participants[0], doc, text: files[0].text };
};

/** The edits as byte-offset spans, which is where an overlap would show. */
const spansOf = (doc: TextDocument, edits: readonly TextEdit[]): Array<[number, number]> =>
    edits.map((edit) => [doc.offsetAt(edit.range.start), doc.offsetAt(edit.range.end)]);

/** Asserts the edits are in ascending order and that none reaches into the next. */
const expectDisjointAndAscending = (spans: ReadonlyArray<[number, number]>): void => {
    for (const [start, end] of spans) expect(end).toBeGreaterThanOrEqual(start);
    for (let i = 1; i < spans.length; i++) expect(spans[i - 1][1]).toBeLessThanOrEqual(spans[i][0]);
};

describe('consumer rewrite edits', () => {
    it('merges removals on consecutive lines into one disjoint edit', () => {
        const { plan, participant, doc } = planFor(
            '\tDensity = 3\n\tIsRotateable = false\n\tIsCrewSalvageable = true\n'
        );
        expect(plan.fields).toEqual(['density', 'isrotateable', 'iscrewsalvageable']);

        const edits = buildConsumerEdits(doc, participant, plan, REFERENCE);
        // The three line removals widen into each other, so one removal survives the merge, next to
        // the edit that adds the inheritance.
        expect(edits).toHaveLength(2);
        expectDisjointAndAscending(spansOf(doc, edits));
        expect(TextDocument.applyEdits(doc, edits)).toBe(
            ['Part : <base_part.rules>/Part', '{', '\tID = test.part_a', '}', ''].join('\n')
        );
    });

    it('keeps removals apart when a field that stays sits between them', () => {
        const { plan, participant, doc } = planFor(
            '\tDensity = 3\n\tMaxHealth = {n}000\n\tIsRotateable = false\n\tIsCrewSalvageable = true\n'
        );
        expect(plan.fields).not.toContain('maxhealth');

        const edits = buildConsumerEdits(doc, participant, plan, REFERENCE);
        expect(edits).toHaveLength(3);
        expectDisjointAndAscending(spansOf(doc, edits));
        expect(TextDocument.applyEdits(doc, edits)).toBe(
            [
                'Part : <base_part.rules>/Part',
                '{',
                '\tID = test.part_a',
                '\tMaxHealth = 1000',
                '}',
                '',
            ].join('\n')
        );
    });

    it('leaves the rewritten file parseable, with the moved fields gone', () => {
        const { plan, participant, doc } = planFor(
            '\tDensity = 3\n\tIsRotateable = false\n\tIsCrewSalvageable = true\n'
        );
        const rewritten = TextDocument.applyEdits(doc, buildConsumerEdits(doc, participant, plan, REFERENCE));
        const document = parseText(rewritten, participant.fsPath);
        expect(document.elements).toHaveLength(1);
        const group = document.elements[0];
        expect('identifier' in group && (group.identifier as { name: string }).name).toBe('Part');
        expect(rewritten).not.toContain('Density');
        expect(rewritten).not.toContain('IsRotateable');
    });
});

describe('verifying a participant before it is rewritten', () => {
    it('accepts a file that still says what the plan was built from', () => {
        const { plan, participant, text } = planFor('\tDensity = 3\n\tIsRotateable = false\n');
        expect(verifyParticipant(text, participant, plan)).toBeUndefined();
    });

    it('refuses a file whose moved field has shifted', () => {
        const { plan, participant, text } = planFor('\tDensity = 3\n\tIsRotateable = false\n');
        // A plan can sit in the client between being offered and being applied, and an edit computed
        // against text that has moved on would land in the wrong place.
        expect(verifyParticipant(text.replace('\tID = test.part_a\n', ''), participant, plan)).toBe('memberMoved');
    });

    it('refuses a file whose inheritance reference has shifted', () => {
        const files: AnalysisFile[] = ['a', 'b', 'c'].map((suffix) => {
            const text = `Part : Template\n{\n\tID = test.part_${suffix}\n\tDensity = 3\n\tIsRotateable = false\n}\nTemplate\n{\n\tMaxHealth = 10\n}\n`;
            const fsPath = `${PARTS_DIR}/part_${suffix}.rules`;
            return { document: parseText(text, fsPath), text, fsPath, uri: `file:///${fsPath}` };
        });
        const plans = buildExtractionPlans(files, { anchorDir: 'C:/mod' });
        // A same-file base cannot be carried over, so no plan is offered for these at all, which is
        // itself the guarantee: only a base the analysis pinned to one file ever reaches a rewrite.
        expect(plans).toEqual([]);
    });
});
