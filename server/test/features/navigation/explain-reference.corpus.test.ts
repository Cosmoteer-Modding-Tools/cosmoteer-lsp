import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { CancellationToken, Connection, WorkDoneProgressReporter } from 'vscode-languageserver';
import { ValueNode, isValueNode } from '../../../src/core/ast/ast';
import { traceReference } from '../../../src/features/navigation/explain-reference/reference-trace';
import { ValidationForValue } from '../../../src/features/diagnostics/validator.value';
import { isActionTargetValueNode } from '../../../src/mod/action';
import { normalizeTargetPath } from '../../../src/mod/action-target-resolver';
import { resolveWithModContext } from '../../../src/mod/mod-context';
import { isValidReference } from '../../../src/utils/reference.utils';
import { parseFilePath } from '../../../src/utils/ast.utils';
import { globalSettings } from '../../../src/settings';
import { CosmoteerWorkspaceService } from '../../../src/workspace/cosmoteer-workspace.service';
import { walkAst } from '../../helpers';

// The false-positive proof. A report that calls a working reference broken is worse than no report,
// so every reference of the game's own files is traced and checked against the diagnostic the server
// already publishes for it. The rule is two-way: the trace never says broken where the value
// validator says nothing, and never says resolved where the validator says the name is unknown.
// Needs the game install and self-skips without it. The workshop half is opt-in through
// COSMOTEER_MODS_DIR, since it walks several thousand files:
//   COSMOTEER_MODS_DIR=<steamapps/workshop/content/799600> npx vitest run test/features/navigation/explain-reference.corpus.test.ts
const DATA_DIR = process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const MODS_DIR = process.env.COSMOTEER_MODS_DIR ?? '';
const HAVE_DATA = existsSync(DATA_DIR);
const HAVE_MODS = HAVE_DATA && !!MODS_DIR && existsSync(MODS_DIR);
const token = CancellationToken.None;

// Explaining is on demand, so the budget is what somebody waiting for one answer would accept. The
// average is what the walk really costs, since the shared resolution is memoized and most of a scan
// runs warm; the worst is there to catch a path whose cost blows up rather than a cold disk read.
/** What one reference may cost on average over a whole tree. */
const BUDGET_AVERAGE_MS = 20;

/** What the single most expensive reference of a tree may cost. */
const BUDGET_WORST_MS = 5000;

/** Every `.rules` file under a folder. */
const rulesFiles = (dir: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) rulesFiles(path, out);
        else if (entry.name.toLowerCase().endsWith('.rules')) out.push(path);
    }
    return out;
};

/** What one scan found. */
interface ScanResult {
    references: number;
    /** One line per reference the trace and the diagnostics disagree about. */
    disagreements: string[];
    /** How many references of each verdict. */
    histogram: Map<string, number>;
    /** `~` rooted references that do and do not resolve against the declaring file's own root. */
    runtimeRooted: { resolved: number; unresolved: number };
    /** The slowest single reference, in milliseconds. */
    worstMs: number;
    /** What tracing every reference cost altogether, in milliseconds. */
    totalMs: number;
}

/**
 * Traces every reference of every file and compares each verdict with what the server would report.
 *
 * A mod action target is compared against the resolution the mod-action validator performs, since
 * the value validator deliberately leaves those alone.
 *
 * @param files the files to scan.
 * @returns the counts and every disagreement found.
 */
const scan = async (files: string[]): Promise<ScanResult> => {
    const result: ScanResult = {
        references: 0,
        disagreements: [],
        histogram: new Map(),
        runtimeRooted: { resolved: 0, unresolved: 0 },
        worstMs: 0,
        totalMs: 0,
    };
    for (const file of files) {
        const document = await parseFilePath(file).catch(() => null);
        if (!document) continue;
        for (const node of walkAst(document)) {
            if (!isValueNode(node) || node.valueType.type !== 'Reference') continue;
            const value = node as ValueNode;
            const text = String(value.valueType.value);
            // A one-character reference and a path the grammar rejects are reported by their own
            // messages, so there is no "name is not known" to agree with.
            if (text.length <= 1 || !isValidReference(text)) continue;
            result.references++;

            const started = Date.now();
            const trace = await traceReference(value, token);
            const cost = Date.now() - started;
            result.worstMs = Math.max(result.worstMs, cost);
            result.totalMs += cost;
            if (!trace) continue;
            result.histogram.set(trace.verdict, (result.histogram.get(trace.verdict) ?? 0) + 1);
            if (text.replace(/^&/, '').startsWith('~')) {
                if (trace.verdict === 'resolved') result.runtimeRooted.resolved++;
                else result.runtimeRooted.unresolved++;
            }

            const isTarget = isActionTargetValueNode(value);
            const resolvesForServer = isTarget
                ? !!(await resolveWithModContext(normalizeTargetPath(text), value, token).catch(() => null))
                : (await ValidationForValue.callback(value, token))?.message !== 'Reference name is not known';
            const traceResolves = trace.verdict === 'resolved' || trace.verdict === 'resolved-via-mod';
            // Saying broken where the server publishes nothing is a false accusation, and saying
            // resolved where it publishes a problem is a false reassurance. Either one is a bug.
            const accuses = !isTarget && trace.verdict === 'broken' && resolvesForServer;
            const reassures = !resolvesForServer && traceResolves;
            // An action target has no third answer to fall back on, so it has to match outright.
            const targetMismatch = isTarget && traceResolves !== resolvesForServer;
            if ((accuses || reassures || targetMismatch) && result.disagreements.length < 40) {
                result.disagreements.push(`${trace.verdict} vs server ${resolvesForServer} :: ${text} :: ${file}`);
            }
        }
    }
    return result;
};

