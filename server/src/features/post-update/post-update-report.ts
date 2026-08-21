import { join } from 'path';
import { Diagnostic } from 'vscode-languageserver';
import { allDeprecationSymbols, deprecationBySymbol } from '../../document/schema/deprecations';
import { manifestPathsIn, readManifest, scalarMember } from '../../mod/mod-dependencies';
import { safeReaddir } from '../../utils/fs.utils';
import { workspaceRelativePath } from '../../utils/relative-path';
import { foldPathCase } from '../../workspace/fs-cache';
import { MigrationSummary } from '../migration/migrate-workspace';
import {
    GameVersionInfo,
    ModVersionVerdict,
    declaredCompatibleVersions,
    modVersionVerdict,
    readGameVersionInfo,
} from './game-version';
import {
    BaselineFinding,
    BaselinePair,
    PostUpdateSnapshot,
    buildSnapshot,
    environmentFingerprint,
    findingKey,
    loadPostUpdateBaseline,
} from './post-update-baseline';
import { renderPostUpdateReport } from './post-update-report.render';

/**
 * The report that answers "the game updated, what does that mean for my mod".
 *
 * It is built out of three things the editor can actually know. The first is the difference between
 * the findings the workspace scan produced under the previous game version and the findings it
 * produces now, which is the only evidence in the editor that an update moved anything. The second
 * is what the installed game makes of the mod's declared `CompatibleGameVersions`, read from the
 * game's own accepted-version list. The third is what the migration would rewrite, taken from a dry
 * run rather than from a second walk of the workspace.
 *
 * Every one of those has a hard edge, and the report states each of them in its own text. A
 * difference is only attributable to the update while nothing else moved, so a file the author
 * edited, a changed setting, an upgraded extension, a subscribed workshop mod and a rebuilt code mod
 * are each detected and each said out loud. The schema is a build artifact checked into the
 * extension, so an update to the game cannot make a field unknown and the report never implies it
 * could. The deprecation registry is written by hand and stops at the newest version somebody
 * entered, so the migration half cannot describe the update the reader just took.
 */

/** The command both editors invoke to build the report. */
export const POST_UPDATE_REPORT_COMMAND = 'cosmoteer.postUpdateReport';

/** Why the report could not compare two generations of findings, or that it could. */
export type PostUpdateStatus =
    /** Two generations exist and the report compares them. */
    | 'compared'
    /** No game install is configured, so nothing about versions or the game tree can be read. */
    | 'noGamePath'
    /** Whole-workspace validation is off, so no scan ever records what the project looked like. */
    | 'wholeWorkspaceOff'
    /** The scan has not produced results yet in this session. */
    | 'noScanResults'
    /** Nothing was ever stored for this project. */
    | 'noBaseline'
    /** Only one generation is stored, so there is no before-the-update state to compare against. */
    | 'noPreviousGeneration'
    /** The stored generation was taken under the version that is installed now. */
    | 'sameGameVersion';

/** How a finding difference is attributed. */
export type DeltaKind =
    /** The finding appeared in a file nothing but the game tree changed under. */
    | 'appeared'
    /** The finding is gone from a file nothing but the game tree changed under. */
    | 'resolved'
    /** The finding moved in a file the author edited since the snapshot. */
    | 'edited'
    /** The file entered the scan since the snapshot, so nothing about it can be compared. */
    | 'fileEntered'
    /** The file left the scan since the snapshot. */
    | 'fileLeft'
    /** The file reached the per-file problem cap, so a finding leaving it means nothing. */
    | 'capped';

/** One attributed difference between the two generations. */
export interface FindingDelta {
    readonly kind: DeltaKind;
    readonly path: string;
    readonly ruleId: string;
    readonly severity: BaselineFinding['severity'];
    /** The lines the difference is on, one based and in ascending order. */
    readonly lines: readonly number[];
    /** How many findings the difference covers, which is how many lines it names. */
    readonly count: number;
    /** One message from the group, as an example. */
    readonly message: string;
}

