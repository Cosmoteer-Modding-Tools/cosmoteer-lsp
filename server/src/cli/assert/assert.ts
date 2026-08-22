import { basename, relative } from 'path';
import type { LintFinding } from '../findings';
import type { GameDataStatus } from '../report/report';
import { reportPath } from '../uri';
import { ActionRecord, collectManifestActions, countActionEntries, findActionFragments } from './actions';
import { DocumentCache, offsetOf, ParsedFile, pathKey } from './documents';
import { judgeAction, JudgeContext } from './judge';
import { chooseManifest, ManifestCandidate, metadataFailures, readCandidates } from './manifest';
import {
    ActionVerdict,
    AssertCounts,
    AssertReport,
    Disclosure,
    ManifestAssertion,
    ManifestFailure,
    ModAssertion,
    MOD_ACTION_RULE_ID,
} from './model';
import { walkModFiles } from './walk';

// Putting the load check together. The scan the lint command already runs answers the one question
// a command line cannot answer on its own, which is whether an action's target is really in the
// game's data, and this module answers the rest: which manifest the game reads, which actions it
// runs, and which of them nothing here was able to judge.

/** The rule id the parse check tags its findings with. */
const PARSE_ERROR_RULE_ID = 'parse-error';

/** Everything the report is built from. */
export interface AssertInput {
    /** The mod folders the run covered, absolute. */
    folders: string[];
    gameData: GameDataStatus;
    /** Every finding the scan produced, before any filter. */
    findings: readonly LintFinding[];
    /** Every file the server published a result for, absolute. */
    checkedFiles: readonly string[];
    files: number;
    passes: number;
    elapsedMs: number;
}

/**
 * Build the load report for every folder the run covered.
 *
 * @param input the run's folders and everything the scan produced.
 * @returns the report, with one entry per folder.
 */
export const buildAssertReport = async (input: AssertInput): Promise<AssertReport> => {
    const checked = new Set(input.checkedFiles.map(pathKey));
    const mods: ModAssertion[] = [];
    for (const folder of input.folders) {
        mods.push(await assertMod(folder, input, checked));
    }
    return {
        folders: input.folders,
        gameData: input.gameData,
        mods,
        files: input.files,
        passes: input.passes,
        elapsedMs: input.elapsedMs,
        loadBlocking: mods.reduce((total, mod) => total + mod.loadBlocking, 0),
        unverifiable: mods.reduce((total, mod) => total + mod.disclosures.length, 0),
        complete: mods.every((mod) => mod.disclosures.length === 0),
    };
};

/**
 * Judge one mod folder.
 *
 * @param folder the mod folder, absolute.
 * @param input the run's inputs.
 * @param checked the files the scan published a result for, as comparable paths.
 * @returns the verdict on the mod.
 */
