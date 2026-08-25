import { readFile } from 'fs/promises';
import { pathToFileURL } from 'url';
import { CancellationToken } from 'vscode-languageserver';
import { AbstractNode, AbstractNodeDocument, isAssignmentNode } from '../core/ast/ast';
import { LocalizationKeyIndex } from '../features/completion/localization-key.index';
import { validateDuplicateModIds } from '../features/diagnostics/validator.duplicate-id';
import { validateDuplicateFields } from '../features/diagnostics/validator.duplicate-fields';
import { validateIgnoredFields } from '../features/diagnostics/validator.ignored-field';
import { validatePartGeometry } from '../features/diagnostics/validator.part-geometry';
import { validateRedundantOverrides } from '../features/diagnostics/validator.redundant-override';
import { ValidationError } from '../features/diagnostics/validator';
import { uriToFsPath } from '../features/navigation/workspace-files';
import { parseText } from '../utils/ast.utils';
import { CosmoteerWorkspaceService } from '../workspace/cosmoteer-workspace.service';
import { foldPathCase } from '../workspace/fs-cache';
import { globalSettings } from '../settings';
import { ModConflict } from './mod-conflicts';
import { ModReachability, reachabilityKey } from './mod-reachability';
import * as l10n from '@vscode/l10n';

/**
 * The health rows of the mod overview: one row per check that can be answered about the whole mod
 * rather than about one open file.
 *
 * Every row is sourced from a pass that already ships, run over the files the manifest actually
 * reaches. Nothing here scores a mod. A row names what is worth opening and says plainly when there
 * is nothing to open, because a number would hide which of the checks it came from.
 *
 * The passes are the same ones the editor runs while a file is open, so a row can only repeat a
 * finding the author would meet anyway. What the report adds is the count across a whole mod, which
 * no single open file can show.
 */

/** A place worth opening first, with the line the finding sits on. */
export interface HealthPlace {
    /** The absolute file path. */
    readonly file: string;
    /** The one-based line of the finding. */
    readonly line: number;
}

/** One check's outcome, as the overview renders it into a table row. */
export interface HealthRow {
    /** The question the row answers, as the row's first cell. */
    readonly check: string;
    /** What the check found, worded as something to act on. */
    readonly finding: string;
    /** The files worth opening first, empty when the row names none. */
    readonly places: readonly HealthPlace[];
    /** True when the check ran and found nothing to act on. */
    readonly clear: boolean;
}

/** How many places one row links before the reader is left to the editor's own problem list. */
const HEALTH_PLACE_LIMIT = 3;

/** How many languages the coverage row names before the rest are counted in a tail. */
const LANGUAGE_LIMIT = 3;

/** What one pass found across the whole mod. */
interface PassResult {
    /** How many findings the pass produced. */
    count: number;
    /** The first places worth opening. */
    places: HealthPlace[];
}

/** The passes the file walk runs, in the order their rows are rendered. */
type PassName = 'duplicateIds' | 'partGeometry' | 'ignoredFields' | 'duplicateFields' | 'redundantOverrides';

/** Everything the file walk collected. */
type PassResults = Record<PassName, PassResult>;

/** One finding the workspace scan already produced, which is all a row needs to read back from it. */
export interface ScanFinding {
    /** The rule the finding came from, the same id the editor tags a diagnostic with. */
    readonly code: string;
    /** The one-based line the finding sits on. */
    readonly line: number;
}

/** The scan's findings per file, keyed by case-folded absolute path, as the scan keys them. */
export type ScanFindings = ReadonlyMap<string, readonly ScanFinding[]>;

/** The rule id each pass tags its findings with, which is how they are told apart in the scan. */
const PASS_RULES: Record<PassName, string> = {
    duplicateIds: 'validateDuplicateIds',
    partGeometry: 'validatePartGeometry',
    ignoredFields: 'validateIgnoredFields',
    duplicateFields: 'validateDuplicateFields',
    redundantOverrides: 'validateRedundantOverrides',
};

/**
 * The passes whose findings the scan is holding, which are the ones the author has switched on: a
 * pass that is off produced nothing to read back, and its absence from a file's findings says
 * nothing about whether that file has any.
 *
 * @param withGameIndex whether the game tree is indexed, which the duplicate-id pass needs.
 * @returns the passes a scanned file can answer without being read again.
 */
