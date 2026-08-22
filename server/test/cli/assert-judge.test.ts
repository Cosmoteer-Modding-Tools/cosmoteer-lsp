import { describe, expect, it } from 'vitest';
import { join, resolve } from 'path';
import { ActionRecord, collectManifestActions } from '../../src/cli/assert/actions';
import { DocumentCache } from '../../src/cli/assert/documents';
import { isTypableTarget, judgeAction, JudgeContext, targetPathShape } from '../../src/cli/assert/judge';
import { AssertMark, UnverifiableReason } from '../../src/cli/assert/model';
import type { LintFinding } from '../../src/cli/findings';

// What the judge answers is the whole product of the load check, so every branch of it is pinned
// here against the fixture mod, which carries one action of each kind.

const MOD_DIR = join(__dirname, 'fixtures', 'assert-mod');
const DATA_DIR = resolve(__dirname, '..', 'fixtures', 'workspace', 'Data');

/**
 * The judge context a test runs in: every file counts as checked, and paths are shown relative to
 * the fixture mod.
 *
 * @param checkedFiles the files to count as checked, or undefined to count all of them.
 * @returns the context.
 */
const context = (checkedFiles?: string[]): JudgeContext => ({
    modRoot: MOD_DIR,
    dataRoot: DATA_DIR,
    checked: (file) => checkedFiles === undefined || checkedFiles.some((known) => file.endsWith(known)),
    relative: (file) => file.replace(/\\/g, '/').split('/').pop() ?? file,
});

/**
 * Read the fixture mod's actions the way the check reads them.
 *
 * @returns every action entry the manifest runs.
 */
const fixtureRecords = async (): Promise<ActionRecord[]> => {
    const cache = new DocumentCache();
    const manifest = await cache.get(join(MOD_DIR, 'mod.rules'));
    return (await collectManifestActions(manifest!, MOD_DIR, cache)).records;
};

/**
 * A finding the server would publish inside one action.
 *
 * @param record the action it belongs to.
 * @param message the message the mod action pass writes.
 * @param severity the severity it carries, error unless another is given.
 * @returns the finding.
 */
const findingIn = (record: ActionRecord, message: string, severity: LintFinding['severity'] = 'error'): LintFinding => ({
    file: record.file,
    path: 'mod.rules',
    ruleId: 'mod-action',
    named: true,
    severity,
    message,
    startLine: record.line,
    startColumn: record.column,
    endLine: record.line,
    endColumn: record.column + 1,
    unnecessary: false,
});

describe('judging the fixture mod', () => {
    it('answers each action with the mark and the reason it earned', async () => {
        const records = await fixtureRecords();
        const targetMissing = new Set([1, 11]);
        const judged = records.map((record, index) =>
            judgeAction(record, targetMissing.has(index) ? [findingIn(record, 'Action target not found')] : [], context())
        );
        const answers = judged.map(({ verdict }) => [verdict.verb, verdict.mark, verdict.reason ?? verdict.effect]);
        expect(answers).toEqual([
            ['Add', 'ok', undefined],
            ['Add', 'failed', 'game-stops'],
            ['AddBase', 'unverifiable', 'indexed-add-base'],
            ['Add', 'unverifiable', 'index-segment'],
            ['Add', 'unverifiable', 'navigation-segment'],
            ['Add', 'unverifiable', 'create-if-not-existing'],
            ['Overrides', 'unverifiable', 'cross-mod-target'],
            ['Remove', 'unverifiable', 'tolerated-missing-target'],
            ['Frobnicate', 'failed', 'mod-dropped'],
            ['AddMany', 'failed', 'mod-dropped'],
            ['Add', 'ok', undefined],
            ['Remove', 'failed', 'game-stops'],
        ]);
    });

    it('says what the game does with each failure, which is not the same thing twice', async () => {
        const records = await fixtureRecords();
        const unknownVerb = judgeAction(records[8], [], context()).verdict;
        expect(unknownVerb.detail).toContain('starts without this mod');
        const missingTarget = judgeAction(records[1], [findingIn(records[1], 'Action target not found')], context())
            .verdict;
        expect(missingTarget.detail).toContain('stops loading');
    });

    it('discloses every reason it could not judge an action, one entry per action', async () => {
        const records = await fixtureRecords();
        const reasons = records
            .flatMap((record) => judgeAction(record, [], context()).disclosures)
            .map((disclosure) => disclosure.reason);
        for (const reason of [
            'indexed-add-base',
            'index-segment',
            'navigation-segment',
            'create-if-not-existing',
            'cross-mod-target',
            'tolerated-missing-target',
            'untyped-fragment',
        ] satisfies UnverifiableReason[]) {
            expect(reasons, reason).toContain(reason);
        }
    });

    it('counts every action exactly once', async () => {
        const records = await fixtureRecords();
        const marks = records.map((record) => judgeAction(record, [], context()).verdict.mark);
        const counted: Record<AssertMark, number> = { ok: 0, failed: 0, unverifiable: 0 };
        for (const mark of marks) counted[mark]++;
        expect(counted.ok + counted.failed + counted.unverifiable).toBe(records.length);
    });
});

