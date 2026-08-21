import { stat, writeFile } from 'fs/promises';
import { buildAssertReport } from './assert/assert';
import { assertExitCode } from './assert/exit-code';
import { assertJsonReport, assertTextReport } from './assert/render';
import { walkModFiles } from './assert/walk';
import { countBySeverity, filterFindings, LintFinding } from './findings';
import { configuredGamePath, GameDataResolution, resolveGameData } from './game-path';
import { helpText, LintOptions, parseArguments } from './options';
import { githubReport } from './report/github';
import { jsonReport } from './report/json';
import { GameDataStatus, LintReport } from './report/report';
import { sarifReport } from './report/sarif';
import { textReport } from './report/text';
import { atLeastAsSevere, GAME_DATA_RULES } from './rule-ids';
import { defaultServerPath, runScan } from './scan';
import { TOOL_NAME, toolVersion } from './version';

// The command line entry point. It runs as `node out/server/src/cli/lint.mjs`, beside the server
// bundle it drives, and is also published as a release asset. Every exit code below is part of what
// the tool promises, because a build gate reads the code and nothing else.

/** The scan finished and nothing reached the level `--fail-on` names. */
const EXIT_CLEAN = 0;
/** The scan finished and something reached that level. */
const EXIT_FINDINGS = 1;
/** The command line could not be understood. */
const EXIT_USAGE = 2;
/** The game's data was required and could not be used. */
const EXIT_NO_GAME_DATA = 3;
/** The scan could not be run, or did not finish. */
const EXIT_SCAN_FAILED = 4;
/** The report could not be written. */
const EXIT_OUTPUT_FAILED = 5;
// Exit code 6 belongs to the load check alone and is decided in ./assert/exit-code.

/**
 * Read the command line, run the scan, write the report and answer with an exit code.
 *
 * @param argv the arguments after the script name.
 * @returns the exit code the process ends with.
 */
const main = async (argv: readonly string[]): Promise<number> => {
    const parsed = parseArguments(argv);
    if (parsed.kind === 'help') {
        await writeOut(helpText());
        return EXIT_CLEAN;
    }
    if (parsed.kind === 'version') {
        await writeOut(`${TOOL_NAME} ${toolVersion()}\n`);
        return EXIT_CLEAN;
    }
    if (parsed.kind === 'error') {
        writeError(`${parsed.message}\nRun --help to see what this tool accepts.`);
        return EXIT_USAGE;
    }
    const options = parsed.options;

    for (const folder of options.folders) {
        if (!(await isDirectory(folder))) {
            writeError(`There is no folder at "${folder}".`);
            return EXIT_USAGE;
        }
        // The load check answers a question about one mod, so a folder that is not a mod is a
        // mistake worth stopping on rather than a mod with nothing wrong with it.
        if (options.assertLoads && (await walkModFiles(folder)).manifests.length === 0) {
            writeError(
                `There is no mod.rules or mod_*.rules under "${folder}", so there is no mod there to check.`
            );
            return EXIT_USAGE;
        }
    }

    const resolution: GameDataResolution = options.useGame
        ? await resolveGameData(options.gamePath)
        : { kind: 'not-found' };
    const gameData = describeGameData(options, resolution);
    if (!gameData.available && options.requireGame) {
        writeError(
            `${gameData.reason}\n` +
                'Point the run at the install with --game, or accept a much weaker result with --no-require-game.'
        );
        return EXIT_NO_GAME_DATA;
    }
    if (!gameData.available && !options.force && (options.format === 'sarif' || options.format === 'github')) {
        writeError(
            `${gameData.reason}\n` +
                `A ${options.format} report from such a run reads as a finished check, and this one is not. ` +
                'Give the run the game data, or write the report anyway with --force.'
        );
        return EXIT_NO_GAME_DATA;
    }

    const serverPath = options.serverPath ?? defaultServerPath();
    if (!(await isFile(serverPath))) {
        writeError(
            `There is no server bundle at "${serverPath}".\n` +
                'Build it with "node esbuild.mjs", or point the run at one with --server.'
        );
        return EXIT_SCAN_FAILED;
    }

    const outcome = await runScan({ options, gamePath: configuredGamePath(resolution), serverPath });
    if (outcome.kind === 'failed') {
        writeError(`The scan did not finish, because ${outcome.reason}`);
        if (outcome.detail) writeError(outcome.detail);
        return EXIT_SCAN_FAILED;
    }

    if (options.assertLoads) {
        const loadReport = await buildAssertReport({
            folders: options.folders,
            gameData,
            findings: outcome.findings,
            checkedFiles: outcome.checkedFiles,
            files: outcome.files,
            passes: outcome.passes,
            elapsedMs: outcome.elapsedMs,
        });
        const written = await deliver(
            options,
            options.format === 'json' ? assertJsonReport(loadReport) : assertTextReport(loadReport)
        );
        if (written !== undefined) return written;
        if (!options.quiet && (options.outFile || options.format !== 'text')) {
            writeError(loadSummaryLine(loadReport.loadBlocking, loadReport.unverifiable));
        }
        return assertExitCode(loadReport, options.allowUnverifiable);
    }

    const report = assembleReport(options, gameData, outcome.findings, outcome);
    const written = await deliver(options, renderReport(options.format, report));
    if (written !== undefined) return written;
    if (!options.quiet && (options.outFile || options.format !== 'text')) writeError(summaryLine(report));

    return report.failing > 0 ? EXIT_FINDINGS : EXIT_CLEAN;
};

