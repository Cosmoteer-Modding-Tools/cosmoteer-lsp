import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { collectManifestActions } from '../../src/cli/assert/actions';
import { AssertInput, buildAssertReport } from '../../src/cli/assert/assert';
import { DocumentCache } from '../../src/cli/assert/documents';
import { judgeAction } from '../../src/cli/assert/judge';
import { DANGLING_REFERENCE_MESSAGE, ModAssertion, REFERENCE_RULE_ID } from '../../src/cli/assert/model';
import { walkModFiles } from '../../src/cli/assert/walk';
import type { ActionPayload } from '../../src/cli/assert/payload';
import type { LintFinding } from '../../src/cli/findings';
import { DATA_DIR, FIXTURES, GAME_DATA } from './assert-fixture';

// A reference written on a mod action is followed while the game reads the manifest, not while the
// action is applied, so one that points at nothing drops the whole mod before anything runs. The
// load check used to answer "the game loads this mod" for exactly that, because the scan reports it
// as a warning of another rule and the judge kept only the mod action rule's errors.

const FIXTURE_MOD = join(FIXTURES, 'assert-mod');
const REFERENCE_MOD = join(FIXTURES, 'assert-reference-mod');
const NO_PAYLOAD: ActionPayload = { files: [], blockers: [], unchecked: [] };

/**
 * A finding of the value pass on one line of a manifest.
 *
 * @param modDir the mod folder holding the manifest.
 * @param line the one-based line the reference is written on.
 * @returns the finding, at the one-based position the scan would report it at.
 */
const danglingOn = (modDir: string, line: number): LintFinding => {
    const manifest = join(modDir, 'mod.rules');
    const written = readFileSync(manifest, 'utf8').split(/\r?\n/)[line - 1];
    const column = written.indexOf('&') + 1;
    expect(column, `line ${line} of ${manifest}`).toBeGreaterThan(0);
    return {
        file: manifest,
        path: 'mod.rules',
        ruleId: REFERENCE_RULE_ID,
        named: true,
        severity: 'warning',
        message: DANGLING_REFERENCE_MESSAGE,
        startLine: line,
        startColumn: column,
        endLine: line,
        endColumn: written.length + 1,
        unnecessary: false,
    };
};

/**
 * Build the whole load report for one fixture mod, with the findings a scan would have published.
 *
 * @param modDir the mod folder.
 * @param findings the findings to plant.
 * @returns the verdict on the mod.
 */
const reportWith = async (modDir: string, findings: LintFinding[]): Promise<ModAssertion> => {
    const { rulesFiles } = await walkModFiles(modDir);
    const input: AssertInput = {
        folders: [modDir],
        gameData: GAME_DATA,
        findings,
        checkedFiles: rulesFiles,
        files: rulesFiles.length,
        passes: 1,
        elapsedMs: 1,
    };
    return (await buildAssertReport(input)).mods[0];
};

/**
 * One mod's action entries, in the order the game runs them.
 *
 * @param modDir the mod folder.
 * @returns the entries.
 */
const records = async (modDir: string) => {
    const cache = new DocumentCache();
    const manifest = await cache.get(join(modDir, 'mod.rules'));
    return (await collectManifestActions(manifest!, modDir, cache)).records;
};

/** The judge context the tests run in, where every file counts as checked. */
const context = (modDir: string) => ({
    modRoot: modDir,
    dataRoot: DATA_DIR,
    checked: () => true,
    relative: (file: string) => file,
});

describe('a reference on a mod action that points at nothing', () => {
    it('drops the mod rather than letting the action pass', async () => {
        const entries = await records(FIXTURE_MOD);
        const judged = judgeAction(entries[0], [danglingOn(FIXTURE_MOD, 14)], context(FIXTURE_MOD), NO_PAYLOAD);
        expect(judged.verdict.mark).toBe('failed');
        expect(judged.verdict.effect).toBe('mod-dropped');
        expect(judged.verdict.detail).toContain('starts without this mod');
    });

    it('is answered before the flag that says the target may be missing', async () => {
        // The flag is only read once the action is applied, which this failure never reaches, so an
        // action carrying it must not come back as one that could not be judged.
        const entries = await records(FIXTURE_MOD);
        const tolerant = entries.find((entry) => entry.action.flags.IgnoreIfNotExisting === true);
        const judged = judgeAction(tolerant!, [danglingOn(FIXTURE_MOD, 14)], context(FIXTURE_MOD), NO_PAYLOAD);
        expect(judged.verdict.mark).toBe('failed');
        expect(judged.verdict.effect).toBe('mod-dropped');
    });

    it('is counted against the mod when it is written on the action itself', async () => {
        const mod = await reportWith(REFERENCE_MOD, [danglingOn(REFERENCE_MOD, 14)]);
        expect(mod.counts.failed).toBe(1);
        expect(mod.verdict).toBe('does-not-load');
    });

    it('is counted against the mod when it is written as an entry of an Overrides map', async () => {
        // The map is a `Dictionary<string, OTNode>`, so the game reads it entry by entry and
        // follows each value the same way it follows the members of the action itself.
        const mod = await reportWith(REFERENCE_MOD, [danglingOn(REFERENCE_MOD, 21)]);
        expect(mod.counts.failed).toBe(1);
        expect(mod.verdict).toBe('does-not-load');
    });

    it('is left alone when it is written inside the content the action adds', async () => {
        // The game keeps the added group as it stands and only follows what is in it once the
        // patched tree is read, so a reference in there says nothing about whether the mod loads.
        const mod = await reportWith(REFERENCE_MOD, [danglingOn(REFERENCE_MOD, 30)]);
        expect(mod.counts.failed).toBe(0);
        expect(mod.verdict).toBe('loads');
    });

    it('leaves a mod that carries none of them reading exactly as it did', async () => {
        expect((await reportWith(REFERENCE_MOD, [])).verdict).toBe('loads');
        const fixture = await reportWith(FIXTURE_MOD, []);
        expect(fixture.counts.failed).toBe(2);
        expect(fixture.counts.ok).toBeGreaterThan(0);
    });
});
