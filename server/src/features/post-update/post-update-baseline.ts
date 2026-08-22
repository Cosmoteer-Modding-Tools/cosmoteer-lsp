import { createHash } from 'crypto';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'fs/promises';
import { dirname } from 'path';
import { Diagnostic } from 'vscode-languageserver';
import { LintSeverity } from '../../cli/rule-ids';
import { ruleIdFor } from '../../cli/rule-ids';
import { workspaceRelativePath } from '../../utils/relative-path';
import { foldPathCase } from '../../workspace/fs-cache';
import { cacheArtifactPath, currentServerBuildId } from '../../workspace/index-cache';
import { workshopContentDir } from '../../workspace/workshop-dir';
import { discoverModAssemblies } from '../mod-schema/mod-schema';
import { gameAssemblyPathFor, readGameVersionInfo } from './game-version';

/**
 * The two-generation store of what the workspace scan found, which is the only way to say what a
 * game update changed.
 *
 * A game update rewrites the tree every reference in a mod resolves against, and the editor sees
 * the result only as a set of diagnostics that is suddenly different. Nothing in the editor
 * remembers what the set looked like before, so the difference cannot be attributed to anything.
 * This store keeps two generations of it: the findings under the game version the project was last
 * scanned under, and the findings under the version before that. Writing on every scan would be
 * self-defeating, because the first scan after an update would overwrite the only record of what
 * the project looked like before it. So the store rolls over instead: a scan under a new game
 * version pushes the standing generation into `previous` and starts a new `current`, and every
 * further scan under that same version overwrites `current` alone.
 *
 * Findings are keyed by file, rule id and severity, never by message text. Messages are localized
 * and get reworded between extension releases, so keying on them would report a language change or
 * an upgrade as the whole project breaking and healing at once.
 */

/** Bump when the persisted shape changes, which discards every stored baseline. */
export const BASELINE_FORMAT_VERSION = 1;

/**
 * How many grouped findings one generation stores. A large mod produces a few thousand groups, so
 * this is far above what a real project reaches and only bounds the pathological case where a
 * broken game path makes every file of a huge tree fail at once.
 */
export const MAX_STORED_FINDINGS = 20000;

/** One group of findings that share a file, a rule and a severity. */
export interface BaselineFinding {
    /** The file, relative to its workspace folder, with forward slashes. */
    readonly path: string;
    /** The rule that produced them, from the shared rule table. */
    readonly ruleId: string;
    readonly severity: LintSeverity;
    /**
     * The line every finding of the group sits on, one based and in ascending order, one entry per
     * finding. The lines are what lets a comparison name the line that broke instead of only saying
     * that the group grew, and a file that did not change on disk cannot move a finding's line
     * without the reason for the finding moving with it.
     */
    readonly lines: readonly number[];
    /** One of the messages, shown as an example. Never used to decide whether a group matches. */
    readonly message: string;
}

/** The persisted tuple form of {@link BaselineFinding}, which halves the file size. */
type StoredFinding = [path: string, ruleId: string, severity: LintSeverity, lines: number[], message: string];

/** The persisted identity of one scanned file. */
type StoredStamp = [path: string, size: number, mtimeMs: number];

/** What was installed and configured around a scan, so a later diff can tell whether it is comparable. */
export interface EnvironmentFingerprint {
    /** The installed workshop mods, by folder and modification time. */
    readonly workshop: string;
    /** The code-mod assemblies in the open folders, by path, size and modification time. */
    readonly codeMods: string;
    /** The game's own assembly, by size and modification time. */
    readonly gameBinary: string;
}

