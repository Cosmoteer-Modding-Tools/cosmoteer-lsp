import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { parseText } from '../../../../src/utils/ast.utils';
import { buildBaseFileText, relativeRulesReference } from '../../../../src/features/refactor/shared-base/base-file.emitter';
import { buildConsumerEdits } from '../../../../src/features/refactor/shared-base/consumer-rewrite';
import {
    AnalysisFile,
    buildExtractionPlans,
} from '../../../../src/features/refactor/shared-base/duplicate-field.analysis';
import { FIXTURES_DIR } from '../../../helpers';

// The other shape a duplication takes: three part files nobody ever gave a base, copied from one
// another and edited apart. Nothing is inherited, so the generated base declares no inheritance of
// its own and every consumer gains an inheritance list where it had none, which is the one case the
// rewrite inserts text instead of replacing it.
const MOD_DIR = join(FIXTURES_DIR, 'shared-base-clone-mod').replace(/\\/g, '/');
const PARTS_DIR = `${MOD_DIR}/parts`;
const NAMES = ['thruster_a.rules', 'thruster_b.rules', 'thruster_c.rules'];

const load = (): AnalysisFile[] =>
    NAMES.map((name) => {
        const fsPath = `${PARTS_DIR}/${name}`;
        const text = readFileSync(fsPath, { encoding: 'utf-8' });
        return { document: parseText(text, fsPath), text, fsPath, uri: `file:///${fsPath}` };
    });

const onlyPlan = () => {
    const plans = buildExtractionPlans(load(), { anchorDir: MOD_DIR });
    expect(plans).toHaveLength(1);
    return plans[0];
};

describe('shared base extraction of a clone family', () => {
    it('reports the tier as cloneFamily when no participant inherits anything', () => {
        const plan = onlyPlan();
        expect(plan.tier).toBe('cloneFamily');
        expect(plan.inheritedRef).toBeUndefined();
        expect(plan.participants).toHaveLength(3);
        for (const participant of plan.participants) expect(participant.inheritanceRef).toBeUndefined();
    });

    it('moves the fields the three copies agree on, in the donor order', () => {
        const plan = onlyPlan();
        expect(plan.fields).toEqual(['density', 'isrotateable', 'iscrewsalvageable']);
        expect(plan.baseFsPath).toBe(`${PARTS_DIR}/base_thruster.rules`);
    });

    it('emits a base file that declares no inheritance of its own', () => {
        const plan = onlyPlan();
        expect(buildBaseFileText(plan)).toBe(
            [
                'Part',
                '{',
                '\tDensity = 1.5',
                '\tIsRotateable = true',
                '\tIsCrewSalvageable = false',
                '}',
                '',
            ].join('\n')
        );
    });

    it('inserts an inheritance list after the group name rather than replacing one', () => {
        const plan = onlyPlan();
        const participant = plan.participants[0];
        const text = readFileSync(participant.fsPath, { encoding: 'utf-8' });
        const doc = TextDocument.create(participant.uri, 'rules', 0, text);
        const reference = relativeRulesReference(PARTS_DIR, plan.baseFsPath, plan.groupName);

        const edits = buildConsumerEdits(doc, participant, plan, reference);
        // The inserting edit is the empty range right after `Part`, which is what tells an insertion
        // apart from the replacement a participant with an existing base would get.
        const insertion = edits.find((edit) => edit.newText.length > 0);
        expect(insertion).toBeDefined();
        expect(insertion!.newText).toBe(' : <base_thruster.rules>/Part');
        expect(insertion!.range.start).toEqual(insertion!.range.end);
        expect(insertion!.range.start).toEqual({ line: 0, character: 4 });

        expect(TextDocument.applyEdits(doc, edits)).toBe(
            [
                'Part : <base_thruster.rules>/Part',
                '{',
                '\tNameKey = "Parts/ThrusterA"',
                '\tID = test.thruster_a',
                '\tSize = [1, 1]',
                '\tMaxHealth = 2000',
                '}',
                '',
            ].join('\n')
        );
    });
});