/**
 * Write the finished report where the run asked for it.
 *
 * @param options the run's options.
 * @param text the report to write.
 * @returns undefined once it is written, or the exit code to stop with when it could not be.
 */
const deliver = async (options: LintOptions, text: string): Promise<number | undefined> => {
    if (!options.outFile) {
        await writeOut(text);
        return undefined;
    }
    try {
        await writeFile(options.outFile, text, 'utf8');
    } catch (error) {
        writeError(`The report could not be written to "${options.outFile}": ${(error as Error).message}`);
        return EXIT_OUTPUT_FAILED;
    }
    if (!options.quiet) writeError(`Report written to ${options.outFile}`);
    return undefined;
};

/**
 * The one line worth putting in a build log when the load report went somewhere else.
 *
 * @param loadBlocking how many things stop a mod loading.
 * @param unverifiable how many things could not be judged.
 * @returns the summary line.
 */
const loadSummaryLine = (loadBlocking: number, unverifiable: number): string =>
    `Stopping the mod from loading: ${loadBlocking}. Not judged: ${unverifiable}.`;

/**
 * Turn the game path resolution into the status every report format reads.
 *
 * @param options the run's options, for whether the game was wanted at all.
 * @param resolution what the search for the game's data produced.
 * @returns the status, with a sentence saying why there is none when there is none.
 */
const describeGameData = (options: LintOptions, resolution: GameDataResolution): GameDataStatus => {
    const skippedRules = GAME_DATA_RULES.map((rule) => rule.id);
    if (resolution.kind === 'found') {
        return { available: true, dataRoot: resolution.dataRoot, source: resolution.source, skippedRules: [] };
    }
    if (!options.useGame) {
        return { available: false, reason: 'The run was started with --no-game.', skippedRules };
    }
    if (resolution.kind === 'unusable') {
        return {
            available: false,
            source: resolution.source,
            reason: `The game path "${resolution.given}" cannot be used, because ${resolution.reason}`,
            skippedRules,
        };
    }
    return {
        available: false,
        reason: 'The Cosmoteer install could not be found in any Steam library on this machine.',
        skippedRules,
    };
};

/**
 * Put the run's inputs and its findings together into the one object every format reads.
 *
 * @param options the run's options.
 * @param gameData what the run knows about the game's data.
 * @param scanned every finding the scan produced.
 * @param outcome the scan's own counters.
 * @returns the assembled report.
 */
const assembleReport = (
    options: LintOptions,
    gameData: GameDataStatus,
    scanned: LintFinding[],
    outcome: { files: number; passes: number; elapsedMs: number }
): LintReport => {
    const findings = filterFindings(scanned, {
        minSeverity: options.minSeverity,
        only: options.only,
        exclude: options.exclude,
    });
    const failLevel = options.failOn;
    const failing =
        failLevel === 'none' ? 0 : findings.filter((finding) => atLeastAsSevere(finding.severity, failLevel)).length;
    return {
        folders: options.folders,
        scope: options.scope,
        gameData,
        files: outcome.files,
        passes: outcome.passes,
        elapsedMs: outcome.elapsedMs,
        scanned,
        findings,
        counts: countBySeverity(findings),
        failLevel,
        failing,
        annotationLimit: options.annotationLimit,
    };
};

/**
 * Render the report in the requested format.
 *
 * @param format the format asked for.
 * @param report the assembled report.
 * @returns the text to write.
 */
const renderReport = (format: LintOptions['format'], report: LintReport): string => {
    if (format === 'json') return jsonReport(report);
    if (format === 'sarif') return sarifReport(report);
    if (format === 'github') return githubReport(report);
    return textReport(report);
};

/**
 * The one line worth putting in a build log when the report itself went somewhere else.
 *
 * @param report the assembled report.
 * @returns the summary line.
 */
const summaryLine = (report: LintReport): string =>
    `${report.findings.length} findings in ${report.files} files: ${report.counts.error} error, ` +
    `${report.counts.warning} warning, ${report.counts.info} note, ${report.counts.hint} hint.`;

/**
 * Whether a path is a directory that can be read.
 *
 * @param path the path to probe.
 * @returns true when it exists and is a directory.
 */
const isDirectory = (path: string): Promise<boolean> =>
    stat(path)
        .then((stats) => stats.isDirectory())
        .catch(() => false);

/**
 * Whether a path is a file that can be read.
 *
 * @param path the path to probe.
 * @returns true when it exists and is a file.
 */
const isFile = (path: string): Promise<boolean> =>
    stat(path)
        .then((stats) => stats.isFile())
        .catch(() => false);

/**
 * Write to standard output and wait until it has really gone out, so a report piped into another
 * process is not cut short when the process exits.
 *
 * @param text the text to write.
 * @returns once the write has been flushed.
 */
const writeOut = (text: string): Promise<void> =>
    new Promise((resolveWrite, rejectWrite) => {
        process.stdout.write(text, (error) => (error ? rejectWrite(error) : resolveWrite()));
    });

/**
 * Write a line to the error stream, which is where everything that is not the report goes.
 *
 * @param text the text to write.
 */
const writeError = (text: string): void => {
    process.stderr.write(`${text}\n`);
};

void main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: Error) => {
        writeError(`The run stopped on an unexpected error: ${error.stack ?? error.message}`);
        process.exit(EXIT_SCAN_FAILED);
    }
);