const scanServedPasses = (withGameIndex: boolean): Set<PassName> => {
    const diagnostics = globalSettings.diagnostics;
    const served = new Set<PassName>();
    if (withGameIndex && diagnostics?.validateDuplicateIds) served.add('duplicateIds');
    if (diagnostics?.validatePartGeometry) served.add('partGeometry');
    if (diagnostics?.validateIgnoredFields) served.add('ignoredFields');
    if (diagnostics?.validateDuplicateFields) served.add('duplicateFields');
    if (diagnostics?.validateRedundantOverrides) served.add('redundantOverrides');
    return served;
};

/**
 * Folds one file's already-computed findings into the pass results, the way {@link record} folds
 * freshly computed ones.
 *
 * @param results the results to grow.
 * @param file the absolute path of the file the findings came from.
 * @param findings that file's findings from the scan.
 * @param served the passes those findings can answer for.
 */
const recordScanned = (
    results: PassResults,
    file: string,
    findings: readonly ScanFinding[],
    served: Set<PassName>
): void => {
    for (const pass of served) {
        const rule = PASS_RULES[pass];
        const own = findings.filter((finding) => finding.code === rule);
        if (own.length === 0) continue;
        const result = results[pass];
        result.count += own.length;
        if (result.places.length < HEALTH_PLACE_LIMIT) result.places.push({ file, line: own[0].line });
    }
};

/** The counts of the manifest's own action table, which the overview already computed. */
export interface ActionTotals {
    /** How many actions the manifest declares. */
    readonly total: number;
    /** How many of them name a target that resolves to nothing. */
    readonly broken: number;
}

/** An empty result, so a pass that never fired still has a shape to report. */
const emptyResult = (): PassResult => ({ count: 0, places: [] });

/**
 * Folds one file's findings into a pass result. Only the first finding of a file becomes a place,
 * since three links into one file read as three findings where the author has one file to open.
 *
 * @param result the pass result to grow.
 * @param file the absolute path of the file the findings came from.
 * @param text that file's source text, which the line of a finding is counted in.
 * @param errors the findings that file produced.
 */
const record = (result: PassResult, file: string, text: string, errors: ValidationError[]): void => {
    result.count += errors.length;
    if (errors.length === 0 || result.places.length >= HEALTH_PLACE_LIMIT) return;
    result.places.push({ file, line: lineAt(text, offsetOf(errors[0])) });
};

/**
 * The byte offset a finding starts at, read the way the editor reads it: the finding's own span
 * first, then the node it is anchored on. An assignment carries no position of its own, so its
 * written name stands in for it, and only a finding with neither lands at the top of the file.
 *
 * @param error the finding.
 * @returns the offset to point at.
 */
const offsetOf = (error: ValidationError): number => {
    if (error.range) return error.range.start;
    const node: AbstractNode = error.node;
    if (node.position) return node.position.start;
    if (isAssignmentNode(node)) return node.left.position?.start ?? node.right?.position?.start ?? 0;
    return 0;
};

/**
 * The one-based line an offset sits on.
 *
 * @param text the file's source text.
 * @param offset the byte offset into it.
 * @returns the line number, counted from one.
 */
const lineAt = (text: string, offset: number): number => {
    let line = 1;
    for (let at = 0; at < offset && at < text.length; at++) if (text.charCodeAt(at) === 10) line++;
    return line;
};

/**
 * The `.rules` files the manifest reaches, which is the population every row is counted over. A
 * file the game never opens is already reported as unreachable, and counting its findings again
 * would send the author into content they are not shipping.
 *
 * @param reachability the computed reachability of the mod.
 * @returns the absolute paths of the reachable files.
 */
const reachedFilesOf = (reachability: ModReachability): string[] =>
    reachability.allRulesFiles.filter((file) => reachability.reachable.has(reachabilityKey(file)));

