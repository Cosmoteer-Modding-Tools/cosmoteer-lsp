import { readFile } from 'fs/promises';
import { CancellationToken } from 'vscode-languageserver';
import { parseText } from '../../../utils/ast.utils';
import { foldPathCase, onFsInvalidation } from '../../../workspace/fs-cache';
import { filePathToUri } from '../../navigation/navigation-strategy';
import { collectRulesFiles } from '../../navigation/workspace-files';
import { clearBaseFileCache } from './base-index';
import { Candidate, fileFactsFrom, FileFacts, MIN_FIELDS, plansFromCandidates } from './duplicate-field.analysis';
import { upgradePlansToExistingBase } from './existing-base';
import { BaseLocation, ExtractionPlan } from './plan.types';

/**
 * Judged containers per file, the directory listings the walk is built from, and the merged
 * candidate set per mod. All three are keyed by path alone and dropped together whenever the
 * filesystem caches are invalidated, which is what a watcher event does. Re-checking size and mtime
 * per lookup was measured at roughly a hundred thousand extra stat calls over one whole-mod scan,
 * because a file is looked up once for every other file it is compared against.
 */
const candidateCache = new Map<string, FileFacts>();
const listingCache = new Map<string, string[]>();
const scopeCandidateCache = new Map<string, ModFacts>();
const modPlanCache = new Map<string, ExtractionPlan[]>();

/** What a whole mod contributes to the analysis, merged from its files. */
export interface ModFacts {
    /** Every container of the mod that could take part in an extraction. */
    candidates: Candidate[];
    /** How many containers of the mod inherit each base, keyed by the base's identity. */
    inheritorCounts: Map<string, number>;
    /** Which files hold those containers, so the ones outside a plan can be re-read and judged. */
    inheritorFiles: Map<string, Set<string>>;
    /** Where each of those bases lives, keyed by the same identity. */
    locations: Map<string, BaseLocation>;
}

/**
 * The mod-wide walks currently running, keyed like their caches.
 *
 * A whole-workspace scan validates many files at once and every one of them wants the same mod-wide
 * set, so memoizing only the finished result makes each of them start its own walk. Sharing the
 * running promise is what turns that back into one walk: it was measured at eighty seconds of extra
 * work over one cold scan of a four thousand file mod.
 */
const candidatesInFlight = new Map<string, Promise<ModFacts>>();
const plansInFlight = new Map<string, Promise<ExtractionPlan[]>>();

/** The answer a cancelled or empty mod walk gives, so callers never see a partial set. */
const EMPTY_MOD_FACTS: ModFacts = {
    candidates: [],
    inheritorCounts: new Map(),
    inheritorFiles: new Map(),
    locations: new Map(),
};

/** The caches hold derived strings only, never an AST, so this bound is about entries and not memory. */
const MAX_CACHE_ENTRIES = 8000;

/** Bumped whenever the caches are dropped, so a walk that started before it does not write back. */
let epoch = 0;

const clearAll = (): void => {
    epoch++;
    clearBaseFileCache();
    candidateCache.clear();
    listingCache.clear();
    scopeCandidateCache.clear();
    modPlanCache.clear();
    candidatesInFlight.clear();
    plansInFlight.clear();
};

onFsInvalidation(clearAll);

/** Drop every memoized file, so a test or a settings change starts from a clean slate. */
export const clearSharedBaseScanCache = (): void => clearAll();

/**
 * Everything one file on disk contributes to the analysis, read in a single pass and memoized for as
 * long as the filesystem caches stand. Reading and judging a file is the whole cost of the pass, so
 * the memo is what makes the hint affordable during a whole-workspace scan.
 *
 * @param fsPath the file to read.
 * @param anchorDir the directory fingerprints are expressed relative to.
 * @param cancellationToken cancels between the reads.
 * @returns the file's candidates and the bases it inherits, empty when it cannot be read or parsed.
 */
export const fileFactsForPath = async (
    fsPath: string,
    anchorDir: string,
    cancellationToken: CancellationToken
): Promise<FileFacts> => {
    const empty: FileFacts = { candidates: [], baseIdentities: [], baseLocations: new Map() };
    if (cancellationToken.isCancellationRequested) return empty;
    const key = `${foldPathCase(fsPath)}|${foldPathCase(anchorDir)}`;
    const cached = candidateCache.get(key);
    if (cached) return cached;
    let facts: FileFacts;
    try {
        const text = await readFile(fsPath, { encoding: 'utf-8' });
        const document = parseText(text, fsPath);
        facts = fileFactsFrom({ document, text, fsPath, uri: filePathToUri(fsPath) }, anchorDir, MIN_FIELDS);
    } catch {
        // A file that cannot be read or parsed simply takes part in nothing, and the empty result is
        // memoized with the rest so it is not retried once per sibling.
        facts = empty;
    }
    if (candidateCache.size >= MAX_CACHE_ENTRIES) candidateCache.clear();
    candidateCache.set(key, facts);
    return facts;
};

/**
 * The containers of one file that could take part in an extraction.
 *
 * @param fsPath the file to read.
 * @param anchorDir the directory fingerprints are expressed relative to.
 * @param cancellationToken cancels between the reads.
 * @returns the file's candidate containers, empty when it cannot be read or parsed.
 */
export const candidatesForPath = async (
    fsPath: string,
    anchorDir: string,
    cancellationToken: CancellationToken
): Promise<Candidate[]> => (await fileFactsForPath(fsPath, anchorDir, cancellationToken)).candidates;

