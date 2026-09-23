import { readFile, readdir, stat } from 'fs/promises';
import { homedir } from 'os';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { CancellationToken, Diagnostic, DiagnosticSeverity, Range } from 'vscode-languageserver';
import { AbstractNode } from '../../core/ast/ast';
import { findModRoot } from '../../mod/mod-root';
import { stepIntoNode } from '../../document/reference-resolver';
import { identityOfMod } from '../mod-report/mod-dependencies';
import { CosmoteerWorkspaceService } from '../../workspace/cosmoteer-workspace.service';
import { cachedParseFilePath } from '../../workspace/fs-cache';
import { foldPathCase } from '../../workspace/fs-cache';
import { localModDirs } from '../../workspace/workshop-dir';
import { filePathToUri } from '../../document/reference-path';
import { extractSubstrings } from '../../document/reference-path';
import { GameLogFinding, GameLogReport, HOME_FOLDER_TOKEN, parseGameLog } from './game-log';
import * as l10n from '@vscode/l10n';

/**
 * Importing what the game itself said the last time it loaded the mod.
 *
 * The editor checks the files as it reads them; the game reports what it actually refused, after
 * every mod's actions have been applied, and it reports it only into a log file nobody reads. A mod
 * can therefore be shipped broken while the editor shows nothing at all.
 *
 * These findings are a recording of a past run, not a live check, so every one of them says which
 * run it came from, and nothing is published that cannot still be placed in the file as it is now.
 * Anchoring on a guess would put a red mark on a line the author already fixed.
 */

/** The command the clients invoke. Distinct from their own palette entry, which forwards to it. */
export const IMPORT_GAME_LOG_COMMAND = 'cosmoteer.readGameLog';

/** One imported finding, ready for the client to publish in its own collection. */
interface GameLogDiagnostic {
    readonly uri: string;
    readonly diagnostic: Diagnostic;
}

/** One failure of a run that no file of this mod could be given, in the words the log wrote. */
export interface UnplacedReport {
    /** The line to say, which is the log's own text. */
    readonly text: string;
    /** The line of the log file it stands on, 1-based, so the reader can be taken to it. */
    readonly logLine: number;
}

/** What the import found, and which run it read. */
export interface ImportGameLogResult {
    /**
     * `loaded-clean` is a run that lists the mod among the ones it loaded, names none of its files
     * and reported no failure at all while it loaded, which is the answer a modder is after: the
     * game took the mod and had nothing to say.
     *
     * `run-failed` is the same run with something the editor could not place: a failure line no
     * shape here recognizes, or a mod the run died on while its actions were applied. The run is
     * not clean, and saying which file it was about would be a guess, so it is named as it stands.
     */
    readonly kind: 'imported' | 'loaded-clean' | 'run-failed' | 'no-mod' | 'no-logs' | 'nothing-for-this-mod';
    /** The log that was read, when one was. */
    readonly log?: { readonly path: string; readonly time: string; readonly gameVersion?: string };
    readonly diagnostics: readonly GameLogDiagnostic[];
    /** Findings the log carried for this mod that could no longer be placed in the file. */
    readonly stale: number;
    /** What the run reported while it loaded that could not be placed in a file, for `run-failed`. */
    readonly unplaced?: readonly UnplacedReport[];
}

/** What the command needs from the server: the text of a file that is open and possibly unsaved. */
export interface GameLogHost {
    openText(uri: string): string | undefined;
}

/** The game logs and its mods folder are siblings, both under the user's own save folder. */
export const logFolders = (): string[] => localModDirs().map((mods) => join(dirname(mods), 'Logs'));

/** Every game log, newest first. The file name carries a date but is written in the user's locale. */
const logsNewestFirst = async (): Promise<{ path: string; mtimeMs: number }[]> => {
    const logs: { path: string; mtimeMs: number }[] = [];
    for (const folder of logFolders()) {
        for (const name of await readdir(folder).catch(() => [])) {
            // The same folder holds multiplayer recordings, which are tens of megabytes each.
            if (!name.startsWith('log ') || !name.toLowerCase().endsWith('.txt')) continue;
            const path = join(folder, name);
            const stats = await stat(path).catch(() => null);
            if (stats) logs.push({ path, mtimeMs: stats.mtimeMs });
        }
    }
    return logs.sort((a, b) => b.mtimeMs - a.mtimeMs);
};

