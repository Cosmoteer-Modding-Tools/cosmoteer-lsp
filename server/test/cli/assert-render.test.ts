import { describe, expect, it } from 'vitest';
import { assertJsonReport, assertTextReport, STANDING_LIMITS } from '../../src/cli/assert/render';
import { reportFor } from './assert-fixture';

// The report is the only thing a reader sees, so what it always says matters as much as what it
// says about a particular mod. The block naming what the check could not see is printed whatever
// the outcome, because an empty list and no list at all mean opposite things.

describe('the report a person reads', () => {
    it('says what it is answering and what it cannot see, whatever it found', async () => {
        for (const folder of ['assert-mod', 'assert-clean-mod', 'assert-unsure-mod']) {
            const text = assertTextReport(await reportFor(folder));
            expect(text, folder).toContain('Does the game load this mod?');
            expect(text, folder).toContain('What this check cannot see at any time');
            expect(text, folder).toContain('What this check could not see here');
            expect(text, folder).toContain('cannot be copied into a build service');
            expect(text, folder).toContain('Mods load in the order of');
        }
    });

    it('names each failure with the file, the line and what the game does', async () => {
        const text = assertTextReport(await reportFor('assert-mod', [1, 11]));
        expect(text).toMatch(/fails\s+mod\.rules:\d+\s+Add/);
        expect(text).toContain('stops loading');
        expect(text).toContain('starts without this mod');
        expect(text).toContain('This mod does not load');
    });

    it('says plainly when nothing was left unjudged, rather than saying nothing', async () => {
        const text = assertTextReport(await reportFor('assert-clean-mod'));
        expect(text).toContain('Nothing. Every action was judged.');
        expect(text).toContain('The game loads this mod.');
        expect(text).toContain('Everything was checked and the game loads what is here.');
    });

    it('never calls a mod loaded while something in it was not judged', async () => {
        const text = assertTextReport(await reportFor('assert-unsure-mod'));
        expect(text).not.toContain('The game loads this mod.');
        expect(text).toContain('could not be judged');
        expect(text).toContain('a target the action says may be missing');
    });

    it('lists the action the mod pulls in from another file under that file name', async () => {
        const text = assertTextReport(await reportFor('assert-mod', [1, 11]));
        expect(text).toMatch(/fails\s+fragment_actions\.rules:\d+\s+Remove/);
    });
});

describe('the report a script reads', () => {
    it('carries the counts, the verdict and everything that was not judged', async () => {
        const report = JSON.parse(assertJsonReport(await reportFor('assert-mod', [1, 11])));
        expect(report.tool.check).toBe('assert-loads');
        expect(report.summary.loadBlocking).toBe(4);
        expect(report.summary.complete).toBe(false);
        expect(report.limits).toEqual(STANDING_LIMITS);
        const mod = report.mods[0];
        expect(mod.verdict).toBe('does-not-load');
        expect(mod.counts.ok + mod.counts.failed + mod.counts.unverifiable).toBe(mod.counts.actions);
        expect(mod.disclosures.length).toBeGreaterThan(0);
        expect(mod.orphanActionFiles).toEqual([{ path: 'orphan_actions.rules', actions: 1 }]);
    });

    it('carries the reason and the effect on every action, so nothing has to be read out of prose', async () => {
        const report = JSON.parse(assertJsonReport(await reportFor('assert-mod', [1, 11])));
        const actions = report.mods[0].manifests.flatMap((manifest: { actions: unknown[] }) => manifest.actions);
        const marks = actions.map((action: { mark: string; reason: string | null; effect: string | null }) => [
            action.mark,
            action.reason ?? action.effect,
        ]);
        expect(marks).toContainEqual(['unverifiable', 'indexed-add-base']);
        expect(marks).toContainEqual(['failed', 'game-stops']);
        expect(marks).toContainEqual(['failed', 'mod-dropped']);
    });

    it('writes the same bytes twice, so a build gate cannot flip on its own', async () => {
        const first = assertJsonReport(await reportFor('assert-mod', [1, 11]));
        const second = assertJsonReport(await reportFor('assert-mod', [1, 11]));
        expect(first).toBe(second);
    });
});