describe.skipIf(!HAVE_DATA)('reference trace over the game files', () => {
    let vanilla: ScanResult;

    beforeAll(async () => {
        globalSettings.cosmoteerPath = DATA_DIR;
        globalSettings.ignorePaths = [];
        const noop: WorkDoneProgressReporter = { begin: () => undefined, report: () => undefined, done: () => undefined };
        const service = CosmoteerWorkspaceService.instance;
        service.setConnection({
            languages: { diagnostics: { refresh: () => undefined } },
            window: { showWarningMessage: () => undefined },
        } as unknown as Connection);
        await service.initialize(DATA_DIR, noop);
        vanilla = await scan(rulesFiles(DATA_DIR));
    }, 600000);

    it('reads every reference the game ships', () => {
        expect(vanilla.references).toBeGreaterThan(10000);
    });

    it('never contradicts the diagnostics the server already publishes', () => {
        expect(vanilla.disagreements).toEqual([]);
    });

    it('resolves every `~` rooted reference the game ships against the declaring file own root', () => {
        // The approximation `~` is answered with is exactly right for the whole of the game's own
        // data, which is why it is worth keeping. The mods are where it stops being right, and there
        // the refusal takes over.
        expect(vanilla.runtimeRooted.resolved).toBeGreaterThan(4000);
        expect(vanilla.runtimeRooted.unresolved).toBe(0);
    });

    it('explains any one of them inside the budget', () => {
        expect(vanilla.totalMs / vanilla.references).toBeLessThan(BUDGET_AVERAGE_MS);
        expect(vanilla.worstMs).toBeLessThan(BUDGET_WORST_MS);
    });

    it('gives up at once on a cancelled token, however deep the path', async () => {
        const cancelled: CancellationToken = {
            isCancellationRequested: true,
            onCancellationRequested: () => ({ dispose: () => undefined }),
        };
        const deepest = join(DATA_DIR, 'ships', 'terran', 'cannon_med', 'cannon_med.rules');
        const document = await parseFilePath(deepest);
        for (const node of walkAst(document)) {
            if (!isValueNode(node) || node.valueType.type !== 'Reference') continue;
            const trace = await traceReference(node as ValueNode, cancelled);
            expect(trace?.verdict).toBe('cancelled');
            break;
        }
    });
});

describe.skipIf(!HAVE_MODS)('reference trace over the installed workshop mods', () => {
    let mods: ScanResult;

    beforeAll(async () => {
        globalSettings.cosmoteerPath = DATA_DIR;
        globalSettings.ignorePaths = [];
        const noop: WorkDoneProgressReporter = { begin: () => undefined, report: () => undefined, done: () => undefined };
        const service = CosmoteerWorkspaceService.instance;
        service.setConnection({
            languages: { diagnostics: { refresh: () => undefined } },
            window: { showWarningMessage: () => undefined },
        } as unknown as Connection);
        await service.initialize(DATA_DIR, noop);
        mods = await scan(rulesFiles(MODS_DIR));
    }, 1800000);

    it('never contradicts the diagnostics the server already publishes', () => {
        expect(mods.disagreements).toEqual([]);
    });

    it('finds the mod-only resolutions rather than calling them broken', () => {
        // A global a mod inserts resolves only through the mod's own additions. Without that second
        // resolver thousands of working references would read as defects.
        expect(mods.histogram.get('resolved-via-mod') ?? 0).toBeGreaterThan(100);
    });

    it('refuses the `~` references that do not resolve against the declaring file own root', () => {
        // This is the population the refusal exists for: a library group inherited into a part
        // somewhere else reaches members this file has never heard of.
        expect(mods.runtimeRooted.unresolved).toBeGreaterThan(0);
    });
});