describe('judging what the check could not reach', () => {
    it('says so when the scan never checked the file the action is in', async () => {
        const records = await fixtureRecords();
        const judged = judgeAction(records[0], [], context([]));
        expect(judged.verdict.mark).toBe('unverifiable');
        expect(judged.verdict.reason).toBe('file-not-checked');
    });

    it('refuses to explain a finding it does not know, rather than passing it over', async () => {
        const records = await fixtureRecords();
        const judged = judgeAction(records[0], [findingIn(records[0], 'Something new the server reports')], context());
        expect(judged.verdict.mark).toBe('failed');
        expect(judged.verdict.effect).toBe('unknown');
        expect(judged.disclosures.map((entry) => entry.reason)).toContain('unknown-finding');
    });

    it('reads an action that applies to nothing as loading, and says it changes nothing', async () => {
        const records = await fixtureRecords();
        const judged = judgeAction(
            records[0],
            [findingIn(records[0], 'Mod action cannot target a language string file')],
            context()
        );
        expect(judged.verdict.mark).toBe('ok');
        expect(judged.verdict.effect).toBe('no-effect');
        expect(judged.verdict.detail).toContain('changes nothing');
    });

    it('leaves the effect open where the game behaviour was not established', async () => {
        const records = await fixtureRecords();
        // The fixture's AddBase with its Index taken off, since an indexed one is answered before
        // any finding is read. An AddBase takes any node as its source, so a wrongly shaped one is
        // not the read failure it is on an AddMany, and nothing here established what the game
        // does with it.
        const source = records[2];
        const withoutIndex: ActionRecord = {
            ...source,
            action: {
                ...source.action,
                presentFields: new Set([...source.action.presentFields].filter((field) => field !== 'index')),
            },
        };
        const judged = judgeAction(
            withoutIndex,
            [findingIn(withoutIndex, 'Mod action source has the wrong shape')],
            context()
        );
        expect(judged.verdict.mark).toBe('failed');
        expect(judged.verdict.effect).toBe('unknown');
        expect(judged.verdict.detail).toContain('was not established');

        // The same finding on an AddMany is a read failure, which the game answers by dropping the
        // whole mod. The fixture's AddMany is missing its source, so the field is put back here to
        // reach the branch that reads the finding.
        const addMany: ActionRecord = {
            ...records[9],
            action: {
                ...records[9].action,
                presentFields: new Set([...records[9].action.presentFields, 'manytoadd']),
            },
        };
        const judgedAddMany = judgeAction(
            addMany,
            [findingIn(addMany, 'Mod action source has the wrong shape')],
            context()
        );
        expect(judgedAddMany.verdict.mark).toBe('failed');
        expect(judgedAddMany.verdict.effect).toBe('mod-dropped');
    });

    it('leaves an editor limit out of the failures, since the game loads such an action', async () => {
        const records = await fixtureRecords();
        const judged = judgeAction(
            records[0],
            [findingIn(records[0], 'This AddBase inserts at an index, which the editor does not follow', 'info')],
            context()
        );
        expect(judged.verdict.mark).toBe('ok');
    });
});

describe('reading a target path', () => {
    it('names the parts of a path that make it order dependent', () => {
        expect(targetPathShape('"<a.rules>/B/0"')).toBeUndefined();
        expect(targetPathShape('<a.rules>/B/0')?.hasIndexSegment).toBe(true);
        expect(targetPathShape('<a.rules>/B/^')?.hasNavigationSegment).toBe(true);
        expect(targetPathShape('&<a.rules>/B')?.file).toBe('a.rules');
    });

    it('calls a plain path typable and everything else not', () => {
        expect(isTypableTarget('<a.rules>/B/C')).toBe(true);
        expect(isTypableTarget('<a.rules>')).toBe(true);
        expect(isTypableTarget('<a.rules>/B/2')).toBe(false);
        expect(isTypableTarget('<a.rules>/B/..')).toBe(false);
        expect(isTypableTarget('B/C')).toBe(false);
    });
});