/** One generation: what a scan found, and everything that decides whether it is comparable to another. */
export interface PostUpdateSnapshot {
    /** The installed game version at scan time, empty when it could not be read. */
    readonly gameVersion: string;
    /** When the snapshot was written, in epoch milliseconds. */
    readonly savedAt: number;
    /** The server build that produced the findings. */
    readonly serverBuildId: string;
    /** A hash of the scan-relevant settings, including the display language. */
    readonly settingsHash: string;
    readonly environment: EnvironmentFingerprint;
    /** How many files the scan covered. */
    readonly fileCount: number;
    /** How many findings the scan produced, counted before any grouping or capping. */
    readonly findingCount: number;
    /** How many groups did not fit in {@link MAX_STORED_FINDINGS}. */
    readonly omittedFindings: number;
    /** The per-file problem cap in force at scan time. */
    readonly maxProblems: number;
    /** Files that reached the cap, whose finding list is therefore only a prefix of the truth. */
    readonly cappedFiles: readonly string[];
    readonly stamps: readonly StoredStamp[];
    readonly findings: readonly BaselineFinding[];
}

/** Both generations, as the store holds them. */
export interface BaselinePair {
    /** The findings under the game version the project was last scanned under. */
    readonly current?: PostUpdateSnapshot;
    /** The findings under the version before that, which is what a report compares against. */
    readonly previous?: PostUpdateSnapshot;
}

/** The on-disk shape. */
interface BaselineFile {
    formatVersion: number;
    dataRoot: string;
    current?: SerializedSnapshot;
    previous?: SerializedSnapshot;
}

/** A snapshot as it is written, with the findings in their tuple form. */
type SerializedSnapshot = Omit<PostUpdateSnapshot, 'findings'> & { findings: StoredFinding[] };

/** What {@link savePostUpdateBaseline} did, which the server log states so the store is not silent. */
export type BaselineSaveOutcome = 'created' | 'updated' | 'rolledOver' | 'skipped';

/**
 * The store's file for one game install and one set of workspace folders.
 *
 * @param dataRoot the game `Data` root the scan resolved against.
 * @param folderPaths the workspace folder paths the scan covered.
 * @returns the absolute file path.
 */
export const postUpdateBaselinePath = (dataRoot: string, folderPaths: readonly string[]): string =>
    cacheArtifactPath(dataRoot, `post-update-baseline-${folderKeyOf(folderPaths)}`);

/**
 * The folder-set identity a store file is keyed by, matching how the other caches key theirs.
 *
 * @param folderPaths the workspace folder paths.
 * @returns a short stable hash.
 */
const folderKeyOf = (folderPaths: readonly string[]): string =>
    createHash('sha1')
        .update(
            [...folderPaths]
                .map((folder) => folder.replace(/\\/g, '/').toLowerCase())
                .sort()
                .join('\n')
        )
        .digest('hex')
        .slice(0, 16);

/** What a snapshot is built from: one scan's per-file results and the state it ran under. */
export interface SnapshotInput {
    readonly gameVersion: string;
    readonly settingsKey: string;
    readonly environment: EnvironmentFingerprint;
    readonly folderPaths: readonly string[];
    readonly maxProblems: number;
    /** One entry per scanned file: its path, the stat it was validated at, and what it produced. */
    readonly entries: readonly (readonly [path: string, size: number, mtimeMs: number, diagnostics: Diagnostic[]])[];
}

/**
 * Group one scan's results into a snapshot.
 *
 * @param input the scan's results and the state it ran under.
 * @returns the snapshot, ready to be stored or compared.
 */