/**
 * Runs the per-file passes over the mod once, so every row is read off one walk rather than one
 * walk per row.
 *
 * A file the workspace scan has already checked is not read again. The scan validates every file of
 * the mod with the same passes and keeps what it found, so for those files the rows are counted off
 * findings rather than recomputed, and the report costs nothing on the mod's dominant term. What the
 * scan cannot answer is filled in file by file: a file it never reached, a file whose findings it
 * had to cut at the problem limit, and every pass the author has switched off, since a pass that did
 * not run left no findings to tell an empty file apart from an unchecked one.
 *
 * @param reachability the computed reachability of the mod.
 * @param folderPaths the project folders the cross-file passes search.
 * @param withGameIndex whether the game tree is indexed, which the duplicate-id pass needs.
 * @param token cancels the walk between files.
 * @param scanned the findings the workspace scan already holds, keyed by case-folded path.
 * @returns what each pass found.
 */
const runPasses = async (
    reachability: ModReachability,
    folderPaths: string[],
    withGameIndex: boolean,
    token: CancellationToken,
    scanned?: ScanFindings
): Promise<PassResults> => {
    const results: PassResults = {
        duplicateIds: emptyResult(),
        partGeometry: emptyResult(),
        ignoredFields: emptyResult(),
        duplicateFields: emptyResult(),
        redundantOverrides: emptyResult(),
    };
    const paths = folderPaths.map(uriToFsPath);
    const inScope = (fsPath: string): boolean => reachability.reachable.has(reachabilityKey(fsPath));
    const served = scanned ? scanServedPasses(withGameIndex) : new Set<PassName>();
    const needed = (Object.keys(PASS_RULES) as PassName[]).filter(
        (pass) => pass !== 'duplicateIds' || withGameIndex
    );
    // A file is only read back off the scan when the scan can answer for every row, since one pass
    // recomputed for a file costs the read and the parse the whole fast path exists to skip.
    const readBack = !!scanned && needed.every((pass) => served.has(pass));
    for (const file of reachedFilesOf(reachability)) {
        if (token.isCancellationRequested) return results;
        const findings = readBack ? scanned?.get(foldPathCase(file)) : undefined;
        if (findings) {
            recordScanned(results, file, findings, served);
            continue;
        }
        const text = await readFile(file, { encoding: 'utf-8' }).catch(() => null);
        if (text === null) continue;
        let document: AbstractNodeDocument;
        try {
            document = parseText(text, pathToFileURL(file).href);
        } catch {
            continue;
        }
        record(results.partGeometry, file, text, await validatePartGeometry(document, token).catch(() => []));
        record(results.ignoredFields, file, text, await validateIgnoredFields(document, token).catch(() => []));
        record(
            results.duplicateFields,
            file,
            text,
            await validateDuplicateFields(document, text, folderPaths, token, inScope).catch(() => [])
        );
        record(
            results.redundantOverrides,
            file,
            text,
            await validateRedundantOverrides(document, text, token).catch(() => [])
        );
        if (withGameIndex) {
            record(results.duplicateIds, file, text, await validateDuplicateModIds(document, paths, token).catch(() => []));
        }
    }
    return results;
};

/**
 * The row about the manifest's actions, read off the table the overview already rendered.
 *
 * @param actions how many actions there are and how many resolve to nothing.
 * @returns the row.
 */
const actionRow = (actions: ActionTotals): HealthRow => {
    if (actions.total === 0) {
        return {
            check: l10n.t('Action targets'),
            finding: l10n.t('The manifest declares no action, so the game loads nothing from this mod.'),
            places: [],
            clear: false,
        };
    }
    return {
        check: l10n.t('Action targets'),
        finding:
            actions.broken === 0
                ? l10n.t('Every action names a target the game finds.')
                : actions.broken === 1
                  ? l10n.t('One action names a target that resolves to nothing, so it does nothing in game.')
                  : l10n.t(
                        '{0} of the {1} actions name a target that resolves to nothing, so they do nothing in game.',
                        String(actions.broken),
                        String(actions.total)
                    ),
        places: [],
        clear: actions.broken === 0,
    };
};

/**
 * The row about which files the manifest reaches.
 *
 * @param reachability the computed reachability of the mod.
 * @returns the row.
 */