/** What the comparison found, before it is rendered. */
export interface PostUpdateDiff {
    readonly deltas: readonly FindingDelta[];
    /** Files whose size or modification time moved since the snapshot. */
    readonly editedFiles: readonly string[];
    /** Files the scan covers now and did not cover then. */
    readonly enteredFiles: readonly string[];
    /** Files the scan covered then and does not cover now. */
    readonly leftFiles: readonly string[];
}

/** Something that moved besides the game, which makes an attribution to the update unsafe. */
export type AttributionWarning = 'serverBuild' | 'settings' | 'workshop' | 'codeMods' | 'unknownVersion' | 'untagged';

/** What the installed game would do with one of the mod's manifests. */
export interface ManifestVerdict {
    /** The manifest, relative to its workspace folder. */
    readonly path: string;
    /** The mod's declared id, when it declares one. */
    readonly modId?: string;
    /** The versions the manifest declares, or undefined when it declares none. */
    readonly declared?: readonly string[];
    readonly verdict: ModVersionVerdict;
}

/** What the report was built from, so the caller can act on it without parsing the markdown. */
export interface PostUpdateSummary {
    readonly status: PostUpdateStatus;
    readonly installedVersion: string;
    readonly previousVersion: string;
    /** How many findings the update is held responsible for. */
    readonly appeared: number;
    /** How many findings stopped being reported. */
    readonly resolved: number;
    readonly attribution: readonly AttributionWarning[];
    readonly manifests: readonly ManifestVerdict[];
    /** How many files the migration would rewrite, when a dry run was available. */
    readonly migrationFiles?: number;
}

/** The report, in the two forms a client needs. */
export interface PostUpdateReportResult {
    readonly markdown: string;
    readonly summary: PostUpdateSummary;
}

/** Everything the report needs from the server, so it never re-runs a scan of its own. */
export interface PostUpdateReportRequest {
    /** The configured game `Data` root, undefined when none is set. */
    readonly dataRoot?: string;
    /** The open workspace folders, as on-disk paths. */
    readonly folderPaths: readonly string[];
    /** Whether whole-workspace validation is on, which is what writes the baseline. */
    readonly wholeWorkspaceEnabled: boolean;
    /** The per-file problem cap in force. */
    readonly maxProblems: number;
    /** The scan-relevant settings serialization, which includes the display language. */
    readonly settingsKey: string;
    /** The live scan results, one entry per scanned file, exactly as the Problems panel shows them. */
    readonly entries: readonly (readonly [path: string, size: number, mtimeMs: number, diagnostics: Diagnostic[]])[];
    /** What a dry run of the migration would do, when the caller ran one. */
    readonly migration?: MigrationSummary;
    /** The game version the imported log was written by, when a log was imported this session. */
    readonly lastRunVersion?: string;
}

/**
 * Build the report.
 *
 * @param request everything the server knows that the report needs.
 * @returns the markdown and the machine-readable summary.
 */
export const buildPostUpdateReport = async (request: PostUpdateReportRequest): Promise<PostUpdateReportResult> => {
    const info = await readGameVersionInfo(request.dataRoot);
    const manifests = await manifestVerdicts(request.folderPaths, info);
    const stored = request.dataRoot ? await loadPostUpdateBaseline(request.dataRoot, request.folderPaths) : undefined;
    const live = await liveSnapshot(request, info);
    const status = statusOf(request, stored, live);
    const previous = stored?.previous;
    const diff = status === 'compared' && previous && live ? diffSnapshots(previous, live) : emptyDiff();
    const attribution = status === 'compared' && previous && live ? attributionWarnings(previous, live, diff) : [];
    const summary: PostUpdateSummary = {
        status,
        installedVersion: info.installed,
        previousVersion: previous?.gameVersion ?? '',
        appeared: countOf(diff, 'appeared'),
        resolved: countOf(diff, 'resolved'),
        attribution,
        manifests,
        migrationFiles: request.migration?.files,
    };
    return {
        markdown: renderPostUpdateReport({
            request,
            info,
            summary,
            diff,
            previous,
            current: live,
            registryVersion: newestRegistryVersion(),
        }),
        summary,
    };
};

/**
 * The snapshot of what the scan reports right now.
 *
 * @param request the report request.
 * @param info the installed game's version facts.
 * @returns the snapshot, or undefined when the scan has produced nothing to snapshot.
 */
