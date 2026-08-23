import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { RULES } from '../../src/cli/rule-ids';

// End-to-end tests for the lint command line, driving the built bundle the way a build does. They
// need both bundles, so build them first with `node esbuild.mjs`.
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const CLI_BUNDLE = join(REPO_ROOT, 'out', 'server', 'src', 'cli', 'lint.mjs');
const SERVER_BUNDLE = join(REPO_ROOT, 'out', 'server', 'src', 'server.mjs');
const MOD_DIR = join(__dirname, 'fixtures', 'lint-mod');
const GAME_DIR = join(__dirname, '..', 'fixtures', 'workspace', 'Data');

/** How long one scan of the fixture mod may take before the test gives up on it. */
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
        // A run started from the repo root would otherwise inherit whatever the test runner's
        // working directory happens to be, which decides what a bare folder argument means.
        cwd: REPO_ROOT,
    });
    return { code: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
};

/**
 * Run the command line asking for the machine-readable report, and read it back.
 *
 * @param args the arguments to pass on top of the format.
 * @returns the exit code and the parsed report.
 */
const runJson = (...args: string[]): { code: number; report: any } => {
    const result = runCli('--format', 'json', '--quiet', ...args);
    expect(result.stdout, result.stderr).not.toBe('');
    return { code: result.code, report: JSON.parse(result.stdout) };
};