const assertMod = async (folder: string, input: AssertInput, checked: Set<string>): Promise<ModAssertion> => {
    const cache = new DocumentCache();
    const relative = (file: string): string => reportPath([folder], file);
    const context: JudgeContext = {
        modRoot: folder,
        dataRoot: input.gameData.dataRoot,
        checked: (file) => checked.has(pathKey(file)),
        relative,
    };
    const findingsByFile = groupFindings(input.findings, MOD_ACTION_RULE_ID);
    const parseErrorsByFile = groupFindings(input.findings, PARSE_ERROR_RULE_ID);

    const { rulesFiles, manifests: manifestFiles } = await walkModFiles(folder);
    const candidates = await readCandidates(manifestFiles, cache);
    const choice = chooseManifest(candidates);

    const failures: ManifestFailure[] = [];
    const disclosures: Disclosure[] = [];
    const assertions: ManifestAssertion[] = [];
    const included = new Set<string>();

    if (choice.selected.length === 0) {
        failures.push({
            subject: 'manifest',
            path: '.',
            line: 1,
            column: 1,
            detail:
                candidates.length === 0
                    ? 'There is no mod.rules or mod_*.rules under this folder, so the game does not see a mod here at all.'
                    : 'None of the manifests under this folder can be the one the game reads, so the game skips this mod in silence.',
        });
    }
    // The game globs a mod folder for manifests all the way down, so several of them under one
    // folder is a mod that ships variants. A folder holding a manifest in each of several
    // subfolders is far more likely to be somebody's whole mods folder, and answering that as one
    // mod would be confidently wrong.
    const collected = collectionSubfolders(folder, manifestFiles);
    if (collected.length > 1) {
        disclosures.push({
            reason: 'manifest-choice',
            path: '.',
            detail:
                `This folder holds a manifest in each of ${collected.length} subfolders (${collected.slice(0, 5).join(', ')}) and none of its own. ` +
                'The game reads one mod folder at a time, so if this is a folder of several mods rather than one mod, check each of them on its own.',
        });
    }
    if (choice.undecided) {
        const names = choice.selected.map((candidate) => relative(candidate.file)).join(', ');
        const fallback = choice.selected.find((candidate) => candidate.useThisFileIfNoVersionMatch);
        disclosures.push({
            reason: 'manifest-choice',
            path: relative(choice.selected[0].file),
            detail:
                `This mod ships several manifests (${names}) and the game picks one by the version it is running, ` +
                `which this run cannot know${fallback ? `, falling back to ${relative(fallback.file)} when no version matches` : ''}. ` +
                'Every one of them is checked below.',
        });
    }
    for (const { candidate, reason } of choice.rejected) {
        disclosures.push({
            reason: 'manifest-choice',
            path: relative(candidate.file),
            detail: `The game never reads this manifest, because ${reason}. Its actions are not checked.`,
        });
    }

    for (const candidate of choice.selected) {
        const judged = await assertManifest(candidate, {
            folder,
            cache,
            context,
            findingsByFile,
            parseErrorsByFile,
            disclosures,
            selectionNote: choice.undecided ? 'one of several manifests, chosen by the running game version' : undefined,
        });
        assertions.push(judged.assertion);
        for (const file of judged.includedFiles) included.add(pathKey(file));
    }

    // A file holding an `Actions` list that no manifest was seen to pull in. Counting its entries as
    // the mod's would blame a mod for a leftover the game never reads, and passing over the file in
    // silence would hide a list that really is included through a path this check could not follow.
    // So the file is named once, with how much is in it, and none of it is judged.
    const orphanActionFiles: { path: string; actions: number }[] = [];
    const fragments = await findActionFragments(rulesFiles, manifestFiles, cache);
    for (const fragment of fragments) {
        if (included.has(pathKey(fragment))) continue;
        const parsed = await cache.get(fragment);
        const entries = parsed ? countActionEntries(parsed) : 0;
        orphanActionFiles.push({ path: relative(fragment), actions: entries });
        disclosures.push({
            reason: 'unfollowed-include',
            path: relative(fragment),
            detail: `This file holds an Actions list of ${entries} entries and no manifest of this mod was seen to include it. The game runs none of it unless something pulls it in through a path this check could not follow, so none of it was judged.`,
        });
    }

    const unreadableFiles = cache.unreadable().map((entry) => ({ path: relative(entry.file), reason: entry.reason }));
    for (const entry of unreadableFiles) {
        disclosures.push({
            reason: 'file-not-checked',
            path: entry.path,
            detail: `This file could not be read here (${entry.reason}), so anything it holds was not judged.`,
        });
    }

    const counts = countActions(assertions.flatMap((assertion) => assertion.actions));
    const manifestFailures = assertions.reduce((total, assertion) => total + assertion.failures.length, 0);
    const loadBlocking = counts.failed + manifestFailures + failures.length;
    const selected = choice.selected[0];
    return {
        folder,
        name: selected?.name,
        id: selected?.id,
        manifests: assertions,
        failures,
        orphanActionFiles,
        unreadableFiles,
        disclosures,
        counts,
        loadBlocking,
        verdict: loadBlocking > 0 ? 'does-not-load' : disclosures.length === 0 ? 'loads' : 'unknown',
    };
};

/** What judging one manifest needs, and where its disclosures go. */
interface ManifestContext {
    folder: string;
    cache: DocumentCache;
    context: JudgeContext;
    findingsByFile: Map<string, LintFinding[]>;
    parseErrorsByFile: Map<string, LintFinding[]>;
    disclosures: Disclosure[];
    selectionNote?: string;
}

/**
 * Judge one manifest and everything it pulls in.
 *
 * @param candidate the manifest to judge.
 * @param scope the shared reader, judge and finding tables.
 * @returns the manifest's part of the report, with the files it includes.
 */