/**
 * The absolute path a logged file name means. The logger censors the running user's home folder in
 * every line it writes, so the token is expanded back, against the same home folders the mod
 * discovery already probes (a Proton install runs with the prefix's home, not the real one).
 *
 * @param written the file as the log wrote it.
 * @returns the candidate absolute paths, in probe order.
 */
const expandLoggedPath = (written: string): string[] => {
    const path = written.replace(/\\/g, '/');
    if (!path.includes(HOME_FOLDER_TOKEN)) return [path];
    const homes = [homedir(), ...logFolders().map(homeOfLogFolder)];
    return [...new Set(homes)].map((home) => path.replace(HOME_FOLDER_TOKEN, home.replace(/\\/g, '/')));
};

/**
 * The home folder a log folder hangs under. The token stands for `SpecialFolder.UserHome`
 * (`halfling/Halfling.Logging/Logger.cs`), and {@link logFolders} builds
 * `<home>/Saved Games/Cosmoteer/<id>/Logs`, so the walk back up is four steps rather than three.
 * Exported so a test can hold the two walks against each other.
 *
 * @param folder one of the folders {@link logFolders} builds.
 * @returns the home folder that folder was built from.
 */
export const homeOfLogFolder = (folder: string): string => resolve(folder, '..', '..', '..', '..');

/** Whether a path sits inside a folder, compared the way the game compares paths. */
const isUnder = (path: string, folder: string): boolean => {
    const a = foldPathCase(resolve(path));
    const b = foldPathCase(resolve(folder));
    return a === b || a.startsWith(`${b}/`) || a.startsWith(`${b}\\`);
};

/**
 * The path a finding names, respelled with the casing the disk holds below `modRoot`.
 *
 * Windows opens a file under any casing, so the game can log a path the editor would not recognize
 * as the document it has open: the uri is built from the text, and a diagnostic on
 * `.../PARTS/THING.RULES` sits in the Problems panel beside the open `.../parts/thing.rules` and is
 * never retracted when that file is saved. Only the segments below `modRoot` are respelled, since
 * `modRoot` was walked up from the anchor document's own uri and so already carries the casing the
 * editor uses, links and all. A segment the directory no longer holds is kept as written, and the
 * existence check the caller runs decides what that means.
 *
 * @param modRoot the mod root, in the editor's own spelling.
 * @param absolute the candidate path, in the log's spelling.
 * @returns the path as the disk spells it.
 */
const withDiskCasing = async (modRoot: string, absolute: string): Promise<string> => {
    let current = modRoot;
    for (const segment of relative(modRoot, absolute).split(/[\\/]/)) {
        if (!segment) continue;
        const entries = await readdir(current).catch(() => []);
        current = join(current, entries.find((entry) => foldPathCase(entry) === foldPathCase(segment)) ?? segment);
    }
    return current;
};

/**
 * The file a finding names, resolved to something that exists inside the mod.
 *
 * The two ways that can fail read the same to the caller but mean opposite things: a path outside
 * the mod is another mod's business, while a path inside the mod that is no longer there is this
 * mod's own file, deleted or renamed since the run. Which candidate the home-folder token expands
 * to is only known once every candidate has been probed, so the verdict is given after the loop
 * rather than from inside it.
 *
 * @param finding the finding whose file to resolve.
 * @param modRoot the mod whose files may be reported.
 * @param installRoot the game install root, for a path the log wrote relative to it.
 * @returns the absolute path, or which of the two ways it failed.
 */
const findingFile = async (
    finding: GameLogFinding,
    modRoot: string,
    installRoot?: string
): Promise<string | 'not-ours' | 'vanished'> => {
    let underMod = false;
    for (const candidate of expandLoggedPath(finding.file)) {
        // A shader diagnostic names its file relative to the game's own working directory.
        const absolute = isAbsolute(candidate)
            ? candidate
            : installRoot && candidate.startsWith('./')
              ? resolve(installRoot, candidate)
              : null;
        if (!absolute || !isUnder(absolute, modRoot)) continue;
        underMod = true;
        if (
            await stat(absolute)
                .then((entry) => entry.isFile())
                .catch(() => false)
        )
            return withDiskCasing(modRoot, absolute);
    }
    return underMod ? 'vanished' : 'not-ours';
};

