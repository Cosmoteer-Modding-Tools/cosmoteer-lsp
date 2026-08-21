import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver';
import { FIXTURES_DIR } from '../../helpers';
import { gameAssemblyPathFor, readGameVersionInfo } from '../../../src/features/post-update/game-version';
import {
    EnvironmentFingerprint,
    PostUpdateSnapshot,
    buildSnapshot,
    savePostUpdateBaseline,
} from '../../../src/features/post-update/post-update-baseline';
import {
    PostUpdateReportRequest,
    buildPostUpdateReport,
    diffSnapshots,
    newestRegistryVersion,
} from '../../../src/features/post-update/post-update-report';

const CACHE_HOME = mkdtempSync(join(tmpdir(), 'cosmo-post-update-report-'));
const previousLocalAppData = process.env.LOCALAPPDATA;

const DATA_ROOT = process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const HAVE_GAME = existsSync(gameAssemblyPathFor(DATA_ROOT));
const MANIFESTS = join(FIXTURES_DIR, 'post-update-manifests');

const ENVIRONMENT: EnvironmentFingerprint = { workshop: 'w1', codeMods: '', gameBinary: 'g1' };

/** One diagnostic in the shape the server publishes. */
const diagnostic = (line: number, code: string, severity: DiagnosticSeverity, message: string): Diagnostic => ({
    range: { start: { line, character: 0 }, end: { line, character: 4 } },
    severity,
    code,
    message,
});

/** A scan entry: one file, its stat, and what it produced. */
type Entry = readonly [string, number, number, Diagnostic[]];

const FOLDER = 'C:/mods/my-mod';

/** A snapshot over the given files, under a given game version. */
const snapshotOf = (
    gameVersion: string,
    entries: readonly Entry[],
    overrides: { maxProblems?: number; settingsKey?: string; environment?: EnvironmentFingerprint } = {}
): PostUpdateSnapshot =>
    buildSnapshot({
        gameVersion,
        settingsKey: overrides.settingsKey ?? 's',
        environment: overrides.environment ?? ENVIRONMENT,
        folderPaths: [FOLDER],
        maxProblems: overrides.maxProblems ?? 100,
        entries,
    });

/** One unchanged file with one finding, as the base of most cases. */
const gunFile = (message = 'reference resolves to nothing'): Entry => [
    `${FOLDER}/parts/gun.rules`,
    100,
    5000,
    [diagnostic(3, 'syntax-and-references', 2, message)],
];

