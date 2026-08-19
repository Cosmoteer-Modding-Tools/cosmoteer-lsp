import { readFileSync } from 'fs';
import { join } from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { parseText } from '../../../../src/utils/ast.utils';
import { clearBaseFileCache } from '../../../../src/features/refactor/shared-base/base-index';
import { buildBaseInsertText } from '../../../../src/features/refactor/shared-base/base-file.emitter';
import { buildConsumerEdits } from '../../../../src/features/refactor/shared-base/consumer-rewrite';
import {
    AnalysisFile,
    baseIdentityOf,
    buildExtractionPlans,
} from '../../../../src/features/refactor/shared-base/duplicate-field.analysis';
import {
    judgeExistingBase,
    upgradePlansToExistingBase,
} from '../../../../src/features/refactor/shared-base/existing-base';
import { resolveBaseTarget } from '../../../../src/features/refactor/shared-base/base-index';
import { BaseLocation, ExtractionPlan } from '../../../../src/features/refactor/shared-base/plan.types';
import { FIXTURES_DIR } from '../../../helpers';

// Three part files that inherit one base file and nothing else does. The fields they repeat belong
// in that base rather than in a new file wedged in front of it, which is only true because the three
// of them are every inheritor there is.
const MOD_DIR = join(FIXTURES_DIR, 'shared-base-existing-mod').replace(/\\/g, '/');
const PARTS_DIR = `${MOD_DIR}/parts`;
const BASE_FILE = `${MOD_DIR}/base_hull.rules`;
const NAMES = ['hull_a.rules', 'hull_b.rules', 'hull_c.rules'];
/** The three above plus hull_d.rules, which inherits the same base and disagrees on every field. */
const ALL_INHERITORS = [...NAMES, 'hull_d.rules'];
const IDENTITY = baseIdentityOf('<../base_hull.rules>/Part', PARTS_DIR) ?? '';
const LOCATION: BaseLocation = { fsPath: BASE_FILE, groupPath: ['Part'] };

const load = (): AnalysisFile[] =>
    NAMES.map((name) => {
        const fsPath = `${PARTS_DIR}/${name}`;
        const text = readFileSync(fsPath, { encoding: 'utf-8' });
        return { document: parseText(text, fsPath), text, fsPath, uri: `file:///${fsPath}` };
    });

const basePlan = (): ExtractionPlan => {
    const plans = buildExtractionPlans(load(), { anchorDir: MOD_DIR });
    expect(plans).toHaveLength(1);
    return plans[0];
};

const counts = (howMany: number): Map<string, number> => new Map([[IDENTITY, howMany]]);
const locations = new Map<string, BaseLocation>([[IDENTITY, LOCATION]]);

beforeEach(() => clearBaseFileCache());