/** The range a reported line and column name, or null when the file no longer has that place. */
const positionRange = (text: string, finding: GameLogFinding): Range | null => {
    if (finding.line === undefined || finding.character === undefined) return null;
    const lines = text.split(/\r?\n/);
    const line = finding.line - 1;
    if (line < 0 || line >= lines.length) return null;
    const character = finding.character - 1;
    if (character < 0 || character > lines[line].length) return null;
    // The log records where the parser stopped, not how long the offending text was, so the mark
    // runs to the end of the line rather than claiming a width it does not know.
    return Range.create(line, character, line, Math.max(character, lines[line].length));
};

/** The range the path inside the file names, walked the way a reference is walked. */
const pathRange = async (path: string, finding: GameLogFinding, token: CancellationToken): Promise<Range | null> => {
    if (!finding.otPath) return null;
    const document = await cachedParseFilePath(path, token).catch(() => null);
    if (!document) return null;
    try {
        let node: AbstractNode | null | undefined = document;
        for (const segment of extractSubstrings(finding.otPath)) {
            node = node && stepIntoNode(node, segment);
            if (!node) return null;
        }
        if (!node || node === (document as unknown as AbstractNode)) return null;
        const position = node.position;
        const end = position.characterEnd >= position.characterStart ? position.characterEnd : position.characterStart;
        return Range.create(position.line, position.characterStart, position.line, end);
    } catch {
        // The log names a path in a file the game read after every mod action had been applied, so a
        // segment of it need not exist in the file as it stands. Anchor on the file instead.
        return null;
    }
};

/**
 * Reads the newest game log that says anything about this mod, and turns what it says into
 * diagnostics anchored in the mod's own files.
 *
 * Logs are read newest first and the first one that names a file of this mod wins: the newest log
 * is often a run with a completely different mod set, which says nothing about this one.
 *
 * @param args the document the command was invoked from, used to find the mod.
 * @param host the server's view of files that are open and possibly unsaved.
 * @param cancellationToken cancels the log reads and the file walks.
 * @returns the findings to publish, and how many the log carried that no longer fit the files.
 */
export const importGameLog = async (
    args: { readonly uri?: string },
    host: GameLogHost,
    cancellationToken: CancellationToken
): Promise<ImportGameLogResult> => {
    const modRoot = args.uri ? findModRoot(args.uri) : null;
    if (!modRoot) return { kind: 'no-mod', diagnostics: [], stale: 0 };
    const dataRoot = CosmoteerWorkspaceService.instance.dataRootPath;
    const installRoot = dataRoot ? dirname(dataRoot) : undefined;

    const logs = await logsNewestFirst();
    if (logs.length === 0) return { kind: 'no-logs', diagnostics: [], stale: 0 };
    const modId = (await identityOfMod(modRoot)).manifestId?.toLowerCase();

    for (const log of logs) {
        if (cancellationToken.isCancellationRequested) break;
        const text = await readFile(log.path, 'utf8').catch(() => null);
        if (text === null) continue;
        const report = parseGameLog(text, log.path);

        const diagnostics: GameLogDiagnostic[] = [];
        let stale = 0;
        // Findings about files of this mod that are no longer on disk. They publish nothing, but
        // the run did report on this mod's files, so it cannot be read as an all clear either.
        let vanished = 0;
        let time = '';
        for (const finding of report.findings) {
            // Placing one finding must never cost the rest of them: the files it names are read as
            // they are now, and any of them can have moved on since the run was recorded.
            try {
                const placed = await place(finding, modRoot, installRoot, host, report.gameVersion, cancellationToken);
                if (placed === 'not-ours') continue;
                if (placed === 'vanished') {
                    vanished++;
                    continue;
                }
                time ||= finding.time;
                if (placed === 'stale') stale++;
                else diagnostics.push(placed);
            } catch {
                stale++;
            }
        }
        if (diagnostics.length === 0 && stale === 0) {
            // A run that loaded the mod and reported nothing is the newest word on it. An older
            // run's findings would describe files that have moved on since. A run that did report
            // on a file of this mod, one the author has since deleted or renamed, said something
            // rather than nothing, so it is passed over instead of standing as the all clear.
            if (vanished === 0 && modId && report.modIds.some((id) => id.toLowerCase() === modId)) {
                const { kind, unplaced } = verdictOnARunThatPlacedNothing(report);
                return {
                    kind,
                    log: { path: log.path, time: '', gameVersion: report.gameVersion },
                    diagnostics: [],
                    stale: 0,
                    unplaced,
                };
            }
            continue;
        }
        return {
            kind: 'imported',
            log: { path: log.path, time, gameVersion: report.gameVersion },
            diagnostics,
            stale,
        };
    }
    return { kind: 'nothing-for-this-mod', diagnostics: [], stale: 0 };
};

