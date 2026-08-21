import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver';
import {
    EnvironmentFingerprint,
    MAX_STORED_FINDINGS,
    PostUpdateSnapshot,
    buildSnapshot,
    environmentFingerprint,
    findingKey,
    loadPostUpdateBaseline,
    postUpdateBaselinePath,
    recordScanBaseline,
    savePostUpdateBaseline,
} from '../../../src/features/post-update/post-update-baseline';

// The store writes into the OS application data directory, so the whole file runs against a
// throwaway one, the way the index-cache test does.
const CACHE_HOME = mkdtempSync(join(tmpdir(), 'cosmo-post-update-'));
const previousLocalAppData = process.env.LOCALAPPDATA;

const DATA_ROOT = 'C:/games/Cosmoteer/Data';
const FOLDERS = ['C:/mods/my-mod'];

const ENVIRONMENT: EnvironmentFingerprint = { workshop: 'w1', codeMods: '', gameBinary: 'g1' };

/** One diagnostic in the shape the server publishes. */
const diagnostic = (line: number, code: string | undefined, severity: DiagnosticSeverity, message: string): Diagnostic => ({
    range: { start: { line, character: 0 }, end: { line, character: 4 } },
    severity,
    code,
    message,
});

/** A snapshot over one file's findings, under a given game version. */
const snapshotOf = (
    gameVersion: string,
    entries: readonly (readonly [string, number, number, Diagnostic[]])[],
    maxProblems = 100
): PostUpdateSnapshot =>
    buildSnapshot({
        gameVersion,
        settingsKey: '{"locale":"en"}',
        environment: ENVIRONMENT,
        folderPaths: FOLDERS,
        maxProblems,
        entries,
    });

describe('grouping one scan into a snapshot', () => {
    it('groups findings by file, rule and severity, and keeps every line of each group', () => {
        const snapshot = snapshotOf('0.30.4c', [
            [
                'C:/mods/my-mod/parts/gun.rules',
                10,
                1000,
                [
                    diagnostic(8, 'syntax-and-references', 2, 'second one'),
                    diagnostic(4, 'syntax-and-references', 2, 'first one'),
                    diagnostic(4, 'validateRequiredFields', 1, 'missing field'),
                ],
            ],
        ]);
        expect(snapshot.findingCount).toBe(3);
        expect(snapshot.findings).toHaveLength(2);
        const references = snapshot.findings.find((finding) => finding.ruleId === 'syntax-and-references');
        expect(references).toMatchObject({ path: 'parts/gun.rules', lines: [5, 9], severity: 'warning' });
        expect(snapshot.findings.find((finding) => finding.ruleId === 'validateRequiredFields')).toMatchObject({
            lines: [5],
            severity: 'error',
        });
    });

    it('files a finding whose build named no rule under the shared fallback rule', () => {
        const snapshot = snapshotOf('0.30.4c', [
            ['C:/mods/my-mod/a.rules', 1, 1, [diagnostic(0, undefined, 1, 'from an older build')]],
        ]);
        expect(snapshot.findings[0].ruleId).toBe('unnamed-check');
    });

    it('records which files reached the per-file problem limit', () => {
        const many = Array.from({ length: 3 }, (unused, index) => diagnostic(index, 'schema', 1, 'x'));
        const snapshot = snapshotOf('0.30.4c', [['C:/mods/my-mod/full.rules', 1, 1, many]], 3);
        expect(snapshot.cappedFiles).toEqual(['full.rules']);
        expect(snapshot.maxProblems).toBe(3);
    });

    it('stores paths relative to the workspace folder, so a moved project still compares', () => {
        const snapshot = snapshotOf('0.30.4c', [
            ['C:/mods/my-mod/parts/gun.rules', 7, 42, [diagnostic(0, 'schema', 1, 'x')]],
        ]);
        expect(snapshot.stamps).toEqual([['parts/gun.rules', 7, 42]]);
        expect(snapshot.findings[0].path).toBe('parts/gun.rules');
    });

    it('keys a finding by file, rule and severity, and not by its message', () => {
        expect(findingKey('a.rules', 'schema', 'error')).toBe(findingKey('a.rules', 'schema', 'error'));
        expect(findingKey('a.rules', 'schema', 'error')).not.toBe(findingKey('a.rules', 'schema', 'warning'));
    });

    it('never stores more finding groups than the cap, and says how many it left out', () => {
        const files: (readonly [string, number, number, Diagnostic[]])[] = Array.from(
            { length: MAX_STORED_FINDINGS + 5 },
            (unused, index) => [`C:/mods/my-mod/f${index}.rules`, 1, 1, [diagnostic(0, 'schema', 1, 'x')]]
        );
        const snapshot = snapshotOf('0.30.4c', files);
        expect(snapshot.findings).toHaveLength(MAX_STORED_FINDINGS);
        expect(snapshot.omittedFindings).toBe(5);
    });
});