export const buildSnapshot = (input: SnapshotInput): PostUpdateSnapshot => {
    const groups = new Map<string, { path: string; ruleId: string; severity: LintSeverity; lines: number[]; message: string }>();
    const cappedFiles: string[] = [];
    let findingCount = 0;
    for (const [path, , , diagnostics] of input.entries) {
        const relative = workspaceRelativePath(path, input.folderPaths);
        if (input.maxProblems > 0 && diagnostics.length >= input.maxProblems) cappedFiles.push(relative);
        for (const diagnostic of diagnostics) {
            findingCount++;
            const ruleId = ruleIdFor(diagnostic.code);
            const severity = severityOf(diagnostic.severity);
            const line = (diagnostic.range?.start?.line ?? 0) + 1;
            const key = findingKey(relative, ruleId, severity);
            const existing = groups.get(key);
            if (existing) {
                existing.lines.push(line);
                continue;
            }
            groups.set(key, { path: relative, ruleId, severity, lines: [line], message: messageOf(diagnostic) });
        }
    }
    const ordered: BaselineFinding[] = [...groups.values()]
        .map((group) => ({ ...group, lines: [...group.lines].sort((a, b) => a - b) }))
        .sort(
            (a, b) =>
                compareText(a.path, b.path) || compareText(a.ruleId, b.ruleId) || compareText(a.severity, b.severity)
        );
    const stamps: StoredStamp[] = input.entries.map(([path, size, mtimeMs]) => [
        workspaceRelativePath(path, input.folderPaths),
        size,
        Math.round(mtimeMs),
    ]);
    return {
        gameVersion: input.gameVersion,
        savedAt: Date.now(),
        serverBuildId: currentServerBuildId(),
        settingsHash: createHash('sha1').update(input.settingsKey).digest('hex').slice(0, 16),
        environment: input.environment,
        fileCount: input.entries.length,
        findingCount,
        omittedFindings: Math.max(0, ordered.length - MAX_STORED_FINDINGS),
        maxProblems: input.maxProblems,
        cappedFiles: cappedFiles.sort(compareText),
        stamps,
        findings: ordered.slice(0, MAX_STORED_FINDINGS),
    };
};

/**
 * The key a finding group is matched by across two snapshots: the file, the rule and the severity.
 *
 * The line is not part of the key, so that everything one check reports in one file stays in one
 * group and a comparison can talk about the group as a whole. The lines inside the group are
 * compared as well, which is what lets the report name the line that broke.
 *
 * @param path the file, relative to its workspace folder.
 * @param ruleId the rule that produced the finding.
 * @param severity the finding's severity.
 * @returns the key.
 */
export const findingKey = (path: string, ruleId: string, severity: LintSeverity): string =>
    // Joined on a character no path, rule id or severity can hold, so two different triples
    // can never produce one key.
    `${foldPathCase(path)}\u0000${ruleId}\u0000${severity}`;

/**
 * A diagnostic's message as plain text. The protocol lets a message be markup as of 3.18, and the
 * report shows it as one table cell either way.
 *
 * @param diagnostic the diagnostic.
 * @returns the message text.
 */
const messageOf = (diagnostic: Diagnostic): string =>
    typeof diagnostic.message === 'string' ? diagnostic.message : diagnostic.message.value;