/**
 * The answer for a run that lists the mod and gave none of the mod's own files a finding.
 *
 * Silence is only an all clear when the run really was silent. A run that died while a mod's
 * actions were applied is named first, because that one failure ends the whole load:
 * `ModInfo.ApplyPreLoadMods` rethrows as `Error loading mod: <Name>` and the loader thread has no
 * catch, so nothing after it runs. The wrapper carries the mod's display `Name` while the roster
 * carries its `ID`, so the name is reported as written rather than matched against this mod, and
 * any such line means the run ended there whichever mod it names. A failure the reader could not
 * place is named after those, as the log wrote it, because saying which file it belongs to would be
 * the guess this whole feature refuses to make.
 *
 * @param report what the log said.
 * @returns the answer, and what to name when the run was not clean.
 */
export const verdictOnARunThatPlacedNothing = (
    report: GameLogReport
): { kind: 'loaded-clean' | 'run-failed'; unplaced: UnplacedReport[] } => {
    const unplaced: UnplacedReport[] = [
        ...report.modLoadFailures.map((failure) => ({
            text: `Error loading mod: ${failure.name}. ${failure.detail}`,
            logLine: failure.logLine,
        })),
        ...report.unplaced.map((entry) => ({ text: entry.text, logLine: entry.logLine })),
    ];
    return { kind: unplaced.length === 0 ? 'loaded-clean' : 'run-failed', unplaced };
};

/**
 * Places one finding in the file it names, as that file stands now.
 *
 * A log outlives the text it describes, so a finding is published only where it still fits: the file
 * must not have been written since the run, and a reported line and column must still exist. Anything
 * else is counted rather than moved to a line that happens to be there.
 *
 * @param finding the finding to place.
 * @param modRoot the mod whose files may be reported.
 * @param installRoot the game install root, for a path the log wrote relative to it.
 * @param host the server's view of files that are open and possibly unsaved.
 * @param gameVersion the version of the run, carried into the message.
 * @param cancellationToken cancels the file walk.
 * @returns the diagnostic, that the finding is about another mod, that the file it names is gone,
 *   or that it no longer fits.
 */
const place = async (
    finding: GameLogFinding,
    modRoot: string,
    installRoot: string | undefined,
    host: GameLogHost,
    gameVersion: string | undefined,
    cancellationToken: CancellationToken
): Promise<GameLogDiagnostic | 'not-ours' | 'vanished' | 'stale'> => {
    const path = await findingFile(finding, modRoot, installRoot);
    if (path === 'not-ours' || path === 'vanished') return path;
    const uri = filePathToUri(path);
    const saved = await readFile(path, 'utf8').catch(() => null);
    const open = host.openText(uri);
    const current = open ?? saved;
    if (current === null) return 'stale';

    const written = await stat(path).catch(() => null);
    const loggedAt = Date.parse(finding.time.replace(/(\d\d)\/(\d\d)\/(\d{4})/, '$3-$1-$2'));
    if (written && Number.isFinite(loggedAt) && written.mtimeMs > loggedAt) return 'stale';
    // The file's own timestamp only moves when the file is saved, so an edit nobody has saved yet
    // gets past the gate above while the text it describes has already moved. A finding the game
    // pinned to a line is counted rather than published in that case, since the line the log names
    // is now some other line of the author's. A finding that only names a path is left alone: it is
    // walked through the tree the editor is holding, so it follows the edit by itself.
    if (open !== undefined && saved !== null && open !== saved && finding.line !== undefined) return 'stale';

    const range = positionRange(current, finding) ?? (await pathRange(path, finding, cancellationToken));
    // A finding the game placed on a line has to keep that line, since the message is about the text
    // there. One that only names a path may still be reported against the file as a whole.
    if (finding.line !== undefined && !range) return 'stale';

    return {
        uri,
        diagnostic: {
            range: range ?? Range.create(0, 0, 0, 0),
            severity: finding.severity === 'warning' ? DiagnosticSeverity.Warning : DiagnosticSeverity.Error,
            source: 'cosmoteer-game-log',
            message: l10n.t('Game log ({0}, Cosmoteer {1}): {2}', finding.time, gameVersion ?? '?', finding.message),
        },
    };
};
