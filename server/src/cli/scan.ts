import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { LintFinding, sortFindings, toFinding, WireDiagnostic } from './findings';
import { LanguageServerSession } from './lsp-client';
import { LintOptions } from './options';
import { fsPathToUri, uriToFsPath } from './uri';

/**
 * How long the run waits after a pass ends before it accepts the result. A cold start converges
 * its shared indexes while the first pass is already running, and the server answers that by
 * running a second pass over the files the new state changed. Taking the first pass as the answer
 * would make a cold run and a warm run disagree by a handful of findings, which is exactly the
 * drift a lint gate must not have.
 */
const SETTLE_MS = 2000;

/** How often the run checks whether the scan has settled. */
const POLL_MS = 50;

/** What a finished scan produced, or why it did not finish. */
export type ScanOutcome =
    | {
          kind: 'complete';
          findings: LintFinding[];
          files: number;
          passes: number;
          elapsedMs: number;
          /** Every file the server published a result for, clean ones included, as on-disk paths.
           *  A check that has to tell a clean file from an unchecked one reads this. */
          checkedFiles: string[];
      }
    | { kind: 'failed'; reason: string; detail: string };

/** What the scan needs beyond the command line: where the game is, and where the server bundle is. */
export interface ScanRequest {
    options: LintOptions;
    /** The game `Data` root to configure, empty when the run has none. */
    gamePath: string;
    /** The server bundle to run. */
    serverPath: string;
}

/**
 * The server bundle that sits beside this one. The CLI and the server are built into the same
 * output tree, so the sibling is the build that belongs to this CLI.
 *
 * @returns the default server bundle path.
 */
export const defaultServerPath = (): string => join(__dirname, '..', 'server.mjs');

/**
 * The configuration the run answers `workspace/configuration` with.
 *
 * Only the keys that matter are sent. The server fills the rest in from its own defaults, so a
 * setting added to the editor after this build still arrives at its default rather than reading as
 * off, and the run keeps checking whatever the editor checks.
 *
 * Every pass stays on even when the run reports only some of them, so that two runs with different
 * rule filters remain comparable and share one cache.
 *
 * @param request what the run was asked to do.
 * @returns the settings object to send.
 */
export const scanSettings = (request: ScanRequest): unknown => ({
    maxNumberOfProblems: request.options.maxProblems,
    cosmoteerPath: request.gamePath,
    diagnostics: {
        validateWholeWorkspace: true,
        workspaceValidationScope: request.options.scope,
    },
    codeMods: {
        enabled: true,
        // A one-shot run has nothing to refresh into, and arming the watch would keep handles open
        // on every mod folder for the length of the run.
        autoRefresh: false,
    },
    formatting: { enabled: false, formatOnSave: false },
});

/**
 * Build the environment the server runs in.
 *
 * A run asked for a fresh cache gets every cache-location variable pointed at a directory of its
 * own, which is how the on-disk index, mention and scan caches are isolated without the server
 * knowing anything about it. The localization bundle is always cleared, so a report never depends
 * on which editor happened to set it and two machines produce the same text.
 *
 * @param scratchDirectory the private directory, when the run asked for one.
 * @returns the environment to spawn with.
 */
export const scanEnvironment = (scratchDirectory: string | undefined): NodeJS.ProcessEnv => {
    const environment: NodeJS.ProcessEnv = { ...process.env };
    delete environment.EXTENSION_BUNDLE_PATH;
    if (!scratchDirectory) return environment;
    environment.LOCALAPPDATA = scratchDirectory;
    environment.TMPDIR = scratchDirectory;
    environment.TMP = scratchDirectory;
    environment.TEMP = scratchDirectory;
    return environment;
};

/**
 * Run one scan: stand a server up, let it validate the folders, and collect what it publishes.
 *
 * @param request what the run was asked to do.
 * @returns the findings in report order, or why the scan did not finish.
 */