/** The severities the protocol numbers, in the naming the reports use. */
const SEVERITY_NAMES: Record<number, LintSeverity> = { 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' };

/**
 * The severity name of a diagnostic. A diagnostic without one is an error, which is what the
 * protocol tells a client to assume.
 *
 * @param severity the diagnostic's severity number, when it carries one.
 * @returns the severity name.
 */
const severityOf = (severity: number | undefined): LintSeverity => SEVERITY_NAMES[severity ?? 1] ?? 'error';

/**
 * Compare two strings by code point, so a stored order never depends on the machine's locale.
 *
 * @param a the first string.
 * @param b the second string.
 * @returns a negative number, zero or a positive number, as a sort comparator wants.
 */
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Store a snapshot, rolling the standing generation over when the game version changed.
 *
 * Best effort in the same sense as the other caches: a failure to write leaves the previous file in
 * place and never disturbs the scan that produced the findings.
 *
 * @param dataRoot the game `Data` root the scan resolved against.
 * @param folderPaths the workspace folder paths the scan covered.
 * @param snapshot the snapshot to store.
 * @returns what the store did, which is 'skipped' when it could not write.
 */
export const savePostUpdateBaseline = async (
    dataRoot: string,
    folderPaths: readonly string[],
    snapshot: PostUpdateSnapshot
): Promise<BaselineSaveOutcome> => {
    try {
        const file = postUpdateBaselinePath(dataRoot, folderPaths);
        const stored = await readBaselineFile(file);
        const standing = stored?.current;
        // A scan under a new game version is the only moment the previous generation can still be
        // saved, since this very snapshot is about to replace it.
        const rolled = standing !== undefined && standing.gameVersion !== snapshot.gameVersion;
        const next: BaselineFile = {
            formatVersion: BASELINE_FORMAT_VERSION,
            dataRoot,
            current: serialize(snapshot),
            // The standing generation is carried over in the form it was stored in, so a rollover
            // never re-encodes it.
            previous: rolled ? standing : stored?.previous,
        };
        await mkdir(dirname(file), { recursive: true });
        const temp = `${file}.${process.pid}.tmp`;
        await writeFile(temp, JSON.stringify(next), { encoding: 'utf-8' });
        await rename(temp, file);
        return rolled ? 'rolledOver' : standing ? 'updated' : 'created';
    } catch {
        return 'skipped';
    }
};

/** What one finished scan hands the store, which is what the scan already has in hand. */
export interface ScanRecording {
    /** The game `Data` root the scan resolved against. */
    readonly dataRoot: string;
    /** The workspace folders the scan covered. */
    readonly folderPaths: readonly string[];
    /** The scan-relevant settings serialization the results were produced under. */
    readonly settingsKey: string;
    /** The per-file problem cap in force. */
    readonly maxProblems: number;
    /** The per-file results, exactly the set the Problems panel shows. */
    readonly entries: readonly (readonly [path: string, size: number, mtimeMs: number, diagnostics: Diagnostic[]])[];
}

/**
 * Record what a finished scan found, which is the whole of what the server has to do to keep the
 * store current.
 *
 * Called from the scan's own save step with the results that were just published, so the recording
 * is what the reader saw rather than a second, differently timed validation of the same files.
 *
 * @param recording the finished scan.
 * @returns what the store did, which is 'skipped' when it could not write.
 */
export const recordScanBaseline = async (recording: ScanRecording): Promise<BaselineSaveOutcome> => {
    if (recording.entries.length === 0) return 'skipped';
    const info = await readGameVersionInfo(recording.dataRoot).catch(() => undefined);
    const snapshot = buildSnapshot({
        gameVersion: info?.installed ?? '',
        settingsKey: recording.settingsKey,
        environment: await environmentFingerprint(recording.dataRoot, recording.folderPaths),
        folderPaths: recording.folderPaths,
        maxProblems: recording.maxProblems,
        entries: recording.entries,
    });
    return await savePostUpdateBaseline(recording.dataRoot, recording.folderPaths, snapshot);
};

/**
 * Load both generations.
 *
 * @param dataRoot the game `Data` root.
 * @param folderPaths the workspace folder paths.
 * @returns the stored generations, or undefined when nothing readable is stored.
 */
export const loadPostUpdateBaseline = async (
    dataRoot: string,
    folderPaths: readonly string[]
): Promise<BaselinePair | undefined> => {
    const stored = await readBaselineFile(postUpdateBaselinePath(dataRoot, folderPaths));
    if (!stored) return undefined;
    return { current: deserialize(stored.current), previous: deserialize(stored.previous) };
};

/**
 * Read and validate the store file.
 *
 * @param file the file to read.
 * @returns its content, or undefined when it is absent, unreadable or of another format version.
 */
const readBaselineFile = async (file: string): Promise<BaselineFile | undefined> => {
    try {
        const parsed = JSON.parse(await readFile(file, { encoding: 'utf-8' })) as BaselineFile;
        if (parsed.formatVersion !== BASELINE_FORMAT_VERSION) return undefined;
        return parsed;
    } catch {
        return undefined;
    }
};

/**
 * Turn a snapshot into its stored form.
 *
 * @param snapshot the snapshot.
 * @returns the same data with the findings as tuples.
 */
const serialize = (snapshot: PostUpdateSnapshot): SerializedSnapshot => ({
    ...snapshot,
    findings: snapshot.findings.map((finding) => [
        finding.path,
        finding.ruleId,
        finding.severity,
        [...finding.lines],
        finding.message,
    ]),
});

/**
 * Turn a stored snapshot back into its working form, rejecting anything of the wrong shape.
 *
 * @param stored the stored snapshot, when the file held one.
 * @returns the snapshot, or undefined when it is absent or malformed.
 */
const deserialize = (stored: SerializedSnapshot | undefined): PostUpdateSnapshot | undefined => {
    if (!stored || !Array.isArray(stored.findings) || !Array.isArray(stored.stamps)) return undefined;
    const findings: BaselineFinding[] = [];
    for (const entry of stored.findings) {
        if (!Array.isArray(entry) || typeof entry[0] !== 'string' || typeof entry[1] !== 'string') return undefined;
        if (!Array.isArray(entry[3])) return undefined;
        findings.push({
            path: entry[0],
            ruleId: entry[1],
            severity: entry[2],
            lines: entry[3].map((line) => Number(line) || 1),
            message: String(entry[4] ?? ''),
        });
    }
    return { ...stored, findings };
};

/**
 * Fingerprint everything outside the scanned files that decides what the scan reports.
 *
 * A finding can appear because the game tree changed, which is what the report is about, but also
 * because a workshop mod was subscribed or updated, because a code mod was rebuilt, or because the
 * game binary itself moved. Recording all three lets the report say which of them changed rather
 * than blaming the update for a finding one of the others produced.
 *
 * @param dataRoot the game `Data` root.
 * @param folderPaths the open workspace folders.
 * @returns the fingerprint, whose parts are empty strings where nothing could be read.
 */
export const environmentFingerprint = async (
    dataRoot: string | undefined,
    folderPaths: readonly string[]
): Promise<EnvironmentFingerprint> => ({
    workshop: await workshopFingerprint(),
    codeMods: await codeModFingerprint(folderPaths),
    gameBinary: dataRoot ? await fileStampOf(gameAssemblyPathFor(dataRoot)) : '',
});

/**
 * The installed workshop mods, as a hash of folder names and modification times.
 *
 * Only the immediate children are read. Steam touches a mod's folder when it updates it, so this
 * catches a subscription, an unsubscription and an update without walking tens of thousands of
 * files on every scan.
 *
 * @returns the hash, or an empty string when no workshop folder exists.
 */
const workshopFingerprint = async (): Promise<string> => {
    const dir = workshopContentDir();
    if (!dir) return '';
    try {
        const entries = await readdir(dir, { withFileTypes: true });
        const lines: string[] = [];
        for (const entry of entries.sort((a, b) => compareText(a.name, b.name))) {
            if (!entry.isDirectory()) continue;
            const info = await stat(`${dir}/${entry.name}`).catch(() => undefined);
            lines.push(`${entry.name}:${info ? Math.round(info.mtimeMs) : 0}`);
        }
        return createHash('sha1').update(lines.join('\n')).digest('hex').slice(0, 16);
    } catch {
        return '';
    }
};

/**
 * The code-mod assemblies in the open folders, as a hash of path, size and modification time.
 *
 * A rebuilt assembly changes which types and fields the schema knows, which changes what the schema
 * checks report, so a diff across a rebuild is not attributable to the game.
 *
 * @param folderPaths the open workspace folders.
 * @returns the hash, or an empty string when the folders hold no assembly.
 */
const codeModFingerprint = async (folderPaths: readonly string[]): Promise<string> => {
    try {
        const stamps = await discoverModAssemblies(folderPaths);
        if (stamps.length === 0) return '';
        const lines = stamps.map((stamp) => `${stamp.path}:${stamp.size}:${Math.round(stamp.mtimeMs)}`);
        return createHash('sha1').update(lines.join('\n')).digest('hex').slice(0, 16);
    } catch {
        return '';
    }
};

/**
 * One file's size and modification time, as a short string.
 *
 * @param path the file.
 * @returns the stamp, or an empty string when the file cannot be read.
 */
const fileStampOf = async (path: string): Promise<string> => {
    const info = await stat(path).catch(() => undefined);
    return info ? `${info.size}:${Math.round(info.mtimeMs)}` : '';
};
