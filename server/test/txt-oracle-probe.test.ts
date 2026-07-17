import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { CancellationToken, Connection, WorkDoneProgressReporter } from 'vscode-languageserver';
import { collectReferencedTxtKeys } from '../src/features/navigation/txt-reference-scan';
import { foldPathCase } from '../src/workspace/fs-cache';
import { globalSettings } from '../src/settings';
import { CosmoteerWorkspaceService } from '../src/workspace/cosmoteer-workspace.service';

// Corpus cross-check of the `.txt` reference scan against an independently derived ground truth:
// every `<…*.txt>` a mod file writes, resolved against that file's own directory and kept when it
// names a file that exists. Guards the property the gate rests on, that no `.txt` some rules text
// references is ever suppressed. Self-skipped unless TXT_PROBE_OUT is set, so it never runs in CI.
// Usage: TXT_PROBE_OUT=<report.json> npx vitest run test/txt-oracle-probe.test.ts
const DATA_DIR = process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const CORPUS = process.env.TXT_PROBE_CORPUS ?? 'C:/Program Files (x86)/Steam/steamapps/workshop/content/799600';
const OUT_FILE = process.env.TXT_PROBE_OUT ?? '';
const HAVE = existsSync(DATA_DIR) && existsSync(CORPUS) && !!OUT_FILE;
const token = CancellationToken.None;

const filesUnder = (root: string, pred: (name: string) => boolean): string[] => {
    const out: string[] = [];
    const walk = (dir: string): void => {
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const p = join(dir, entry.name);
            if (entry.isDirectory()) walk(p);
            else if (pred(entry.name)) out.push(p);
        }
    };
    walk(root);
    return out;
};

const isTxt = (n: string): boolean => n.toLowerCase().endsWith('.txt');
const isRulesOrTxt = (n: string): boolean => /\.(rules|txt)$/i.test(n);

describe.skipIf(!HAVE)('txt reference oracle probe', () => {
    it('keeps every referenced .txt and drops the unreferenced ones', async () => {
        globalSettings.cosmoteerPath = DATA_DIR;
        const noop: WorkDoneProgressReporter = { begin: () => undefined, report: () => undefined, done: () => undefined };
        const svc = CosmoteerWorkspaceService.instance;
        svc.setConnection({
            languages: { diagnostics: { refresh: () => undefined } },
            window: { showWarningMessage: () => undefined },
        } as unknown as Connection);
        await svc.initialize(DATA_DIR, noop);

        const report: Array<{ mod: string; file: string; grepReferenced: boolean; oracleKeeps: boolean }> = [];
        const mods = readdirSync(CORPUS, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => join(CORPUS, e.name))
            .filter((dir) => filesUnder(dir, isTxt).length > 0);

        // One mod plus the game tree, the shape of a real workspace.
        for (const mod of mods) {
            const keys = await collectReferencedTxtKeys([DATA_DIR, mod], token);
            // Ground truth, resolved independently of the oracle: every `<…*.txt>` a mod file writes,
            // resolved against that file's own directory (the form every ref in this corpus uses) and
            // kept only when it names a file that exists. Path-aware on purpose, since two mod folders
            // hold same-named `.txt` files and a basename match cannot tell them apart.
            const referencedPaths = new Set<string>();
            for (const source of filesUnder(mod, isRulesOrTxt)) {
                let text: string;
                try {
                    text = readFileSync(source, 'utf8');
                } catch {
                    continue;
                }
                for (const m of text.matchAll(/<([^<>\n]*\.txt)>/gi)) {
                    const target = join(dirname(source), m[1].trim().replace(/\\/g, '/'));
                    if (existsSync(target)) referencedPaths.add(foldPathCase(target));
                }
            }
            for (const txt of filesUnder(mod, isTxt)) {
                report.push({
                    mod: mod.split(/[\\/]/).pop() ?? '',
                    file: txt,
                    grepReferenced: referencedPaths.has(foldPathCase(txt)),
                    oracleKeeps: !!keys?.has(foldPathCase(txt)),
                });
            }
        }

        const vanillaKeys = await collectReferencedTxtKeys([DATA_DIR], token);
        for (const txt of filesUnder(DATA_DIR, isTxt)) {
            report.push({
                mod: '<vanilla>',
                file: txt,
                grepReferenced: false,
                oracleKeeps: !!vanillaKeys?.has(foldPathCase(txt)),
            });
        }

        const falseSuppress = report.filter((r) => r.grepReferenced && !r.oracleKeeps);
        const summary = {
            totalTxt: report.length,
            grepReferenced: report.filter((r) => r.grepReferenced).length,
            oracleKeeps: report.filter((r) => r.oracleKeeps).length,
            suppressed: report.filter((r) => !r.oracleKeeps).length,
            vanillaSuppressed: report.filter((r) => r.mod === '<vanilla>' && !r.oracleKeeps).map((r) => r.file),
            falseSuppressCount: falseSuppress.length,
            falseSuppress: falseSuppress.map((r) => r.file),
        };
        writeFileSync(OUT_FILE, JSON.stringify({ summary, report }, null, 2));
        console.log(JSON.stringify(summary, null, 2));
        expect(falseSuppress).toEqual([]);
    }, 1_800_000);
});