describe.skipIf(!existsSync(CLI_BUNDLE) || !existsSync(SERVER_BUNDLE))('the lint command line', () => {
    let scratch: string;

    beforeAll(() => {
        scratch = mkdtempSync(join(tmpdir(), 'cosmoteer-lint-test-'));
    });

    afterAll(() => {
        rmSync(scratch, { recursive: true, force: true });
    });

    it('fails the run on an error and passes it when nothing is set to fail', () => {
        const failing = runCli(MOD_DIR, '--game', GAME_DIR, '--quiet', '--no-cache');
        expect(failing.code, failing.stdout + failing.stderr).toBe(1);
        expect(failing.stdout).toContain('reached the error level');

        const passing = runCli(MOD_DIR, '--game', GAME_DIR, '--quiet', '--no-cache', '--fail-on', 'none');
        expect(passing.code, passing.stdout + passing.stderr).toBe(0);
        expect(passing.stdout).toContain('Nothing was set to fail this run.');
    }, RUN_TIMEOUT_MS);

    it('checks only the files the game loads, and every file when asked to', () => {
        const reachable = runJson(MOD_DIR, '--game', GAME_DIR, '--no-cache', '--fail-on', 'none');
        const paths = reachable.report.findings.map((entry: { path: string }) => entry.path);
        expect(paths).toContain('wired/part.rules');
        expect(paths).not.toContain('_backup/dead.rules');

        const everything = runJson(
            MOD_DIR,
            '--game',
            GAME_DIR,
            '--no-cache',
            '--fail-on',
            'none',
            '--scope',
            'allFiles'
        );
        const allPaths = everything.report.findings.map((entry: { path: string }) => entry.path);
        expect(allPaths).toContain('wired/part.rules');
        expect(allPaths).toContain('_backup/dead.rules');
    }, RUN_TIMEOUT_MS);

    it('reports the run the same way twice, so a build gate cannot flip on its own', () => {
        const first = join(scratch, 'first.json');
        const second = join(scratch, 'second.json');
        for (const out of [first, second]) {
            const result = runCli(
                MOD_DIR,
                '--game',
                GAME_DIR,
                '--format',
                'json',
                '--quiet',
                '--no-cache',
                '--fail-on',
                'none',
                '--out',
                out
            );
            expect(result.code, result.stderr).toBe(0);
        }
        expect(readFileSync(first, 'utf8')).toBe(readFileSync(second, 'utf8'));
    }, RUN_TIMEOUT_MS * 2);

    it('never reports a rule the tool does not describe', () => {
        const { report } = runJson(MOD_DIR, '--game', GAME_DIR, '--no-cache', '--fail-on', 'none');
        const known = new Set(RULES.map((rule) => rule.id));
        for (const entry of report.findings as { ruleId: string }[]) expect(known).toContain(entry.ruleId);
    }, RUN_TIMEOUT_MS);

    it('names the check behind every finding once the server names any of them', () => {
        // The fallback exists for a server build that tags nothing. A build that tags some findings
        // and not others means a validation pass was added without a rule id, which is what this
        // catches.
        const { report } = runJson(MOD_DIR, '--game', GAME_DIR, '--no-cache', '--fail-on', 'none');
        const findings = report.findings as { named: boolean; message: string; ruleId: string }[];
        if (!findings.some((entry) => entry.named)) return;
        expect(findings.filter((entry) => !entry.named).map((entry) => entry.message)).toEqual([]);
    }, RUN_TIMEOUT_MS);

    it('says what a run without the game data could not check, and finds more because of it', () => {
        const withGame = runJson(MOD_DIR, '--game', GAME_DIR, '--no-cache', '--fail-on', 'none');
        const withoutGame = runJson(MOD_DIR, '--no-game', '--no-cache', '--fail-on', 'none');

        expect(withoutGame.report.run.gameData.available).toBe(false);
        expect(withoutGame.report.run.gameData.reason).toContain('--no-game');
        expect(withoutGame.report.run.gameData.skippedRules).toEqual([
            'validateComponentReferences',
            'validateCrossFileReferences',
            'validateUndeclaredDependencies',
            'validateLocalizationKeys',
            'validateRenderLayers',
            'validateUnusedParticleChannels',
            'validateDuplicateIds',
            'validateUnreceivableBuffs',
        ]);

        // The reference into the game's own files resolves with the game data and does not without
        // it, which is why a run in this state cannot be read as a clean result.
        const messages = (withoutGame.report.findings as { message: string }[]).map((entry) => entry.message);
        expect(messages.some((message) => message.includes('Reference name is not known'))).toBe(true);
        expect(withoutGame.report.findings.length).toBeGreaterThan(withGame.report.findings.length);
    }, RUN_TIMEOUT_MS * 2);

    it('puts the banner at the top of the report a person reads', () => {
        const result = runCli(MOD_DIR, '--no-game', '--quiet', '--no-cache', '--fail-on', 'none');
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).toContain('Game data  not used');
        expect(result.stdout).toContain('This run did not read the game data, so it is not a clean bill of health.');
        expect(result.stdout).toContain('component references');
    }, RUN_TIMEOUT_MS);

    it('refuses to write an uploadable report from a run without the game data', () => {
        const refused = runCli(MOD_DIR, '--no-game', '--format', 'sarif', '--quiet');
        expect(refused.code).toBe(3);
        expect(refused.stdout).toBe('');
        expect(refused.stderr).toContain('reads as a finished check');

        const forced = runCli(
            MOD_DIR,
            '--no-game',
            '--format',
            'sarif',
            '--quiet',
            '--no-cache',
            '--force',
            '--fail-on',
            'none'
        );
        expect(forced.code, forced.stderr).toBe(0);
        const log = JSON.parse(forced.stdout);
        expect(log.runs[0].invocations[0].toolExecutionNotifications[0].descriptor.id).toBe('no-game-data');
    }, RUN_TIMEOUT_MS);

    it('stops before spawning anything when the game data is required and unusable', () => {
        const result = runCli(MOD_DIR, '--game', join(scratch, 'not-an-install'));
        expect(result.code).toBe(3);
        expect(result.stderr).toContain('has to end with Data, Cosmoteer or common');
    });

    it('writes annotations a workflow understands', () => {
        const result = runCli(
            MOD_DIR,
            '--game',
            GAME_DIR,
            '--format',
            'github',
            '--quiet',
            '--no-cache',
            '--fail-on',
            'none'
        );
        expect(result.code, result.stderr).toBe(0);
        const lines = result.stdout.trimEnd().split('\n');
        expect(lines.some((line) => /^::error file=wired\/part\.rules,line=\d+,endLine=\d+,col=\d+/.test(line))).toBe(
            true
        );
        expect(lines[lines.length - 1]).toContain('::notice title=Cosmoteer Rules Lint::');
    }, RUN_TIMEOUT_MS);

    it('writes the report to a file when asked, and says where it went', () => {
        const out = join(scratch, 'report.sarif');
        const result = runCli(
            MOD_DIR,
            '--game',
            GAME_DIR,
            '--format',
            'sarif',
            '--out',
            out,
            '--no-cache',
            '--fail-on',
            'none'
        );
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain(out);
        expect(JSON.parse(readFileSync(out, 'utf8')).version).toBe('2.1.0');
    }, RUN_TIMEOUT_MS);

    it('answers the help and the version without running anything', () => {
        const help = runCli('--help');
        expect(help.code).toBe(0);
        expect(help.stdout).toContain('cosmoteer-rules-lint [options] [folder...]');
        expect(help.stdout).toContain('npx cosmoteer-rules-lint');

        const version = runCli('--version');
        expect(version.code).toBe(0);
        expect(version.stdout).toMatch(/^Cosmoteer Rules Lint \S+\n$/);
    });

    it('refuses a command line it cannot follow instead of checking something else', () => {
        expect(runCli('--strict').code).toBe(2);
        expect(runCli(join(scratch, 'nowhere'), '--no-game').code).toBe(2);
    });
});