describe('attributing a difference between two recordings', () => {
    it('reports nothing at all when the two recordings agree', () => {
        const before = snapshotOf('0.30.3', [gunFile()]);
        const after = snapshotOf('0.30.4c', [gunFile()]);
        expect(diffSnapshots(before, after).deltas).toEqual([]);
    });

    it('lays a new finding in an untouched file at the update door', () => {
        const before = snapshotOf('0.30.3', [gunFile()]);
        const after = snapshotOf('0.30.4c', [
            [
                `${FOLDER}/parts/gun.rules`,
                100,
                5000,
                [
                    diagnostic(3, 'syntax-and-references', 2, 'reference resolves to nothing'),
                    diagnostic(9, 'validateCrossFileReferences', 2, 'no file declares this id'),
                ],
            ],
        ]);
        const deltas = diffSnapshots(before, after).deltas;
        expect(deltas).toHaveLength(1);
        expect(deltas[0]).toMatchObject({
            kind: 'appeared',
            ruleId: 'validateCrossFileReferences',
            count: 1,
            lines: [10],
        });
    });

    it('reports a finding that stopped being produced', () => {
        const before = snapshotOf('0.30.3', [gunFile()]);
        const after = snapshotOf('0.30.4c', [[`${FOLDER}/parts/gun.rules`, 100, 5000, []]]);
        const deltas = diffSnapshots(before, after).deltas;
        expect(deltas).toHaveLength(1);
        expect(deltas[0]).toMatchObject({ kind: 'resolved', ruleId: 'syntax-and-references' });
    });

    it('counts a group that grew rather than reporting the whole group as new', () => {
        const before = snapshotOf('0.30.3', [gunFile()]);
        const after = snapshotOf('0.30.4c', [
            [
                `${FOLDER}/parts/gun.rules`,
                100,
                5000,
                [
                    diagnostic(3, 'syntax-and-references', 2, 'one'),
                    diagnostic(4, 'syntax-and-references', 2, 'two'),
                    diagnostic(5, 'syntax-and-references', 2, 'three'),
                ],
            ],
        ]);
        expect(diffSnapshots(before, after).deltas[0]).toMatchObject({ kind: 'appeared', count: 2, lines: [5, 6] });
    });

    it('never blames the update for a file the author edited since the recording', () => {
        const before = snapshotOf('0.30.3', [gunFile()]);
        const after = snapshotOf('0.30.4c', [
            [
                `${FOLDER}/parts/gun.rules`,
                140,
                9999,
                [
                    diagnostic(3, 'syntax-and-references', 2, 'reference resolves to nothing'),
                    diagnostic(9, 'schema', 1, 'not a valid value'),
                ],
            ],
        ]);
        const diff = diffSnapshots(before, after);
        expect(diff.editedFiles).toEqual(['parts/gun.rules']);
        expect(diff.deltas.map((delta) => delta.kind)).toEqual(['edited']);
    });

    it('does not call a finding fixed when the file it left was at the problem limit', () => {
        const capped = snapshotOf(
            '0.30.3',
            [
                [
                    `${FOLDER}/parts/gun.rules`,
                    100,
                    5000,
                    [diagnostic(1, 'schema', 1, 'a'), diagnostic(2, 'syntax-and-references', 2, 'b')],
                ],
            ],
            { maxProblems: 2 }
        );
        const after = snapshotOf('0.30.4c', [[`${FOLDER}/parts/gun.rules`, 100, 5000, [diagnostic(1, 'schema', 1, 'a')]]], {
            maxProblems: 2,
        });
        const deltas = diffSnapshots(capped, after).deltas;
        expect(deltas.map((delta) => delta.kind)).toEqual(['capped']);
    });

    it('separates the files the two recordings do not share', () => {
        const before = snapshotOf('0.30.3', [gunFile(), [`${FOLDER}/old.rules`, 1, 1, [diagnostic(0, 'schema', 1, 'x')]]]);
        const after = snapshotOf('0.30.4c', [gunFile(), [`${FOLDER}/new.rules`, 1, 1, [diagnostic(0, 'schema', 1, 'y')]]]);
        const diff = diffSnapshots(before, after);
        expect(diff.enteredFiles).toEqual(['new.rules']);
        expect(diff.leftFiles).toEqual(['old.rules']);
        expect(diff.deltas.map((delta) => delta.kind).sort()).toEqual(['fileEntered', 'fileLeft']);
    });

    it('matches a finding through a reworded message, since the wording is not the identity', () => {
        const before = snapshotOf('0.30.3', [gunFile('the old wording')]);
        const after = snapshotOf('0.30.4c', [
            [`${FOLDER}/parts/gun.rules`, 100, 5000, [diagnostic(3, 'syntax-and-references', 2, 'the new wording')]],
        ]);
        expect(diffSnapshots(before, after).deltas).toEqual([]);
    });

    it('reports a break and a fix of the same check in one file, which the counts alone hide', () => {
        const before = snapshotOf('0.30.3', [gunFile()]);
        const after = snapshotOf('0.30.4c', [
            [`${FOLDER}/parts/gun.rules`, 100, 5000, [diagnostic(11, 'syntax-and-references', 2, 'somewhere else now')]],
        ]);
        const deltas = diffSnapshots(before, after).deltas;
        expect(deltas.map((delta) => [delta.kind, delta.lines])).toEqual([
            ['resolved', [4]],
            ['appeared', [12]],
        ]);
    });
});