export const runScan = async (request: ScanRequest): Promise<ScanOutcome> => {
    const { options } = request;
    const scratchDirectory = options.freshCache ? await mkdtemp(join(tmpdir(), 'cosmoteer-lint-')) : undefined;
    const published = new Map<string, WireDiagnostic[]>();
    let activePasses = 0;
    let finishedPasses = 0;
    let lastActivity = Date.now();

    const session = new LanguageServerSession({
        serverPath: request.serverPath,
        folders: options.folders.map((folder) => ({ uri: fsPathToUri(folder), name: folderName(folder) })),
        settings: scanSettings(request),
        env: scanEnvironment(scratchDirectory),
        onDiagnostics: (uri, diagnostics) => {
            published.set(uri, diagnostics);
            lastActivity = Date.now();
        },
        onScanBoundary: (kind) => {
            if (kind === 'begin') activePasses++;
            else {
                activePasses--;
                finishedPasses++;
            }
            lastActivity = Date.now();
        },
    });

    const started = Date.now();
    try {
        await session.start();
        if (session.gone) return failure('the server stopped during startup', session);
        session.announceInitialized();

        const deadline = started + options.timeoutMs;
        const progress = options.quiet ? undefined : startProgress(() => published.size);
        try {
            while (finishedPasses === 0) {
                if (session.gone) return failure('the server stopped before the scan finished', session);
                if (Date.now() > deadline) return timedOut(options.timeoutMs, session);
                await delay(POLL_MS);
            }
            while (activePasses > 0 || Date.now() - lastActivity < SETTLE_MS) {
                if (session.gone) return failure('the server stopped before the scan settled', session);
                if (Date.now() > deadline) return timedOut(options.timeoutMs, session);
                await delay(POLL_MS);
            }
        } finally {
            progress?.();
        }

        const findings: LintFinding[] = [];
        for (const [uri, diagnostics] of published) {
            for (const diagnostic of diagnostics) findings.push(toFinding(uri, options.folders, diagnostic));
        }
        return {
            kind: 'complete',
            findings: sortFindings(findings),
            files: published.size,
            passes: finishedPasses,
            elapsedMs: Date.now() - started,
            checkedFiles: [...published.keys()].map(uriToFsPath).sort(),
        };
    } finally {
        await session.stop();
        if (scratchDirectory) await rm(scratchDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
};

/**
 * The name a workspace folder is announced under, which is what the folder is called on disk.
 *
 * @param folder the folder path.
 * @returns the folder's own name, falling back to the whole path for a drive root.
 */
const folderName = (folder: string): string => folder.split(/[\\/]/).filter(Boolean).pop() ?? folder;

/**
 * Wait a while.
 *
 * @param ms how long to wait.
 * @returns once the time has passed.
 */
const delay = (ms: number): Promise<void> => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

/**
 * Write a running file count to the error stream, so a long scan does not look like a hang.
 *
 * Only on a terminal. A workflow log is a file, and rewriting a line into a file just fills it with
 * thousands of copies of the same sentence.
 *
 * @param count reads the number of files published so far.
 * @returns a function that stops the updates and clears the line.
 */
const startProgress = (count: () => number): (() => void) => {
    if (!process.stderr.isTTY) return () => undefined;
    const timer = setInterval(() => process.stderr.write(`\rChecked ${count()} files`), 500);
    return () => {
        clearInterval(timer);
        process.stderr.write('\r'.padEnd(40, ' ') + '\r');
    };
};

/**
 * The outcome for a scan whose server went away.
 *
 * @param reason what happened, in one sentence.
 * @param session the session, for whatever the server managed to write before it went.
 * @returns the failed outcome.
 */
const failure = (reason: string, session: LanguageServerSession): ScanOutcome => ({
    kind: 'failed',
    reason: `${reason}: ${session.gone ?? 'no reason given'}`,
    detail: session.errorOutput.trim(),
});

/**
 * The outcome for a scan that ran past its deadline.
 *
 * @param timeoutMs the deadline that was passed.
 * @param session the session, for whatever the server wrote.
 * @returns the failed outcome.
 */
const timedOut = (timeoutMs: number, session: LanguageServerSession): ScanOutcome => ({
    kind: 'failed',
    reason: `the scan did not finish within ${Math.round(timeoutMs / 1000)} seconds. Raise the limit with --timeout, or narrow the run with --scope modRulesReachable.`,
    detail: session.errorOutput.trim(),
});
