import { describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { join, resolve } from 'path';

// The exit code is the whole product of the load check, and a green unit test says nothing about
// what a process returns. These tests drive the built command the way a build does and read the
// code it ends with.
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const CLI_BUNDLE = join(REPO_ROOT, 'out', 'server', 'src', 'cli', 'lint.mjs');
const SERVER_BUNDLE = join(REPO_ROOT, 'out', 'server', 'src', 'server.mjs');
const FIXTURES = join(__dirname, 'fixtures');
const GAME_DIR = join(__dirname, '..', 'fixtures', 'workspace', 'Data');

/** How long one run of the check may take before the test gives up on it. */
const RUN_TIMEOUT_MS = 120_000;

interface CliResult {
    code: number;
    stdout: string;
    stderr: string;
}

/**
 * Run the built command line and collect everything it produced.
 *
 * @param args the arguments to pass.
 * @returns the exit code and both output streams.
 */
const runCli = (...args: string[]): CliResult => {
    const result = spawnSync(process.execPath, [CLI_BUNDLE, ...args], {
        encoding: 'utf8',
        timeout: RUN_TIMEOUT_MS,
        cwd: REPO_ROOT,
    });
    return { code: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
};

/**
 * Run the load check over one fixture mod.
 *
 * @param folder the fixture folder name.
 * @param args anything to add to the command line.
 * @returns the exit code and both output streams.
 */
const assertLoads = (folder: string, ...args: string[]): CliResult =>
    runCli(join(FIXTURES, folder), '--assert-loads', '--game', GAME_DIR, '--quiet', '--no-cache', ...args);

describe.skipIf(!existsSync(CLI_BUNDLE) || !existsSync(SERVER_BUNDLE))('the load check on the command line', () => {
    it('passes a mod that loads with nothing left unjudged', () => {
        const result = assertLoads('assert-clean-mod');
        expect(result.code, result.stdout + result.stderr).toBe(0);
        expect(result.stdout).toContain('The game loads this mod.');
        expect(result.stdout).toContain('Nothing. Every action was judged.');
    }, RUN_TIMEOUT_MS);

    it('fails a mod the game would not load, and says which failure does what', () => {
        const result = assertLoads('assert-mod');
        expect(result.code, result.stdout + result.stderr).toBe(1);
        expect(result.stdout).toContain('This mod does not load');
        // The target that resolves to nothing stops the game, the unknown verb only drops the mod.
        expect(result.stdout).toContain('stops loading');
        expect(result.stdout).toContain('The game knows no action called "Frobnicate"');
        // The broken action lives in a file the manifest pulls in, which a walk of the manifest
        // alone would never have read.
        expect(result.stdout).toMatch(/fails\s+fragment_actions\.rules/);
        // The action list nothing includes is reported, and never counted as a failure.
        expect(result.stdout).toContain('orphan_actions.rules');
    }, RUN_TIMEOUT_MS);

    it('answers a check it could not finish with its own code, and lowers it only when asked', () => {
        const unsure = assertLoads('assert-unsure-mod');
        expect(unsure.code, unsure.stdout + unsure.stderr).toBe(6);
        expect(unsure.stdout).not.toContain('The game loads this mod.');

        const accepted = assertLoads('assert-unsure-mod', '--allow-unverifiable');
        expect(accepted.code, accepted.stderr).toBe(0);
    }, RUN_TIMEOUT_MS * 2);

    it('writes a machine-readable answer carrying what it could not see', () => {
        const result = assertLoads('assert-mod', '--format', 'json');
        expect(result.code).toBe(1);
        const report = JSON.parse(result.stdout);
        expect(report.tool.check).toBe('assert-loads');
        expect(report.summary.loadBlocking).toBeGreaterThan(0);
        expect(report.summary.complete).toBe(false);
        expect(report.limits.length).toBeGreaterThan(0);
        expect(report.mods[0].verdict).toBe('does-not-load');
        const counts = report.mods[0].counts;
        expect(counts.ok + counts.failed + counts.unverifiable).toBe(counts.actions);
    }, RUN_TIMEOUT_MS);

    it('refuses to run without the game data instead of reporting that nothing loads', () => {
        const result = runCli(join(FIXTURES, 'assert-mod'), '--assert-loads', '--no-game');
        expect(result.code).toBe(2);
        expect(result.stderr).toContain('needs the game data');
        expect(result.stdout).toBe('');
    });

    it('stops with the game data code when the install cannot be used, and reports nothing', () => {
        const result = runCli(join(FIXTURES, 'assert-mod'), '--assert-loads', '--game', join(FIXTURES, 'no-install'));
        expect(result.code).toBe(3);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain('has to end with Data, Cosmoteer or common');
    });

    it('refuses a folder that is not a mod, and a report format it cannot write', () => {
        const notAMod = runCli(join(FIXTURES, 'lint-mod', 'wired'), '--assert-loads', '--game', GAME_DIR);
        expect(notAMod.code).toBe(2);
        expect(notAMod.stderr).toContain('no mod there to check');

        const sarif = runCli(join(FIXTURES, 'assert-mod'), '--assert-loads', '--game', GAME_DIR, '--format', 'sarif');
        expect(sarif.code).toBe(2);
        expect(sarif.stderr).toContain('writes text or json');
    });

    it('says in its own output that the game data cannot go into a build service', () => {
        const result = assertLoads('assert-clean-mod');
        expect(result.stdout).toContain('cannot be copied into a build service');
    }, RUN_TIMEOUT_MS);
});
