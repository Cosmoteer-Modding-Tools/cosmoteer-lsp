import { describe, expect, it } from 'vitest';
import { join } from 'path';
import { buildAssertReport } from '../../src/cli/assert/assert';
import { assertExitCode } from '../../src/cli/assert/exit-code';
import { AssertReport } from '../../src/cli/assert/model';
import { FIXTURES, GAME_DATA, reportFor } from './assert-fixture';

// The report is what the exit code is read off, so it is built here without a language server: the
// findings a scan would publish are handed in directly, which keeps the counting, the grouping and
// the verdict testable on their own.

describe('the report on a mod with problems', () => {
    it('counts what stops the mod loading and never counts what it could not judge', async () => {
        const report = await reportFor('assert-mod', [1, 11]);
        const mod = report.mods[0];
        expect(mod.id).toBe('Test.AssertMod');
        expect(mod.name).toBe('Assert Fixture');
        // Two targets that resolve to nothing, one unknown verb and one missing required field.
        expect(mod.loadBlocking).toBe(4);
        expect(mod.counts.failed).toBe(4);
        expect(mod.counts.ok).toBe(2);
        expect(mod.counts.unverifiable).toBe(mod.counts.actions - 6);
        expect(mod.counts.ok + mod.counts.failed + mod.counts.unverifiable).toBe(mod.counts.actions);
        expect(mod.verdict).toBe('does-not-load');
        expect(report.complete).toBe(false);
    });

    it('names the action list nothing includes without judging or failing any of it', async () => {
        const report = await reportFor('assert-mod', [1, 11]);
        const mod = report.mods[0];
        expect(mod.orphanActionFiles).toEqual([{ path: 'orphan_actions.rules', actions: 1 }]);
        // Its entry is named through the file rather than counted among the mod's own actions.
        expect(mod.disclosures.filter((entry) => entry.reason === 'unfollowed-include')).toHaveLength(1);
        expect(mod.counts.actions).toBe(12);
    });

    it('keeps the broken action of the included file, which is what proves the file was read', async () => {
        const report = await reportFor('assert-mod', [1, 11]);
        const actions = report.mods[0].manifests.flatMap((manifest) => manifest.actions);
        const fromFragment = actions.filter((action) => action.path === 'fragment_actions.rules');
        expect(fromFragment).toHaveLength(2);
        expect(fromFragment.map((action) => action.mark)).toEqual(['ok', 'failed']);
    });
});

describe('the report on a mod that loads', () => {
    it('says so and leaves nothing unjudged', async () => {
        const report = await reportFor('assert-clean-mod');
        expect(report.loadBlocking).toBe(0);
        expect(report.unverifiable).toBe(0);
        expect(report.complete).toBe(true);
        expect(report.mods[0].verdict).toBe('loads');
        expect(report.mods[0].disclosures).toEqual([]);
    });

    it('does not claim a mod loads when something in it could not be judged', async () => {
        const report = await reportFor('assert-unsure-mod');
        expect(report.loadBlocking).toBe(0);
        expect(report.complete).toBe(false);
        expect(report.mods[0].verdict).toBe('unknown');
        expect(report.mods[0].disclosures.map((entry) => entry.reason)).toEqual(['tolerated-missing-target']);
    });
});

describe('the exit code', () => {
    /**
     * A report with only the numbers the exit code reads.
     *
     * @param loadBlocking how many things stop a mod loading.
     * @param complete whether everything was judged.
     * @returns the report.
     */
    const outcome = (loadBlocking: number, complete: boolean): AssertReport =>
        ({ loadBlocking, complete, unverifiable: complete ? 0 : 1 }) as AssertReport;

    it('passes a mod that loads with nothing left unjudged', () => {
        expect(assertExitCode(outcome(0, true), false)).toBe(0);
    });

    it('fails on anything that stops the mod loading', () => {
        expect(assertExitCode(outcome(1, true), false)).toBe(1);
        expect(assertExitCode(outcome(1, false), false)).toBe(1);
        // Accepting an incomplete check never lowers a real failure.
        expect(assertExitCode(outcome(1, false), true)).toBe(1);
    });

    it('answers an incomplete check with its own code, and lowers it only when asked to', () => {
        expect(assertExitCode(outcome(0, false), false)).toBe(6);
        expect(assertExitCode(outcome(0, false), true)).toBe(0);
    });

    it('gives the three fixture mods the three answers', async () => {
        expect(assertExitCode(await reportFor('assert-mod', [1, 11]), false)).toBe(1);
        expect(assertExitCode(await reportFor('assert-clean-mod'), false)).toBe(0);
        expect(assertExitCode(await reportFor('assert-unsure-mod'), false)).toBe(6);
        expect(assertExitCode(await reportFor('assert-unsure-mod'), true)).toBe(0);
    });
});

describe('the manifest the game reads before any action runs', () => {
    it('fails a mod whose ID the game refuses, with no action involved', async () => {
        const modDir = join(FIXTURES, 'assert-manifests', 'dotless');
        const report = await buildAssertReport({
            folders: [modDir],
            gameData: GAME_DATA,
            findings: [],
            checkedFiles: [join(modDir, 'mod.rules')],
            files: 1,
            passes: 1,
            elapsedMs: 0,
        });
        expect(report.loadBlocking).toBe(1);
        expect(report.mods[0].manifests[0].failures[0].subject).toBe('ID');
        expect(report.mods[0].verdict).toBe('does-not-load');
        expect(assertExitCode(report, true)).toBe(1);
    });
});

describe('a folder the scan did not reach', () => {
    it('marks every action of an unchecked file as unjudged instead of passing it', async () => {
        const modDir = join(FIXTURES, 'assert-clean-mod');
        const report = await buildAssertReport({
            folders: [modDir],
            gameData: GAME_DATA,
            findings: [],
            checkedFiles: [],
            files: 0,
            passes: 1,
            elapsedMs: 0,
        });
        expect(report.mods[0].counts.unverifiable).toBe(1);
        expect(report.mods[0].disclosures[0].reason).toBe('file-not-checked');
        expect(assertExitCode(report, false)).toBe(6);
    });
});
