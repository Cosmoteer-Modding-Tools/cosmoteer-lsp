import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { CancellationToken, Connection, WorkDoneProgressReporter } from 'vscode-languageserver';
import { lexer } from '../../../../src/core/lexer/lexer';
import { parser } from '../../../../src/core/parser/parser';
import { globalSettings } from '../../../../src/settings';
import { CosmoteerWorkspaceService } from '../../../../src/workspace/cosmoteer-workspace.service';
import { aliasRootIndex } from '../../../../src/document/schema/alias-root';
import {
    Candidate,
    fileFactsFrom,
    plansFromCandidates,
} from '../../../../src/features/refactor/shared-base/duplicate-field.analysis';
import {
    judgeExistingBase,
    upgradePlansToExistingBase,
} from '../../../../src/features/refactor/shared-base/existing-base';
import { BaseLocation, ExtractionPlan } from '../../../../src/features/refactor/shared-base/plan.types';

// How much duplication the extraction actually finds across many mods, and how much of it the
// per-file hint can reach on its own. The hint compares a directory, the command compares the whole
// mod, so a plan whose files are spread across the tree exists but is only ever offered by the
// command. This measures that split, plus how often a shared-base plan could instead move its fields
// into the base the files already inherit, which is the refactor a human would reach for first.
// Reports numbers for judgment, asserts only that the sweep ran. Self-skips without the corpus.
const DATA_DIR = process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const MODS_DIR = process.env.COSMOTEER_MODS_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/workshop/content/799600';
const OUT_FILE = process.env.SHAREDBASE_USEFUL_OUT ?? '';
const LIMIT = Number(process.env.SHAREDBASE_MODS ?? '60');
const HAVE = existsSync(DATA_DIR) && existsSync(MODS_DIR) && !!OUT_FILE;
const token = CancellationToken.None;

const rulesFilesUnder = (root: string): string[] => {
    const out: string[] = [];
    const walk = (dir: string): void => {
        let entries: string[];
        try {
            entries = readdirSync(dir);
        } catch {
            return;
        }
        for (const entry of entries) {
            const path = join(dir, entry);
            let stats;
            try {
                stats = statSync(path);
            } catch {
                continue;
            }
            if (stats.isDirectory()) walk(path);
            else if (entry.toLowerCase().endsWith('.rules')) out.push(path.replace(/\\/g, '/'));
        }
    };
    walk(root);
    return out.sort();
};

/** How many distinct directories a plan's files sit in. One means the per-file hint can find it. */
const directorySpread = (plan: ExtractionPlan): number =>
    new Set(plan.participants.map((participant) => dirname(participant.fsPath).toLowerCase())).size;