const assertManifest = async (
    candidate: ManifestCandidate,
    scope: ManifestContext
): Promise<{ assertion: ManifestAssertion; includedFiles: string[] }> => {
    const path = scope.context.relative(candidate.file);
    const collection = await collectManifestActions(candidate.parsed, scope.folder, scope.cache);
    const failures = metadataFailures(candidate, path);

    // The game parses the manifest and every file it reads its actions from before it applies
    // anything, so a file among them that does not parse costs the whole mod.
    for (const file of [candidate.file, ...collection.includedFiles]) {
        const errors = scope.parseErrorsByFile.get(pathKey(file)) ?? [];
        if (errors.length === 0) continue;
        failures.push({
            subject: 'file',
            path: scope.context.relative(file),
            line: errors[0].startLine,
            column: errors[0].startColumn,
            detail: `This file does not parse (${errors[0].message}). The game reads it while it reads the manifest, so it starts without this mod.`,
        });
    }

    for (const entry of collection.unfollowed) {
        scope.disclosures.push({
            reason: 'unfollowed-include',
            path: scope.context.relative(entry.file),
            detail: `The manifest pulls actions in through ${entry.reference}, and ${entry.reason}. Whatever that list holds was not judged.`,
        });
    }
    for (const entry of collection.referenceEntries) {
        scope.disclosures.push({
            reason: 'unfollowed-include',
            path: scope.context.relative(entry.file),
            detail: `An entry of the action list is written as the reference ${entry.reference}. The game runs whatever it points at as an action, and this check does not follow it.`,
        });
    }

    const actions: ActionVerdict[] = [];
    for (const record of collection.records) {
        const judged = judgeAction(record, await findingsInside(record, scope.findingsByFile, scope.cache), scope.context);
        actions.push(judged.verdict);
        scope.disclosures.push(...judged.disclosures);
    }

    return {
        assertion: {
            path,
            file: candidate.file,
            selected: true,
            selectionNote: scope.selectionNote,
            failures,
            actions,
        },
        includedFiles: collection.includedFiles,
    };
};

/**
 * The findings of one rule, grouped by the file they are in.
 *
 * @param findings every finding the scan produced.
 * @param ruleId the rule to keep.
 * @returns the findings of that rule, keyed by comparable file path.
 */
const groupFindings = (findings: readonly LintFinding[], ruleId: string): Map<string, LintFinding[]> => {
    const byFile = new Map<string, LintFinding[]>();
    for (const finding of findings) {
        if (finding.ruleId !== ruleId) continue;
        const key = pathKey(finding.file);
        const known = byFile.get(key);
        if (known) known.push(finding);
        else byFile.set(key, [finding]);
    }
    return byFile;
};

/**
 * The findings that fall inside one action entry. A finding is reported at a line and a column, and
 * the entry is a span of offsets, so the position is turned back into an offset against the same
 * text both sides read.
 *
 * @param record the action entry.
 * @param byFile the findings of the mod action rule, keyed by file.
 * @param cache the shared reader, for the line offsets of the file.
 * @returns the findings inside the entry, in report order.
 */
const findingsInside = async (
    record: ActionRecord,
    byFile: Map<string, LintFinding[]>,
    cache: DocumentCache
): Promise<LintFinding[]> => {
    const candidates = byFile.get(pathKey(record.file));
    if (!candidates || candidates.length === 0) return [];
    const parsed: ParsedFile | undefined = await cache.get(record.file);
    if (!parsed) return [];
    return candidates.filter((finding) => {
        const offset = offsetOf(parsed.lineStarts, finding.startLine, finding.startColumn);
        // A container's end offset is one past its closing brace, so the end is exclusive.
        return offset >= record.startOffset && offset < record.endOffset;
    });
};

/**
 * Count how the actions came out.
 *
 * @param actions every action verdict of the mod.
 * @returns the counts, which always add up to the number of actions.
 */
export const countActions = (actions: readonly ActionVerdict[]): AssertCounts => {
    const counts: AssertCounts = { actions: actions.length, ok: 0, failed: 0, unverifiable: 0 };
    for (const action of actions) counts[action.mark]++;
    return counts;
};

/**
 * The name a mod folder is called in the report when its manifest declares none.
 *
 * @param folder the mod folder.
 * @returns the folder's own name.
 */
export const folderName = (folder: string): string => basename(folder) || folder;

/**
 * The immediate subfolders that hold a manifest, when the folder itself holds none. That is the
 * shape of a folder of mods rather than of one mod.
 *
 * @param folder the folder the run was pointed at.
 * @param manifests every manifest found under it, absolute.
 * @returns the subfolder names, empty when the folder carries a manifest of its own.
 */
export const collectionSubfolders = (folder: string, manifests: readonly string[]): string[] => {
    const names = new Set<string>();
    for (const manifest of manifests) {
        const inside = relative(folder, manifest).replace(/\\/g, '/');
        const cut = inside.indexOf('/');
        if (cut < 0) return [];
        names.add(inside.slice(0, cut));
    }
    return [...names].sort();
};
