import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { collectManifestActions } from '../../src/cli/assert/actions';
import { DocumentCache } from '../../src/cli/assert/documents';
import { judgeAction, JudgeContext } from '../../src/cli/assert/judge';
import { AssertMark, UnverifiableReason } from '../../src/cli/assert/model';
import { readCandidates } from '../../src/cli/assert/manifest';
import { walkModFiles } from '../../src/cli/assert/walk';

// The sweep over every installed mod. It runs no language server, so it cannot say whether a target
// resolves, and that is not what it is for: it proves that the walk reads every real manifest, that
// the classifier answers every action it finds with exactly one verdict, and that nothing real ends
// up in the remainder. A reason the classifier does not know would otherwise be reported as an
// action that loads, which is the failure this whole command exists to avoid.
//
// Usage: ASSERT_CORPUS_DIR=<folder holding mod folders> [ASSERT_CORPUS_OUT=<report.json>]
//        npx vitest run test/cli/assert-corpus.test.ts
const CORPUS_DIR = process.env.ASSERT_CORPUS_DIR ?? '';
const OUT_FILE = process.env.ASSERT_CORPUS_OUT ?? '';
const DATA_DIR = process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const HAVE = !!CORPUS_DIR && existsSync(CORPUS_DIR) && existsSync(DATA_DIR);

/** What the sweep records about one mod. */
interface ModSummary {
    folder: string;
    manifests: number;
    actions: number;
    marks: Record<AssertMark, number>;
    reasons: Partial<Record<UnverifiableReason, number>>;
    failures: { path: string; line: number; verb: string; detail: string }[];
}

describe.skipIf(!HAVE)('every installed mod', () => {
    it('is walked, judged and accounted for with no remainder', async () => {
        const folders = readdirSync(CORPUS_DIR, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => join(CORPUS_DIR, entry.name));
        expect(folders.length).toBeGreaterThan(0);

        const summaries: ModSummary[] = [];
        for (const folder of folders) {
            const cache = new DocumentCache();
            const { manifests } = await walkModFiles(folder);
            if (manifests.length === 0) continue;
            const candidates = await readCandidates(manifests, cache);
            const context: JudgeContext = {
                modRoot: folder,
                dataRoot: DATA_DIR,
                // The sweep runs no scan, so every file counts as checked and the verdicts come
                // from the action itself rather than from a finding.
                checked: () => true,
                relative: (file) => file.slice(folder.length + 1).replace(/\\/g, '/'),
            };
            const summary: ModSummary = {
                folder,
                manifests: manifests.length,
                actions: 0,
                marks: { ok: 0, failed: 0, unverifiable: 0 },
                reasons: {},
                failures: [],
            };
            for (const candidate of candidates) {
                const { records } = await collectManifestActions(candidate.parsed, folder, cache);
                for (const record of records) {
                    const { verdict } = judgeAction(record, [], context);
                    summary.actions++;
                    summary.marks[verdict.mark]++;
                    expect(verdict.detail.length, `${verdict.path}:${verdict.line}`).toBeGreaterThan(0);
                    if (verdict.reason) summary.reasons[verdict.reason] = (summary.reasons[verdict.reason] ?? 0) + 1;
                    if (verdict.mark === 'failed') {
                        summary.failures.push({
                            path: verdict.path,
                            line: verdict.line,
                            verb: verdict.verb,
                            detail: verdict.detail,
                        });
                    }
                }
            }
            expect(summary.marks.ok + summary.marks.failed + summary.marks.unverifiable).toBe(summary.actions);
            summaries.push(summary);
        }

        expect(summaries.length).toBeGreaterThan(0);
        expect(summaries.reduce((total, summary) => total + summary.actions, 0)).toBeGreaterThan(0);
        // With no scan behind it, the only failure this sweep can reach is one it derives itself:
        // a verb the game does not know, or a field a verb cannot do without. Every action of an
        // installed mod that the player can start the game with has to pass both.
        for (const summary of summaries) {
            expect(summary.failures, summary.folder).toEqual([]);
        }
        if (OUT_FILE) writeFileSync(OUT_FILE, JSON.stringify(summaries, null, 2));
    }, 600_000);
});