describe.skipIf(!HAVE)('shared base extraction across installed mods', () => {
    it('measures how much it finds, and how much the per-file hint can reach', async () => {
        const parseReal = (abs: string) => parser(lexer(readFileSync(abs, 'utf8')), pathToFileURL(abs).href).value;
        const resolveRef = async (fileRef: string, fromUri: string) => {
            const rel = fileRef.replace(/[<>]/g, '').trim();
            if (!rel) return undefined;
            const withExt = /\.[^/\\.]+$/.test(rel) ? rel : `${rel}.rules`;
            for (const abs of [
                join(dirname(fileURLToPath(fromUri)), withExt),
                join(DATA_DIR, withExt),
                join(dirname(DATA_DIR), withExt),
            ]) {
                if (existsSync(abs)) {
                    try {
                        return parseReal(abs);
                    } catch {
                        return undefined;
                    }
                }
            }
            return undefined;
        };
        globalSettings.cosmoteerPath = DATA_DIR;
        const noop: WorkDoneProgressReporter = { begin: () => undefined, report: () => undefined, done: () => undefined };
        const service = CosmoteerWorkspaceService.instance;
        service.setConnection({
            languages: { diagnostics: { refresh: () => undefined } },
            window: { showWarningMessage: () => undefined },
        } as unknown as Connection);
        await service.initialize(DATA_DIR, noop);
        aliasRootIndex.invalidate();
        await aliasRootIndex.build(parseReal(join(DATA_DIR, 'cosmoteer.rules')), resolveRef);

        const modDirs = readdirSync(MODS_DIR)
            .map((entry) => join(MODS_DIR, entry).replace(/\\/g, '/'))
            .filter((path) => {
                try {
                    return statSync(path).isDirectory();
                } catch {
                    return false;
                }
            })
            .slice(0, LIMIT);

        const rows: string[] = [];
        let modsWithPlans = 0;
        let totalPlans = 0;
        let totalSaved = 0;
        let singleDirectoryPlans = 0;
        let singleDirectorySaved = 0;
        let sharedBasePlans = 0;
        let sharedBaseAllInheritorsPlans = 0;
        const refusals = new Map<string, number>();

        for (const modDir of modDirs) {
            const files = rulesFilesUnder(modDir);
            if (files.length === 0) continue;
            const candidates: Candidate[] = [];
            // Every container that inherits each base, counted over the whole mod: a plan may only
            // move its fields onto a base file when it covers every one of them.
            const inheritorCounts = new Map<string, number>();
            const inheritorFiles = new Map<string, Set<string>>();
            const locations = new Map<string, BaseLocation>();
            for (const file of files) {
                let text: string;
                try {
                    text = readFileSync(file, 'utf8');
                } catch {
                    continue;
                }
                try {
                    const document = parser(lexer(text), file).value;
                    const facts = fileFactsFrom({ document, text, fsPath: file, uri: pathToFileURL(file).href }, modDir, 2);
                    candidates.push(...facts.candidates);
                    for (const identity of facts.baseIdentities) {
                        inheritorCounts.set(identity, (inheritorCounts.get(identity) ?? 0) + 1);
                        const holders = inheritorFiles.get(identity);
                        if (holders) holders.add(file);
                        else inheritorFiles.set(identity, new Set([file]));
                    }
                    for (const [identity, location] of facts.baseLocations) {
                        if (!locations.has(identity)) locations.set(identity, location);
                    }
                } catch {
                    continue;
                }
            }
            // Retiered exactly as the shipped analysis does, so the count below is the offer the
            // user really gets and not an estimate of it.
            const plans = await upgradePlansToExistingBase(
                plansFromCandidates(candidates),
                modDir,
                inheritorCounts,
                locations,
                inheritorFiles
            );
            if (plans.length === 0) continue;
            modsWithPlans++;

            let modSaved = 0;
            for (const plan of plans) {
                totalPlans++;
                modSaved += plan.savedBytes;
                totalSaved += plan.savedBytes;
                if (directorySpread(plan) === 1) {
                    singleDirectoryPlans++;
                    singleDirectorySaved += plan.savedBytes;
                }
                if (plan.tier === 'sharedBase') {
                    sharedBasePlans++;
                    // Why the fields have to go into a new file rather than onto the base, which is
                    // the number that says whether the offer is worth having at all.
                    const refusal = await judgeExistingBase(plan, modDir, inheritorCounts, locations, inheritorFiles);
                    const reason = typeof refusal === 'string' ? refusal : 'accepted';
                    refusals.set(reason, (refusals.get(reason) ?? 0) + 1);
                }
                if (plan.tier === 'existingBase') {
                    sharedBasePlans++;
                    sharedBaseAllInheritorsPlans++;
                }
            }
            rows.push(
                `${modDir.split('/').pop()} :: ${files.length} files :: ${plans.length} plans :: ${modSaved} bytes :: largest ${plans[0].fields.length}x${plans[0].participants.length}`
            );
        }

        const pct = (part: number, whole: number): string => (whole === 0 ? 'n/a' : `${Math.round((part / whole) * 100)}%`);
        const report = [
            `mods scanned: ${modDirs.length}, mods with at least one plan: ${modsWithPlans}`,
            `plans: ${totalPlans}, duplicated source they remove: ${totalSaved} bytes`,
            `plans whose files all sit in one directory (the per-file hint can find these): ${singleDirectoryPlans} (${pct(singleDirectoryPlans, totalPlans)} of plans, ${pct(singleDirectorySaved, totalSaved)} of bytes)`,
            `plans over files that already share a base: ${sharedBasePlans}, of which the fields can move into that base itself: ${sharedBaseAllInheritorsPlans} (${pct(sharedBaseAllInheritorsPlans, sharedBasePlans)})`,
            `why the rest cannot: ${[...refusals].map(([reason, count]) => `${reason} ${count}`).join(', ') || 'none'}`,
            '',
            ...rows,
        ].join('\n');
        writeFileSync(OUT_FILE, report, 'utf8');
        console.log(report.split('\n').slice(0, 4).join('\n'));
        expect(modDirs.length).toBeGreaterThan(0);
    }, 3_000_000);
});
