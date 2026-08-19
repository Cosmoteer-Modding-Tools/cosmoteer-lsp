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

// Three part files of one fixture mod that inherit the same base and still repeat three fields
// verbatim. The extraction has to notice exactly those three, keep the base they already inherit,
// and leave the per-part identity fields (NameKey, ID) and the differing ones (Size, MaxHealth)
// where the author wrote them.
const MOD_DIR = join(FIXTURES_DIR, 'shared-base-mod').replace(/\\/g, '/');
const PARTS_DIR = `${MOD_DIR}/parts`;
const NAMES = ['armor_a.rules', 'armor_b.rules', 'armor_c.rules'];

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

describe('shared base extraction', () => {
    it('finds the fields all three files repeat, and only those', () => {
        const plan = onlyPlan();
        expect(plan.fields).toEqual(['density', 'isrotateable', 'crewspeedfactor']);
        expect(plan.participants).toHaveLength(3);
        expect(plan.tier).toBe('sharedBase');
    });

    it('never moves an identity field or a field the files disagree on', () => {
        const plan = onlyPlan();
        for (const key of ['namekey', 'id', 'size', 'maxhealth']) expect(plan.fields).not.toContain(key);
    });

    it('puts the base file beside the files that will inherit it', () => {
        const plan = onlyPlan();
        expect(plan.baseFsPath).toBe(`${PARTS_DIR}/base_armor.rules`);
    });

    it('carries the base the files already inherit over to the generated file, rebased', () => {
        const plan = onlyPlan();
        // The consumers say `<../base_part.rules>/Part` from `parts/`; the base file lands in the same
        // directory, so it has to say the very same thing.
        expect(plan.inheritedRef).toBe('<../base_part.rules>/Part');
        expect(buildBaseFileText(plan)).toBe(
            [
                'Part : <../base_part.rules>/Part',
                '{',
                '\tDensity = 3',
                '\tIsRotateable = false',
                '\tCrewSpeedFactor = 0',
                '}',
                '',
            ].join('\n')
        );
    });

    it('rewrites a consumer to inherit the base and drop the moved fields', () => {
        const plan = onlyPlan();
        const participant = plan.participants[0];
        const text = readFileSync(participant.fsPath, { encoding: 'utf-8' });
        const doc = TextDocument.create(participant.uri, 'rules', 0, text);
        const reference = relativeRulesReference(PARTS_DIR, plan.baseFsPath, plan.groupName);
        expect(reference).toBe('<base_armor.rules>/Part');

        const edits = buildConsumerEdits(doc, participant, plan, reference);
        expect(TextDocument.applyEdits(doc, edits)).toBe(
            [
                'Part : <base_armor.rules>/Part',
                '{',
                '\tNameKey = "Parts/ArmorA"',
                '\tID = test.armor_a',
                '\tSize = [1, 1]',
                '\tMaxHealth = 4000',
                '}',
                '',
            ].join('\n')
        );
    });

    it('offers nothing when only two files agree', () => {
        const files = load().slice(0, 2);
        expect(buildExtractionPlans(files, { anchorDir: MOD_DIR })).toEqual([]);
    });
});