const reachabilityRow = (reachability: ModReachability): HealthRow => {
    const total = reachability.allRulesFiles.length;
    const reached = total - reachability.unreachable.length;
    return {
        check: l10n.t('Files the game loads'),
        finding:
            reachability.unreachable.length === 0
                ? l10n.t('The manifest reaches every `.rules` file in the mod.')
                : l10n.t(
                      'The manifest reaches {0} of the {1} `.rules` files. The game never opens the rest.',
                      String(reached),
                      String(total)
                  ),
        places: reachability.unreachable.slice(0, HEALTH_PLACE_LIMIT).map((file) => ({ file, line: 1 })),
        clear: reachability.unreachable.length === 0,
    };
};

/**
 * The row about the keys each language of the mod declares, which is the comparison the key
 * validator never makes: it only asks whether a key is declared in some strings file.
 *
 * @param reachability the computed reachability of the mod, for the real path of a strings file.
 * @param folderPaths the project folders the strings index is built from.
 * @param token cancellation for the index build.
 * @returns the row, or undefined when the mod ships fewer than two languages and there is nothing
 *          to compare.
 */
const languageRow = async (
    reachability: ModReachability,
    folderPaths: string[],
    token: CancellationToken
): Promise<HealthRow | undefined> => {
    const coverage = await LocalizationKeyIndex.instance
        .coverageUnder(reachability.modRoot, folderPaths, token)
        .catch(() => []);
    if (coverage.length < 2) return undefined;
    const [reference, ...rest] = coverage;
    const behind = rest
        .map((language) => ({
            language,
            missing: [...reference.keys].filter((key) => !language.keys.has(key)).length,
        }))
        .filter((entry) => entry.missing > 0);
    if (behind.length === 0) {
        return {
            check: l10n.t('Language coverage'),
            finding: l10n.t('Every language this mod ships declares the same keys.'),
            places: [],
            clear: true,
        };
    }
    const named = behind
        .slice(0, LANGUAGE_LIMIT)
        .map((entry) => `${entry.language.language} (${entry.missing})`);
    if (behind.length > LANGUAGE_LIMIT) {
        named.push(l10n.t('and {0} more languages', String(behind.length - LANGUAGE_LIMIT)));
    }
    const finding = l10n.t(
        '{0} declares {1} keys. Missing elsewhere, with the count each language is short: {2}.',
        reference.language,
        String(reference.keys.size),
        named.join(', ')
    );
    const byKey = new Map(reachedFilesOf(reachability).map((file) => [reachabilityKey(file), file]));
    const places = behind
        .slice(0, HEALTH_PLACE_LIMIT)
        .map((entry) => byKey.get(entry.language.source))
        .filter((file): file is string => file !== undefined)
        .map((file) => ({ file, line: 1 }));
    return { check: l10n.t('Language coverage'), finding, places, clear: false };
};

/**
 * One row of a pass that counts findings, worded so the count reads as work to do rather than as a
 * grade.
 *
 * @param check the row's first cell.
 * @param result what the pass found.
 * @param clearText what to say when the pass found nothing.
 * @param oneText what to say for a single finding.
 * @param manyText what to say for several, given the count.
 * @returns the row.
 */
const countedRow = (
    check: string,
    result: PassResult,
    clearText: string,
    oneText: string,
    manyText: (count: string) => string
): HealthRow => ({
    check,
    finding: result.count === 0 ? clearText : result.count === 1 ? oneText : manyText(String(result.count)),
    places: result.count === 0 ? [] : result.places,
    clear: result.count === 0,
});

/**
 * The row about the nodes another installed mod claims too, read off what the report already
 * computed for its own section rather than by asking a second time.
 *
 * @param conflicts the collisions, absent when the installed mods were not read.
 * @returns the row.
 */