const liveSnapshot = async (
    request: PostUpdateReportRequest,
    info: GameVersionInfo
): Promise<PostUpdateSnapshot | undefined> => {
    if (request.entries.length === 0) return undefined;
    return buildSnapshot({
        gameVersion: info.installed,
        settingsKey: request.settingsKey,
        environment: await environmentFingerprint(request.dataRoot, request.folderPaths),
        folderPaths: request.folderPaths,
        maxProblems: request.maxProblems,
        entries: request.entries,
    });
};

/**
 * Decide whether the two generations can be compared, and why not when they cannot.
 *
 * @param request the report request.
 * @param stored the stored generations, when any are stored.
 * @param live the snapshot of what the scan reports now.
 * @returns the status.
 */
const statusOf = (
    request: PostUpdateReportRequest,
    stored: BaselinePair | undefined,
    live: PostUpdateSnapshot | undefined
): PostUpdateStatus => {
    if (!request.dataRoot) return 'noGamePath';
    if (!request.wholeWorkspaceEnabled) return 'wholeWorkspaceOff';
    if (!live) return 'noScanResults';
    if (!stored?.current && !stored?.previous) return 'noBaseline';
    if (!stored.previous) return 'noPreviousGeneration';
    // A stored generation from the version that is installed now was not taken before an update, so
    // whatever differs between it and the live scan is not the update's doing.
    if (stored.previous.gameVersion === live.gameVersion) return 'sameGameVersion';
    return 'compared';
};

/** The empty comparison, used whenever there is nothing to compare. */
const emptyDiff = (): PostUpdateDiff => ({ deltas: [], editedFiles: [], enteredFiles: [], leftFiles: [] });

/**
 * How many findings of one kind the comparison holds, counting the lines rather than the groups.
 *
 * @param diff the comparison.
 * @param kind the kind to count.
 * @returns the number of findings.
 */
const countOf = (diff: PostUpdateDiff, kind: DeltaKind): number =>
    diff.deltas.filter((delta) => delta.kind === kind).reduce((total, delta) => total + delta.count, 0);

/**
 * Compare two generations of findings and attribute every difference.
 *
 * A difference is only laid at the update's door when the file it is in was scanned in both
 * generations and its size and modification time did not move, because those are the two ways the
 * editor can tell "the file is as it was" from "the author changed it". Everything else is reported
 * in its own category rather than being dropped, since a difference the report cannot attribute is
 * still a difference the reader may want to look at.
 *
 * @param previous the generation from before the update.
 * @param current the generation from after it.
 * @returns the attributed differences.
 */
export const diffSnapshots = (previous: PostUpdateSnapshot, current: PostUpdateSnapshot): PostUpdateDiff => {
    const before = stampMap(previous);
    const after = stampMap(current);
    const editedFiles: string[] = [];
    const enteredFiles: string[] = [];
    const leftFiles: string[] = [];
    for (const [key, [path]] of after) {
        if (!before.has(key)) enteredFiles.push(path);
        else if (!sameStamp(before.get(key), after.get(key))) editedFiles.push(path);
    }
    for (const [key, [path]] of before) if (!after.has(key)) leftFiles.push(path);
    const editedKeys = new Set(editedFiles.map(foldPathCase));
    const enteredKeys = new Set(enteredFiles.map(foldPathCase));
    const leftKeys = new Set(leftFiles.map(foldPathCase));
    const cappedKeys = new Set([...previous.cappedFiles, ...current.cappedFiles].map((path) => foldPathCase(path)));

    const beforeFindings = findingMap(previous);
    const afterFindings = findingMap(current);
    const deltas: FindingDelta[] = [];
    for (const key of new Set([...beforeFindings.keys(), ...afterFindings.keys()])) {
        const was = beforeFindings.get(key);
        const now = afterFindings.get(key);
        const group = now ?? was;
        if (!group) continue;
        const kind = kindFor(group.path, editedKeys, enteredKeys, leftKeys);
        const gained = linesMissingFrom(now?.lines ?? [], was?.lines ?? []);
        const lost = linesMissingFrom(was?.lines ?? [], now?.lines ?? []);
        if (gained.length > 0) deltas.push(deltaOf(group, gained, kind));
        if (lost.length === 0) continue;
        // A file that hit the per-file problem cap publishes an arbitrary prefix of its findings, so
        // one finding leaving it says nothing about whether the finding is gone.
        if (kind !== 'appeared') deltas.push(deltaOf(group, lost, kind));
        else deltas.push(deltaOf(group, lost, cappedKeys.has(foldPathCase(group.path)) ? 'capped' : 'resolved'));
    }
    return {
        deltas: deltas.sort(
            (a, b) => compareText(a.path, b.path) || compareText(a.ruleId, b.ruleId) || (a.lines[0] ?? 0) - (b.lines[0] ?? 0)
        ),
        editedFiles: editedFiles.sort(compareText),
        enteredFiles: enteredFiles.sort(compareText),
        leftFiles: leftFiles.sort(compareText),
    };
};