/**
 * Every `.rules` file under a directory, sorted so the analysis is reproducible, memoized because a
 * whole-workspace scan asks for the same mod root once per file it holds.
 *
 * @param dir the directory to walk.
 * @param cancellationToken cancels the walk.
 * @returns the paths, ascending.
 */
export const rulesFilesUnder = async (dir: string, cancellationToken: CancellationToken): Promise<string[]> => {
    const key = foldPathCase(dir);
    const cached = listingCache.get(key);
    if (cached) return cached;
    const files: string[] = [];
    for await (const file of collectRulesFiles(dir)) {
        if (cancellationToken.isCancellationRequested) return files.sort();
        files.push(file);
    }
    files.sort();
    if (listingCache.size >= MAX_CACHE_ENTRIES) listingCache.clear();
    listingCache.set(key, files);
    return files;
};

/**
 * The candidate containers of every file in a mod, memoized as one set.
 *
 * The comparison is mod-wide rather than directory-wide on purpose. Measured over 44 installed
 * workshop mods, a directory-scoped comparison reaches 23% of the extractions and only 8% of the
 * duplicated source: real mods put a family of near-identical files across a tree of folders, not in
 * one. The set is built once per mod and reused by every file of it, so a whole-workspace scan pays
 * for one walk, and the memo dies with the filesystem caches like everything else here.
 *
 * @param modRoot the mod's root directory.
 * @param inScope tells whether a file is one the game actually loads.
 * @param cancellationToken cancels the walk and the reads.
 * @returns every candidate container of the mod, empty when the walk was cancelled.
 */
export const modFacts = (
    modRoot: string,
    inScope: ((fsPath: string) => boolean) | undefined,
    cancellationToken: CancellationToken
): Promise<ModFacts> => {
    const key = foldPathCase(modRoot);
    const cached = scopeCandidateCache.get(key);
    if (cached) return Promise.resolve(cached);
    const running = candidatesInFlight.get(key);
    if (running) return running;
    const startedAt = epoch;
    const walk = (async (): Promise<ModFacts> => {
        const files = await rulesFilesUnder(modRoot, cancellationToken);
        const merged: ModFacts = {
            candidates: [],
            inheritorCounts: new Map(),
            inheritorFiles: new Map(),
            locations: new Map(),
        };
        for (const path of files) {
            // A cancelled walk must not be memoized: a partial set would make the hint disagree with
            // itself for the rest of the session.
            if (cancellationToken.isCancellationRequested) return EMPTY_MOD_FACTS;
            if (inScope && !inScope(path)) continue;
            const facts = await fileFactsForPath(path, modRoot, cancellationToken);
            merged.candidates.push(...facts.candidates);
            for (const identity of facts.baseIdentities) {
                merged.inheritorCounts.set(identity, (merged.inheritorCounts.get(identity) ?? 0) + 1);
                const holders = merged.inheritorFiles.get(identity);
                if (holders) holders.add(path);
                else merged.inheritorFiles.set(identity, new Set([path]));
            }
            for (const [identity, location] of facts.baseLocations) {
                if (!merged.locations.has(identity)) merged.locations.set(identity, location);
            }
        }
        if (cancellationToken.isCancellationRequested || epoch !== startedAt) return merged;
        if (scopeCandidateCache.size >= MAX_CACHE_ENTRIES) scopeCandidateCache.clear();
        scopeCandidateCache.set(key, merged);
        return merged;
    })().finally(() => {
        if (candidatesInFlight.get(key) === walk) candidatesInFlight.delete(key);
    });
    candidatesInFlight.set(key, walk);
    return walk;
};

/**
 * Every extraction the mod allows, computed once for the whole mod.
 *
 * The plans do not depend on which file is being validated, only on what the mod's files say, so a
 * whole-workspace scan computes them a single time and each file only asks which of them it appears
 * in. Doing the grouping per file instead was measured at roughly fifty seconds of extra work over
 * one scan of a four thousand file mod, because every file re-bucketed every other file's members.
 *
 * @param modRoot the mod's root directory.
 * @param inScope tells whether a file is one the game actually loads.
 * @param cancellationToken cancels the walk and the reads.
 * @returns the mod's plans, largest saving first.
 */
export const modPlans = (
    modRoot: string,
    inScope: ((fsPath: string) => boolean) | undefined,
    cancellationToken: CancellationToken
): Promise<ExtractionPlan[]> => {
    const key = foldPathCase(modRoot);
    const cached = modPlanCache.get(key);
    if (cached) return Promise.resolve(cached);
    const running = plansInFlight.get(key);
    if (running) return running;
    const startedAt = epoch;
    const build = (async (): Promise<ExtractionPlan[]> => {
        const facts = await modFacts(modRoot, inScope, cancellationToken);
        if (facts.candidates.length === 0 || cancellationToken.isCancellationRequested) return [];
        // The retiering runs on the finished plans rather than during the grouping: it reads the base
        // files, and only the handful of bases a plan actually landed on are ever worth reading.
        const plans = await upgradePlansToExistingBase(
            plansFromCandidates(facts.candidates),
            modRoot,
            facts.inheritorCounts,
            facts.locations,
            facts.inheritorFiles
        );
        if (cancellationToken.isCancellationRequested || epoch !== startedAt) return plans;
        if (modPlanCache.size >= MAX_CACHE_ENTRIES) modPlanCache.clear();
        modPlanCache.set(key, plans);
        return plans;
    })().finally(() => {
        if (plansInFlight.get(key) === build) plansInFlight.delete(key);
    });
    plansInFlight.set(key, build);
    return build;
};