const conflictRow = (conflicts: readonly ModConflict[] | undefined): HealthRow => {
    const found = conflicts ?? [];
    const mods = new Set(found.map((conflict) => conflict.modId));
    const lost = found.filter((conflict) => !conflict.ownsLastWord).length;
    const shared =
        found.length === 1
            ? mods.size === 1
                ? l10n.t('One node is written by another installed mod as well.')
                : l10n.t('One node is written by other installed mods as well.')
            : mods.size === 1
              ? l10n.t('{0} nodes are written by another installed mod as well.', String(found.length))
              : l10n.t(
                    '{0} nodes are written by {1} other installed mods as well.',
                    String(found.length),
                    String(mods.size)
                );
    const order =
        lost === 0
            ? l10n.t('The game applies this mod last on every one of them.')
            : lost === found.length
              ? l10n.t('The other mod is applied last, so this version is not the one in game.')
              : l10n.t(
                    'On {0} of them the other mod is applied last, so this version is not the one in game.',
                    String(lost)
                );
    return {
        check: l10n.t('Installed mods'),
        finding:
            found.length === 0 ? l10n.t('No mod on this machine writes a node this mod writes.') : `${shared} ${order}`,
        places: found.slice(0, HEALTH_PLACE_LIMIT).map((conflict) => ({ file: conflict.file, line: conflict.line })),
        clear: found.length === 0,
    };
};

/**
 * Every health row of one mod, in reading order.
 *
 * A row is left out entirely when the check could not run at all, which is the same thing the
 * overview's own sections do rather than render a placeholder. A check that ran and found nothing
 * keeps its row and says so in one clause.
 *
 * @param reachability the computed reachability of the mod.
 * @param actions how many manifest actions there are and how many resolve to nothing.
 * @param folderPaths the project folders the cross-file passes search.
 * @param token cancels the file walk and the index builds.
 * @param scanned the findings the workspace scan already holds, keyed by case-folded path. Absent
 *        where there is no scan to read back from, such as the command line.
 * @param conflicts the nodes an installed mod claims too, which the report computed for its own
 *        section. Absent where the installed mods were not read.
 * @returns the rows to render.
 */
export const modHealthRows = async (
    reachability: ModReachability,
    actions: ActionTotals,
    folderPaths: string[],
    token: CancellationToken,
    scanned?: ScanFindings,
    conflicts?: readonly ModConflict[]
): Promise<HealthRow[]> => {
    const withGameIndex = !!CosmoteerWorkspaceService.instance.dataRootPath;
    const passes = await runPasses(reachability, folderPaths, withGameIndex, token, scanned);
    const rows: HealthRow[] = [actionRow(actions), reachabilityRow(reachability)];
    // Two files of one mod registering the same id is only decidable against the game's own
    // collections, so without the indexed game tree the check has no answer and gets no row.
    if (withGameIndex) {
        rows.push(
            countedRow(
                l10n.t('Ids registered twice'),
                passes.duplicateIds,
                l10n.t('No id is registered by two files of this mod.'),
                l10n.t('One declaration registers an id another file of this mod registers too.'),
                (count) => l10n.t('{0} declarations register an id another file of this mod registers too.', count)
            )
        );
    }
    rows.push(
        countedRow(
            l10n.t('Part grid geometry'),
            passes.partGeometry,
            l10n.t('Every part-grid value sits inside the part that writes it.'),
            l10n.t('One part-grid value sits where the part that writes it cannot reach.'),
            (count) => l10n.t('{0} part-grid values sit where the part that writes them cannot reach.', count)
        )
    );
    const languages = await languageRow(reachability, folderPaths, token);
    if (languages) rows.push(languages);
    rows.push(
        countedRow(
            l10n.t('Fields the game never reads'),
            passes.ignoredFields,
            l10n.t('Every field these files write is one the game reads.'),
            l10n.t('One field is written that the game never reads.'),
            (count) => l10n.t('{0} fields are written that the game never reads.', count)
        ),
        countedRow(
            l10n.t('Repeated field sets'),
            passes.duplicateFields,
            l10n.t('No group repeats a field set another file of this mod writes.'),
            l10n.t(
                'One group repeats a field set other files write word for word, which the Cosmoteer: Extract Shared Base Files command turns into one shared base.'
            ),
            (count) =>
                l10n.t(
                    '{0} groups repeat a field set other files write word for word, which the Cosmoteer: Extract Shared Base Files command turns into one shared base.',
                    count
                )
        ),
        conflictRow(conflicts),
        countedRow(
            l10n.t('Overrides that change nothing'),
            passes.redundantOverrides,
            l10n.t('No field restates a value its group already inherits.'),
            l10n.t('One field restates a value its group already inherits.'),
            (count) => l10n.t('{0} fields restate a value their group already inherits.', count)
        )
    );
    return rows;
};