describe('moving repeated fields into the base the files already inherit', () => {
    it('is offered when the participants are every container that inherits that base', async () => {
        const [plan] = await upgradePlansToExistingBase([basePlan()], MOD_DIR, counts(3), locations);
        expect(plan.tier).toBe('existingBase');
        expect(plan.baseFsPath).toBe(BASE_FILE);
        expect(plan.existingBase).toEqual({ fsPath: BASE_FILE, groupPath: ['Part'] });
        // Nothing is written in front of the base, so there is no reference to carry over.
        expect(plan.inheritedRef).toBeUndefined();
        expect(plan.fields).toEqual(['density', 'isrotateable', 'crewspeedfactor']);
    });

    it('is refused when another inheritor is not accounted for', async () => {
        // A fourth inheritor could silently gain all three fields, which is the one thing the offer
        // has to make impossible. Without the file index there is no way to tell, so it is refused.
        expect(await judgeExistingBase(basePlan(), MOD_DIR, counts(4), locations)).toBe('otherInheritors');
        const [plan] = await upgradePlansToExistingBase([basePlan()], MOD_DIR, counts(4), locations);
        expect(plan.tier).toBe('sharedBase');
    });

    it('is still offered when the other inheritor declares those fields itself', async () => {
        // hull_d.rules inherits the same base and writes its own Density, IsRotateable and
        // CrewSpeedFactor, so its own values win whatever the base gains and it cannot be changed.
        const files = new Map([[IDENTITY, new Set(ALL_INHERITORS.map((name) => `${PARTS_DIR}/${name}`))]]);
        const judged = await judgeExistingBase(basePlan(), MOD_DIR, counts(4), locations, files);
        expect(typeof judged).not.toBe('string');

        // One field it does not declare is enough to put the offer back to a new file, since that
        // field is what it would silently gain.
        const partial = { ...basePlan(), fields: ['density', 'isrotateable', 'isflippable'] };
        expect(await judgeExistingBase(partial, MOD_DIR, counts(4), locations, files)).toBe('otherInheritors');
    });

    it('is refused when the base file is itself one of the files being rewritten', async () => {
        // The two paths reach the check from different producers: a directory walk hands back the
        // platform separator while a resolved base location is always slash-normalized, so the
        // comparison has to even them out or it never fires on Windows and the insert and the
        // removals collide in one file.
        const plan = basePlan();
        const hosted: ExtractionPlan = {
            ...plan,
            participants: [
                { ...plan.participants[0], fsPath: BASE_FILE.replace(/\//g, '\\') },
                ...plan.participants.slice(1),
            ],
        };
        expect(await judgeExistingBase(hosted, MOD_DIR, counts(3), locations)).toBe('selfHosted');
    });

    it('is refused when the base already declares one of the fields', async () => {
        // The neighbouring fixture's base writes its own Density, which the participants override.
        const otherMod = join(FIXTURES_DIR, 'shared-base-mod').replace(/\\/g, '/');
        const files = ['armor_a.rules', 'armor_b.rules', 'armor_c.rules'].map((name) => {
            const fsPath = `${otherMod}/parts/${name}`;
            const text = readFileSync(fsPath, { encoding: 'utf-8' });
            return { document: parseText(text, fsPath), text, fsPath, uri: `file:///${fsPath}` };
        });
        const plans = buildExtractionPlans(files, { anchorDir: otherMod });
        const identity = baseIdentityOf('<../base_part.rules>/Part', `${otherMod}/parts`) ?? '';
        const verdict = await judgeExistingBase(
            plans[0],
            otherMod,
            new Map([[identity, 3]]),
            new Map([[identity, { fsPath: `${otherMod}/base_part.rules`, groupPath: ['Part'] }]])
        );
        expect(verdict).toBe('alreadyDeclared');
    });

    it('is refused when the base file is not part of the mod being edited', async () => {
        expect(await judgeExistingBase(basePlan(), `${MOD_DIR}/parts`, counts(3), locations)).toBe('foreignBase');
    });

    it('writes the members into the base group at the indentation it already uses', async () => {
        const [plan] = await upgradePlansToExistingBase([basePlan()], MOD_DIR, counts(3), locations);
        const target = await resolveBaseTarget(LOCATION);
        expect(target).toBeDefined();
        const insert = buildBaseInsertText(plan, target!);
        expect(insert).toBe('\n\tDensity = 3\n\tIsRotateable = false\n\tCrewSpeedFactor = 0');

        // Replayed against the file, the insert lands inside the braces and after what is there.
        const text = readFileSync(BASE_FILE, { encoding: 'utf-8' });
        const rewritten = text.slice(0, target!.insertOffset) + insert + text.slice(target!.insertOffset);
        expect(rewritten).toBe(
            [
                'Part',
                '{',
                '\tMaxHealth = 1000',
                '\tDensity = 3',
                '\tIsRotateable = false',
                '\tCrewSpeedFactor = 0',
                '}',
                '',
            ].join('\n')
        );
    });

    it('leaves the inheritance line of every participant untouched', async () => {
        const [plan] = await upgradePlansToExistingBase([basePlan()], MOD_DIR, counts(3), locations);
        const participant = plan.participants[0];
        const text = readFileSync(participant.fsPath, { encoding: 'utf-8' });
        const doc = TextDocument.create(participant.uri, 'rules', 0, text);
        expect(TextDocument.applyEdits(doc, buildConsumerEdits(doc, participant, plan))).toBe(
            [
                'Part : <../base_hull.rules>/Part',
                '{',
                '\tNameKey = "Parts/HullA"',
                '\tID = test.hull_a',
                '\tMaxHealth = 4000',
                '}',
                '',
            ].join('\n')
        );
    });
});