describe('the two-generation store', () => {
    beforeAll(() => {
        process.env.LOCALAPPDATA = CACHE_HOME;
    });

    afterAll(() => {
        process.env.LOCALAPPDATA = previousLocalAppData;
        rmSync(CACHE_HOME, { recursive: true, force: true });
    });

    it('rolls the standing generation over only when the game version changed', async () => {
        const folders = [`${FOLDERS[0]}-rollover`];
        const save = async (version: string, message: string): Promise<string> =>
            await savePostUpdateBaseline(
                DATA_ROOT,
                folders,
                buildSnapshot({
                    gameVersion: version,
                    settingsKey: 's',
                    environment: ENVIRONMENT,
                    folderPaths: folders,
                    maxProblems: 100,
                    entries: [[`${folders[0]}/a.rules`, 1, 1, [diagnostic(0, 'schema', 1, message)]]],
                })
            );

        expect(await save('0.30.3', 'under A')).toBe('created');
        let stored = await loadPostUpdateBaseline(DATA_ROOT, folders);
        expect(stored?.current?.gameVersion).toBe('0.30.3');
        expect(stored?.previous).toBeUndefined();

        expect(await save('0.30.3', 'under A again')).toBe('updated');
        stored = await loadPostUpdateBaseline(DATA_ROOT, folders);
        expect(stored?.current?.findings[0].message).toBe('under A again');
        expect(stored?.previous).toBeUndefined();

        expect(await save('0.30.4c', 'under B')).toBe('rolledOver');
        stored = await loadPostUpdateBaseline(DATA_ROOT, folders);
        expect(stored?.previous?.gameVersion).toBe('0.30.3');
        expect(stored?.previous?.findings[0].message).toBe('under A again');
        expect(stored?.current?.gameVersion).toBe('0.30.4c');

        // The second scan under B must not push B into previous: the record of what the project
        // looked like before the update is the whole point of the store.
        expect(await save('0.30.4c', 'under B again')).toBe('updated');
        stored = await loadPostUpdateBaseline(DATA_ROOT, folders);
        expect(stored?.previous?.gameVersion).toBe('0.30.3');
        expect(stored?.current?.findings[0].message).toBe('under B again');
    });

    it('writes one file per project under the application data directory', async () => {
        const folders = [`${FOLDERS[0]}-file`];
        await savePostUpdateBaseline(DATA_ROOT, folders, snapshotOf('0.30.4c', []));
        const file = postUpdateBaselinePath(DATA_ROOT, folders);
        expect(file.startsWith(CACHE_HOME)).toBe(true);
        expect(existsSync(file)).toBe(true);
        expect(readdirSync(join(CACHE_HOME, 'cosmoteer-lsp')).some((name) => name.endsWith('.tmp'))).toBe(false);
    });

    it('keys the store by the folder set, so two projects never share one baseline', async () => {
        expect(postUpdateBaselinePath(DATA_ROOT, ['C:/mods/one'])).not.toBe(
            postUpdateBaselinePath(DATA_ROOT, ['C:/mods/two'])
        );
        expect(postUpdateBaselinePath(DATA_ROOT, ['C:/mods/one', 'C:/mods/two'])).toBe(
            postUpdateBaselinePath(DATA_ROOT, ['C:/mods/two', 'C:/mods/one'])
        );
    });

    it('round-trips everything a later comparison needs to judge the recording', async () => {
        const folders = [`${FOLDERS[0]}-roundtrip`];
        const snapshot = buildSnapshot({
            gameVersion: '0.30.4c',
            settingsKey: '{"a":1}',
            environment: { workshop: 'w9', codeMods: 'c9', gameBinary: 'g9' },
            folderPaths: folders,
            maxProblems: 2,
            entries: [
                [
                    `${folders[0]}/a.rules`,
                    12,
                    345,
                    [diagnostic(3, 'validatePaths', 2, 'a path'), diagnostic(4, 'validatePaths', 2, 'another path')],
                ],
            ],
        });
        await savePostUpdateBaseline(DATA_ROOT, folders, snapshot);
        const stored = await loadPostUpdateBaseline(DATA_ROOT, folders);
        expect(stored?.current).toEqual(snapshot);
        expect(stored?.current?.environment).toEqual({ workshop: 'w9', codeMods: 'c9', gameBinary: 'g9' });
        expect(stored?.current?.cappedFiles).toEqual(['a.rules']);
        expect(stored?.current?.settingsHash).toBe(snapshot.settingsHash);
    });

    it('answers with nothing at all when no baseline was ever written', async () => {
        expect(await loadPostUpdateBaseline(DATA_ROOT, ['C:/mods/never-scanned'])).toBeUndefined();
    });

    it('records a finished scan in one call, and records nothing for a scan with no results', async () => {
        const folders = [`${FOLDERS[0]}-recording`];
        const recording = {
            dataRoot: DATA_ROOT,
            folderPaths: folders,
            settingsKey: 's',
            maxProblems: 100,
            entries: [[`${folders[0]}/a.rules`, 3, 4, [diagnostic(0, 'schema', 1, 'x')]]] as (readonly [
                string,
                number,
                number,
                Diagnostic[],
            ])[],
        };
        expect(await recordScanBaseline({ ...recording, entries: [] })).toBe('skipped');
        expect(await recordScanBaseline(recording)).toBe('created');
        const stored = await loadPostUpdateBaseline(DATA_ROOT, folders);
        expect(stored?.current?.findings).toHaveLength(1);
        expect(stored?.current?.fileCount).toBe(1);
    });

    it('fingerprints the surroundings without failing on a folder that holds none of them', async () => {
        const fingerprint = await environmentFingerprint(DATA_ROOT, [CACHE_HOME]);
        expect(typeof fingerprint.workshop).toBe('string');
        expect(typeof fingerprint.codeMods).toBe('string');
        expect(typeof fingerprint.gameBinary).toBe('string');
    });
});
