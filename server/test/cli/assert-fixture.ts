import { join, resolve } from 'path';
import { collectManifestActions } from '../../src/cli/assert/actions';
import { AssertInput, buildAssertReport } from '../../src/cli/assert/assert';
import { DocumentCache } from '../../src/cli/assert/documents';
import { AssertReport } from '../../src/cli/assert/model';
import { walkModFiles } from '../../src/cli/assert/walk';
import type { LintFinding } from '../../src/cli/findings';
import type { GameDataStatus } from '../../src/cli/report/report';

// Building a finished load report without a language server, so the counting, the rendering and the
// exit code can each be tested on their own. The findings a scan would publish are handed in.

/** The fixture mods, and the fake game data their action targets are resolved against. */
export const FIXTURES = join(__dirname, 'fixtures');
export const DATA_DIR = resolve(__dirname, '..', 'fixtures', 'workspace', 'Data');

/** The game data status of a run that found the install. */
export const GAME_DATA: GameDataStatus = {
    available: true,
    dataRoot: DATA_DIR,
    source: 'option',
    skippedRules: [],
};

/**
 * Build the report for one fixture mod, with the findings a scan would have published.
 *
 * @param folder the fixture folder name.
 * @param missingTargets the indexes of the manifest's actions whose target resolves to nothing.
 * @returns the finished report.
 */
export const reportFor = async (folder: string, missingTargets: number[] = []): Promise<AssertReport> => {
    const modDir = join(FIXTURES, folder);
    const cache = new DocumentCache();
    const manifest = await cache.get(join(modDir, 'mod.rules'));
    if (!manifest) throw new Error(`the fixture ${folder} has no mod.rules`);
    const { records } = await collectManifestActions(manifest, modDir, cache);
    const { rulesFiles } = await walkModFiles(modDir);
    const findings: LintFinding[] = missingTargets.map((index) => ({
        file: records[index].file,
        path: 'mod.rules',
        ruleId: 'mod-action',
        named: true,
        severity: 'error',
        message: 'Action target not found',
        startLine: records[index].line,
        startColumn: records[index].column,
        endLine: records[index].line,
        endColumn: records[index].column + 1,
        unnecessary: false,
    }));
    const input: AssertInput = {
        folders: [modDir],
        gameData: GAME_DATA,
        findings,
        checkedFiles: rulesFiles,
        files: rulesFiles.length,
        passes: 1,
        elapsedMs: 1234,
    };
    return buildAssertReport(input);
};
