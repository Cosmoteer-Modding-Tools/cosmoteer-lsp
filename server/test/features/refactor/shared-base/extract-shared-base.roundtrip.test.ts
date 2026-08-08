import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { AbstractNode, isAssignmentNode, isGroupNode } from '../../../../src/core/ast/ast';
import { FullNavigationStrategy } from '../../../../src/features/navigation/full.navigation-strategy';
import { getStartOfAstNode, parseText } from '../../../../src/utils/ast.utils';
import { stepIntoNode } from '../../../../src/semantics/reference-resolver';
import { buildBaseFileText, relativeRulesReference } from '../../../../src/features/refactor/shared-base/base-file.emitter';
import { buildConsumerEdits } from '../../../../src/features/refactor/shared-base/consumer-rewrite';
import {
    AnalysisFile,
    buildExtractionPlans,
} from '../../../../src/features/refactor/shared-base/duplicate-field.analysis';
import { memberSpanOf, normalizeMemberText } from '../../../../src/features/refactor/shared-base/member-record';
import { ExtractionPlan } from '../../../../src/features/refactor/shared-base/plan.types';
import { FIXTURES_DIR } from '../../../helpers';

// The whole point of the refactoring, checked end to end: the extraction is only correct if the game
// still reads every moved field off the file it was moved out of. The fixture mod is copied to a
// scratch directory, the plan is applied for real (base file written, consumers rewritten), and each
// moved field is then asked for again through the real cross-file inheritance resolution, which is
// what the game's own lookup mirrors. Nothing here is asserted against the plan, only against what a
// reader of the rewritten files can still find.
const token = CancellationToken.None;
const navigation = new FullNavigationStrategy();
const NAMES = ['hull_a.rules', 'hull_b.rules', 'hull_c.rules'];

let root: string;
let partsDir: string;
let plan: ExtractionPlan;
/** Each moved field's normalized text as the consumer wrote it, captured before the rewrite. */
let before: Map<string, string>;

const load = (dir: string): AnalysisFile[] =>
    NAMES.map((name) => {
        const fsPath = `${dir}/${name}`;
        const text = readFileSync(fsPath, { encoding: 'utf-8' });
        return { document: parseText(text, fsPath), text, fsPath, uri: `file:///${fsPath}` };
    });

/** The `Part` group of a rewritten consumer, re-read from disk. */
const consumerPart = (name: string) => {
    const fsPath = `${partsDir}/${name}`;
    const text = readFileSync(fsPath, { encoding: 'utf-8' });
    const group = parseText(text, fsPath).elements.find(isGroupNode);
    if (!group) throw new Error(`${name} no longer parses as a group after the rewrite`);
    return { fsPath, text, group };
};

/** The spelling the donor gave a moved field, so the lookup asks for the name a reader would type. */
const spellingOf = (key: string): string => {
    const member = plan.donor.members.get(key);
    if (!member) throw new Error(`the plan moved "${key}" without a member record`);
    return member.name;
};

beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'sharedbase-')).replace(/\\/g, '/');
    cpSync(join(FIXTURES_DIR, 'shared-base-roundtrip'), root, { recursive: true });
    partsDir = `${root}/parts`;

    const files = load(partsDir);
    const plans = buildExtractionPlans(files, { anchorDir: root });
    expect(plans).toHaveLength(1);
    plan = plans[0];
    before = new Map(plan.fields.map((key) => [key, plan.donor.members.get(key)!.norm]));

    writeFileSync(plan.baseFsPath, buildBaseFileText(plan));
    for (const participant of plan.participants) {
        const source = files.find((file) => file.fsPath === participant.fsPath)!;
        const doc = TextDocument.create(participant.uri, 'rules', 0, source.text);
        const reference = relativeRulesReference(partsDir, plan.baseFsPath, plan.groupName);
        writeFileSync(participant.fsPath, TextDocument.applyEdits(doc, buildConsumerEdits(doc, participant, plan, reference)));
    }
});

afterAll(() => {
    rmSync(root, { recursive: true, force: true });
});

describe('a shared base extraction applied to files on disk', () => {
    it('moves the fields the three hull files repeat into one base beside them', () => {
        expect(plan.tier).toBe('sharedBase');
        expect(plan.fields).toEqual(['density', 'isrotateable', 'constructionwork']);
        expect(plan.baseFsPath).toBe(`${partsDir}/base_hull.rules`);
        expect(readFileSync(plan.baseFsPath, { encoding: 'utf-8' })).toBe(
            [
                'Part : <../base_part.rules>/Part',
                '{',
                '\tDensity = 2.5',
                '\tIsRotateable = true',
                '\tConstructionWork = 8',
                '}',
                '',
            ].join('\n')
        );
    });

    it('leaves no consumer declaring a moved field any more', () => {
        for (const name of NAMES) {
            const { group } = consumerPart(name);
            for (const key of plan.fields) expect(stepIntoNode(group, spellingOf(key))).toBeFalsy();
        }
    });

    it('reaches every moved field again through the inheritance chain, unchanged', async () => {
        const baseText = readFileSync(plan.baseFsPath, { encoding: 'utf-8' });
        for (const name of NAMES) {
            const { fsPath, group } = consumerPart(name);
            for (const key of plan.fields) {
                const resolved = await navigation.navigate(spellingOf(key), group, fsPath, token);
                expect(resolved, `${name} lost ${key}`).toBeTruthy();

                // The lookup has to land in the generated base file, not somewhere the consumer
                // still happens to declare.
                const owner = getStartOfAstNode(resolved as AbstractNode);
                expect(owner.uri.replace(/\\/g, '/').toLowerCase()).toBe(plan.baseFsPath.toLowerCase());

                // And the base file has to say what the consumer used to say, word for word.
                const member = owner.elements
                    .filter(isGroupNode)
                    .flatMap((container) => container.elements)
                    .find((element) => isAssignmentNode(element) && element.right === resolved);
                expect(member, `${key} resolved to something that is not a member`).toBeDefined();
                const span = memberSpanOf(member!)!;
                expect(normalizeMemberText(baseText.slice(span.start, span.end))).toBe(before.get(key));
            }
        }
    }, 30_000);

    it('still reaches the base the consumers inherited before, now one hop further away', async () => {
        // The generated file carries the old base over, so the whole chain and its override order
        // survive: consumer, then the generated base, then the base it was already inheriting.
        const { fsPath, group } = consumerPart('hull_a.rules');
        const resolved = await navigation.navigate('IsBuildable', group, fsPath, token);
        expect(resolved).toBeTruthy();
        expect((resolved as unknown as { valueType: { value: unknown } }).valueType.value).toBe(true);
        expect(getStartOfAstNode(resolved as AbstractNode).uri.replace(/\\/g, '/').toLowerCase()).toBe(
            `${root}/base_part.rules`.toLowerCase()
        );
    }, 30_000);

    it('keeps a field the consumers disagreed on in the consumer', async () => {
        const { fsPath, group } = consumerPart('hull_b.rules');
        expect(stepIntoNode(group, 'MaxHealth')).toBeTruthy();
        const resolved = await navigation.navigate('MaxHealth', group, fsPath, token);
        expect((resolved as unknown as { valueType: { value: unknown } }).valueType.value).toBe(2000);
    }, 30_000);
});
