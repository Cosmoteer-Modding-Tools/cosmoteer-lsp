import { readFile, readdir, stat } from 'fs/promises';
import { homedir } from 'os';
import { dirname, isAbsolute, join, resolve } from 'path';
import { CancellationToken, Diagnostic, DiagnosticSeverity, Range } from 'vscode-languageserver';
import { AbstractNode } from '../../core/ast/ast';
import { findModRoot } from '../../mod/mod-root';
import { stepIntoNode } from '../../semantics/reference-resolver';
import { CosmoteerWorkspaceService } from '../../workspace/cosmoteer-workspace.service';
import { cachedParseFilePath } from '../../workspace/fs-cache';
import { foldPathCase } from '../../workspace/fs-cache';
import { localModDirs } from '../../workspace/workshop-dir';
import { filePathToUri } from '../navigation/navigation-strategy';
import { extractSubstrings } from '../navigation/navigation-strategy';
import { GameLogFinding, HOME_FOLDER_TOKEN, parseGameLog } from './game-log';
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

/** What the import found, and which run it read. */
export interface ImportGameLogResult {
    readonly kind: 'imported' | 'no-mod' | 'no-logs' | 'nothing-for-this-mod';
    /** The log that was read, when one was. */
    readonly log?: { readonly path: string; readonly time: string; readonly gameVersion?: string };
    readonly diagnostics: readonly GameLogDiagnostic[];
    /** Findings the log carried for this mod that could no longer be placed in the file. */
    readonly stale: number;
}

/** What the command needs from the server: the text of a file that is open and possibly unsaved. */
export interface GameLogHost {
    openText(uri: string): string | undefined;
}

/** The game logs and its mods folder are siblings, both under the user's own save folder. */
const logFolders = (): string[] => localModDirs().map((mods) => join(dirname(mods), 'Logs'));

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
    const homes = [homedir(), ...logFolders().map((folder) => resolve(folder, '..', '..', '..'))];
    return [...new Set(homes)].map((home) => path.replace(HOME_FOLDER_TOKEN, home.replace(/\\/g, '/')));
};

/** Whether a path sits inside a folder, compared the way the game compares paths. */
const isUnder = (path: string, folder: string): boolean => {
    const a = foldPathCase(resolve(path));
    const b = foldPathCase(resolve(folder));
    return a === b || a.startsWith(`${b}/`) || a.startsWith(`${b}\\`);
};

/** The file a finding names, resolved to something that exists inside the mod, or null. */
const findingFile = async (finding: GameLogFinding, modRoot: string, installRoot?: string): Promise<string | null> => {
    for (const candidate of expandLoggedPath(finding.file)) {
        // A shader diagnostic names its file relative to the game's own working directory.
        const absolute = isAbsolute(candidate)
            ? candidate
            : installRoot && candidate.startsWith('./')
              ? resolve(installRoot, candidate)
              : null;
        if (!absolute || !isUnder(absolute, modRoot)) continue;
        if (await stat(absolute).then((entry) => entry.isFile()).catch(() => false)) return absolute;
    }
    return null;
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

    for (const log of logs) {
        if (cancellationToken.isCancellationRequested) break;
        const text = await readFile(log.path, 'utf8').catch(() => null);
        if (text === null) continue;
        const report = parseGameLog(text, log.path);

        const diagnostics: GameLogDiagnostic[] = [];
        let stale = 0;
        let time = '';
        for (const finding of report.findings) {
            // Placing one finding must never cost the rest of them: the files it names are read as
            // they are now, and any of them can have moved on since the run was recorded.
            try {
                const placed = await place(finding, modRoot, installRoot, host, report.gameVersion, cancellationToken);
                if (placed === 'not-ours') continue;
                time ||= finding.time;
                if (placed === 'stale') stale++;
                else diagnostics.push(placed);
            } catch {
                stale++;
            }
        }
        if (diagnostics.length === 0 && stale === 0) continue;
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
 * @returns the diagnostic, that the finding is about another mod, or that it no longer fits.
 */
const place = async (
    finding: GameLogFinding,
    modRoot: string,
    installRoot: string | undefined,
    host: GameLogHost,
    gameVersion: string | undefined,
    cancellationToken: CancellationToken
): Promise<GameLogDiagnostic | 'not-ours' | 'stale'> => {
    const path = await findingFile(finding, modRoot, installRoot);
    if (!path) return 'not-ours';
    const uri = filePathToUri(path);
    const current = host.openText(uri) ?? (await readFile(path, 'utf8').catch(() => null));
    if (current === null) return 'stale';

    const written = await stat(path).catch(() => null);
    const loggedAt = Date.parse(finding.time.replace(/(\d\d)\/(\d\d)\/(\d{4})/, '$3-$1-$2'));
    if (written && Number.isFinite(loggedAt) && written.mtimeMs > loggedAt) return 'stale';

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