/**
 * The lines of one group that the other group does not account for, counting repeats.
 *
 * Comparing the lines rather than only the number of findings is what lets the report name the line
 * that broke, and it also catches an update that breaks one line and fixes another of the same
 * check in the same file, which a count alone reports as no change at all.
 *
 * @param lines the group's lines.
 * @param other the lines to account for them with.
 * @returns the unaccounted lines, in ascending order.
 */
const linesMissingFrom = (lines: readonly number[], other: readonly number[]): number[] => {
    const remaining = new Map<number, number>();
    for (const line of other) remaining.set(line, (remaining.get(line) ?? 0) + 1);
    const missing: number[] = [];
    for (const line of lines) {
        const left = remaining.get(line) ?? 0;
        if (left > 0) remaining.set(line, left - 1);
        else missing.push(line);
    }
    return missing.sort((a, b) => a - b);
};

/**
 * Which category a file's differences fall into.
 *
 * @param path the file, relative to its workspace folder.
 * @param edited the files whose stamp moved.
 * @param entered the files that entered the scan.
 * @param left the files that left it.
 * @returns 'appeared' when the file is comparable, the file's own category otherwise.
 */
const kindFor = (
    path: string,
    edited: ReadonlySet<string>,
    entered: ReadonlySet<string>,
    left: ReadonlySet<string>
): DeltaKind => {
    const key = foldPathCase(path);
    if (entered.has(key)) return 'fileEntered';
    if (left.has(key)) return 'fileLeft';
    if (edited.has(key)) return 'edited';
    return 'appeared';
};

/**
 * Build one difference entry.
 *
 * @param finding the finding group the difference is about.
 * @param lines the lines the difference covers.
 * @param kind how the difference is attributed.
 * @returns the entry.
 */
const deltaOf = (finding: BaselineFinding, lines: readonly number[], kind: DeltaKind): FindingDelta => ({
    kind,
    path: finding.path,
    ruleId: finding.ruleId,
    severity: finding.severity,
    lines,
    count: lines.length,
    message: finding.message,
});

/**
 * A snapshot's files by folded path.
 *
 * @param snapshot the snapshot.
 * @returns the map from folded path to the stored stamp.
 */
const stampMap = (snapshot: PostUpdateSnapshot): Map<string, readonly [string, number, number]> => {
    const map = new Map<string, readonly [string, number, number]>();
    for (const [path, size, mtimeMs] of snapshot.stamps) map.set(foldPathCase(path), [path, size, mtimeMs]);
    return map;
};

/**
 * Whether two stamps describe the same file content as far as the editor can tell.
 *
 * @param a the stamp from the first snapshot.
 * @param b the stamp from the second.
 * @returns true when size and modification time both match.
 */
const sameStamp = (
    a: readonly [string, number, number] | undefined,
    b: readonly [string, number, number] | undefined
): boolean => a !== undefined && b !== undefined && a[1] === b[1] && a[2] === b[2];

/**
 * A snapshot's finding groups by key.
 *
 * @param snapshot the snapshot.
 * @returns the map from finding key to group.
 */
const findingMap = (snapshot: PostUpdateSnapshot): Map<string, BaselineFinding> => {
    const map = new Map<string, BaselineFinding>();
    for (const finding of snapshot.findings) map.set(findingKey(finding.path, finding.ruleId, finding.severity), finding);
    return map;
};