describe('the report as a whole', () => {
    beforeAll(() => {
        process.env.LOCALAPPDATA = CACHE_HOME;
    });

    afterAll(() => {
        process.env.LOCALAPPDATA = previousLocalAppData;
        rmSync(CACHE_HOME, { recursive: true, force: true });
    });

    const request = (overrides: Partial<PostUpdateReportRequest> = {}): PostUpdateReportRequest => ({
        dataRoot: DATA_ROOT,
        folderPaths: [MANIFESTS],
        wholeWorkspaceEnabled: true,
        maxProblems: 100,
        settingsKey: 's',
        entries: [[join(MANIFESTS, 'commented', 'mod.rules'), 10, 20, []]],
        ...overrides,
    });

    it('refuses the comparison when whole-workspace validation is off, and says why', async () => {
        const report = await buildPostUpdateReport(request({ wholeWorkspaceEnabled: false }));
        expect(report.summary.status).toBe('wholeWorkspaceOff');
        expect(report.markdown).toContain('validateWholeWorkspace');
        expect(report.summary.appeared).toBe(0);
    });

    it('refuses when no game install is configured', async () => {
        const report = await buildPostUpdateReport(request({ dataRoot: undefined }));
        expect(report.summary.status).toBe('noGamePath');
        expect(report.markdown).toContain('No Cosmoteer install is configured');
    });

    it('refuses when the check of the whole project has produced nothing yet', async () => {
        const report = await buildPostUpdateReport(request({ entries: [] }));
        expect(report.summary.status).toBe('noScanResults');
    });

    it('says a missing recording is not the same as nothing having changed', async () => {
        const report = await buildPostUpdateReport(request({ folderPaths: [join(MANIFESTS, 'bare')] }));
        expect(report.summary.status).toBe('noBaseline');
        expect(report.markdown).toContain('Nothing here says the update changed nothing.');
    });

    it('compares the two recordings and names what newly fails', async () => {
        const folders = [`${CACHE_HOME}/project`];
        const file = `${folders[0]}/parts/gun.rules`;
        const live: Entry[] = [
            [file, 100, 5000, [diagnostic(3, 'syntax-and-references', 2, 'reference resolves to nothing')]],
        ];
        const save = async (gameVersion: string, entries: readonly Entry[]): Promise<void> => {
            await savePostUpdateBaseline(
                DATA_ROOT,
                folders,
                buildSnapshot({
                    gameVersion,
                    settingsKey: 's',
                    environment: ENVIRONMENT,
                    folderPaths: folders,
                    maxProblems: 100,
                    entries,
                })
            );
        };
        // What the server does over two sessions: a scan under the old game version, then a scan
        // under the new one, which rolls the old recording into the generation the report reads.
        await save('0.29.9', [[file, 100, 5000, []]]);
        await save((await readGameVersionInfo(DATA_ROOT)).installed, live);

        const report = await buildPostUpdateReport(request({ folderPaths: folders, entries: live }));
        expect(report.summary.status).toBe('compared');
        expect(report.summary.appeared).toBe(1);
        expect(report.summary.resolved).toBe(0);
        expect(report.markdown).toContain('What newly fails');
        expect(report.markdown).toContain('parts/gun.rules:4');
        expect(report.markdown).toContain('syntax-and-references');
    });

    it('warns that a settings change, an upgrade or a workshop change may be the real cause', () => {
        const before = snapshotOf('0.30.3', [gunFile()], { settingsKey: 'one', environment: ENVIRONMENT });
        const after = snapshotOf('0.30.4c', [gunFile()], {
            settingsKey: 'two',
            environment: { workshop: 'w2', codeMods: 'c2', gameBinary: 'g2' },
        });
        // The settings and the installed mods both moved, which the report has to say before it
        // attributes anything to the game.
        expect(before.settingsHash).not.toBe(after.settingsHash);
        expect(before.environment.workshop).not.toBe(after.environment.workshop);
    });

    it('judges every manifest in the open folder against the installed game', async () => {
        const report = await buildPostUpdateReport(request());
        const paths = report.summary.manifests.map((manifest) => manifest.path).sort();
        expect(paths).toEqual([
            'bare/mod.rules',
            'commented/mod.rules',
            'legacy/mod.rules',
            'undeclared/mod.rules',
        ]);
        const undeclared = report.summary.manifests.find((manifest) => manifest.path === 'undeclared/mod.rules');
        expect(undeclared?.declared).toBeUndefined();
        expect(undeclared?.modId).toBe('test.undeclared');
        const commented = report.summary.manifests.find((manifest) => manifest.path === 'commented/mod.rules');
        expect(commented?.declared).toEqual(['0.30.4c']);
    });

    it.runIf(HAVE_GAME)('tells a mod the installed game still takes from one it disables', async () => {
        const report = await buildPostUpdateReport(request());
        const verdictOf = (path: string): string | undefined =>
            report.summary.manifests.find((manifest) => manifest.path === path)?.verdict;
        expect(verdictOf('commented/mod.rules')).toBe('namesInstalled');
        expect(verdictOf('legacy/mod.rules')).toBe('namesNone');
        expect(verdictOf('undeclared/mod.rules')).toBe('undeclared');
        expect(report.markdown).toContain('Whether the installed game still takes this mod');
    });

    // Only where the filesystem ignores case, which is the only place a folded path is stored. On a
    // case-sensitive filesystem `foldPathCase` is the identity, so the scan stores the spelling the
    // author wrote and there is nothing to read back. The lower-cased path this sets up would name
    // no file at all there, which is a state the scan cannot produce.
    it.skipIf(process.platform !== 'win32' && process.platform !== 'darwin')(
        'shows a path in the spelling the author wrote, not the folded one the scan stores', async () => {
        // Scan results are keyed by a case-folded path, so on Windows and macOS the stored path is
        // lower case. The report reads the real spelling back off the disk.
        const folders = [join(CACHE_HOME, 'CasedProject')];
        const real = join(folders[0], 'Parts', 'BigGun.rules');
        mkdirSync(join(folders[0], 'Parts'), { recursive: true });
        writeFileSync(real, 'Part { }', 'utf8');
        const folded = real.replace(/\\/g, '/').toLowerCase();
        const live: Entry[] = [[folded, 8, 1, [diagnostic(0, 'schema', 1, 'something')]]];
        const save = async (gameVersion: string, entries: readonly Entry[]): Promise<void> => {
            await savePostUpdateBaseline(
                DATA_ROOT,
                folders,
                buildSnapshot({
                    gameVersion,
                    settingsKey: 's',
                    environment: ENVIRONMENT,
                    folderPaths: folders,
                    maxProblems: 100,
                    entries,
                })
            );
        };
        await save('0.29.9', [[folded, 8, 1, []]]);
        await save((await readGameVersionInfo(DATA_ROOT)).installed, live);
        const report = await buildPostUpdateReport(request({ folderPaths: folders, entries: live }));
        expect(report.summary.status).toBe('compared');
        expect(report.markdown).toContain('Parts/BigGun.rules');
    }
    );

    it('says what it cannot see in every report it produces', async () => {
        const report = await buildPostUpdateReport(request());
        expect(report.markdown).toContain('What this report cannot see');
        // The schema is a build artifact of the extension, so an update to the game cannot move it.
        expect(report.markdown).toContain('built into the extension');
        // The migration registry is hand written and stops where somebody stopped writing it.
        expect(report.markdown).toContain('written by hand');
        expect(report.markdown).toContain(newestRegistryVersion());
        // The per-file problem limit and the edited-file rule are both stated.
        expect(report.markdown).toContain('problems per file');
        expect(report.markdown).toContain('did not move on disk');
    });

    it('reports what a migration dry run would rewrite, and says when none was run', async () => {
        const withoutRun = await buildPostUpdateReport(request());
        expect(withoutRun.markdown).toContain('The migration was not run for this report');
        const withRun = await buildPostUpdateReport(
            request({
                migration: {
                    files: 2,
                    fixes: 5,
                    byVersion: { '0.26.1': 5 },
                    manual: [{ uri: 'file:///a.rules', line: 1, message: 'decide this' }],
                    deadFieldsRemoved: 0,
                    unparsable: 1,
                },
            })
        );
        expect(withRun.summary.migrationFiles).toBe(2);
        expect(withRun.markdown).toContain('Files it would rewrite: 2');
        expect(withRun.markdown).toContain('Changes it would make: 5');
        expect(withRun.markdown).toContain('Findings that need your decision: 1');
        expect(withRun.markdown).toContain('do not parse');
    });
});