/**
 * Everything besides the game tree that moved between the two generations.
 *
 * @param previous the generation from before the update.
 * @param current the generation from after it.
 * @param diff the attributed differences.
 * @returns the warnings, in report order.
 */
const attributionWarnings = (
    previous: PostUpdateSnapshot,
    current: PostUpdateSnapshot,
    diff: PostUpdateDiff
): AttributionWarning[] => {
    const warnings: AttributionWarning[] = [];
    if (previous.serverBuildId !== current.serverBuildId) warnings.push('serverBuild');
    if (previous.settingsHash !== current.settingsHash) warnings.push('settings');
    if (previous.environment.workshop !== current.environment.workshop) warnings.push('workshop');
    if (previous.environment.codeMods !== current.environment.codeMods) warnings.push('codeMods');
    if (!previous.gameVersion || !current.gameVersion) warnings.push('unknownVersion');
    if (diff.deltas.some((delta) => delta.ruleId === 'unnamed-check')) warnings.push('untagged');
    return warnings;
};

/**
 * What the installed game would do with every manifest the open folders hold.
 *
 * The manifests of a mod root are read, and when a folder holds none its immediate subfolders are
 * read instead, which is the layout of a workspace opened one level above the mod.
 *
 * @param folderPaths the open workspace folders.
 * @param info the installed game's version facts.
 * @returns one verdict per manifest, in path order.
 */
const manifestVerdicts = async (
    folderPaths: readonly string[],
    info: GameVersionInfo
): Promise<ManifestVerdict[]> => {
    const verdicts: ManifestVerdict[] = [];
    for (const folder of folderPaths) {
        for (const path of manifestRootsOf(folder)) {
            const manifest = await readManifest(path);
            if (!manifest) continue;
            const declared = declaredCompatibleVersions(manifest);
            verdicts.push({
                path: workspaceRelativePath(path, folderPaths),
                modId: scalarMember(manifest, 'ID'),
                declared,
                verdict: modVersionVerdict(declared, info),
            });
        }
    }
    return verdicts.sort((a, b) => compareText(a.path, b.path));
};

/**
 * Every manifest one open folder holds, looking one level down when the folder itself holds none.
 *
 * @param folder the open workspace folder.
 * @returns the manifest paths.
 */
const manifestRootsOf = (folder: string): string[] => {
    const own = manifestPathsIn(folder);
    if (own.length > 0) return own;
    const found: string[] = [];
    for (const entry of safeReaddir(folder)) {
        if (entry.startsWith('.')) continue;
        found.push(...manifestPathsIn(join(folder, entry)));
    }
    return found;
};

/**
 * The newest game version the hand-written deprecation registry knows about.
 *
 * The registry is the whole of what the migration can rewrite, and it only holds what somebody
 * entered by hand, so the report states where it stops instead of letting a quiet migration read as
 * "nothing to migrate". Versions are ordered by their numeric parts and then by the letter suffix a
 * hotfix carries, which is enough for the release names Cosmoteer uses.
 *
 * @returns the newest version in the registry, or an empty string when it holds none.
 */
export const newestRegistryVersion = (): string => {
    let newest = '';
    for (const symbol of allDeprecationSymbols()) {
        const version = deprecationBySymbol(symbol)?.version ?? '';
        if (version && (!newest || versionSortKey(version) > versionSortKey(newest))) newest = version;
    }
    return newest;
};

/**
 * A sortable key for a version name of the `0.30.4c` shape.
 *
 * @param version the version name.
 * @returns a string that sorts the way the releases came out.
 */
const versionSortKey = (version: string): string =>
    version
        .split('.')
        .map((part) => {
            const digits = part.match(/^\d+/)?.[0] ?? '0';
            return digits.padStart(4, '0') + part.slice(digits.length).padEnd(2, ' ');
        })
        .join('.');

/**
 * Compare two strings by code point, so report order never depends on the machine's locale.
 *
 * @param a the first string.
 * @param b the second string.
 * @returns a negative number, zero or a positive number, as a sort comparator wants.
 */
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
