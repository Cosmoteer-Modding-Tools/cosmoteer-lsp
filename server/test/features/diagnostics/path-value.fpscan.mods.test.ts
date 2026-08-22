import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { CancellationToken, Connection, WorkDoneProgressReporter } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { globalSettings } from '../../../src/settings';
import { CosmoteerWorkspaceService } from '../../../src/workspace/cosmoteer-workspace.service';
import { aliasRootIndex } from '../../../src/document/schema/alias-root';
import { ReverseIncludeIndex } from '../../../src/features/navigation/reverse-include.index';
import { ParserResultRegistrar } from '../../../src/registrar/parser-result-registrar';
import { validatePathValues } from '../../../src/features/diagnostics/validator.path-value';
import { buildActionRootingForScan, resetActionRootingForScan } from '../../scan-rooting-helper';

// Triage scan of the path-existence check over every installed workshop mod, one mod at a time in
// production shape (folder set = [Data, that mod], exactly what a mod workspace sees, with
// mod-action rooting built per mod in production order so action-wired fragments validate typed).
// A finding here is either a genuine mod bug, which is the feature, or a false positive, which has
// to be fixed before the check may run by default. The written report is for that triage, so this
// test only asserts the scan ran. Self-skips without the game or workshop tree. PATHSCAN_OUT names
// the report file.
const DATA_DIR = process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const MODS_DIR = process.env.COSMOTEER_MODS_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/workshop/content/799600';
const OUT_FILE = process.env.PATHSCAN_OUT ?? '';
const HAVE = existsSync(DATA_DIR) && existsSync(MODS_DIR) && !!OUT_FILE;
const token = CancellationToken.None;

const filesUnder = (root: string, ext: string): string[] => {
    const out: string[] = [];
    const walk = (dir: string): void => {
        let entries: string[];
        try {
            entries = readdirSync(dir);
        } catch {
            return;
        }
        for (const entry of entries) {
            const p = join(dir, entry);
            let s;
            try {
                s = statSync(p);
            } catch {
                continue;
            }
            if (s.isDirectory()) walk(p);
            else if (entry.endsWith(ext)) out.push(p);
        }
    };
    walk(root);
    return out;
};

describe.skipIf(!HAVE)('path values over installed workshop mods', () => {
    it('collects every finding per mod for false-positive triage', async () => {
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
        const svc = CosmoteerWorkspaceService.instance;
        svc.setConnection({
            languages: { diagnostics: { refresh: () => undefined } },
            window: { showWarningMessage: () => undefined },
        } as unknown as Connection);
        await svc.initialize(DATA_DIR, noop);
        aliasRootIndex.invalidate();
        await aliasRootIndex.build(parseReal(join(DATA_DIR, 'cosmoteer.rules')), resolveRef);

        const modDirs = readdirSync(MODS_DIR)
            .map((d) => join(MODS_DIR, d))
            .filter((p) => {
                try {
                    return statSync(p).isDirectory();
                } catch {
                    return false;
                }
            });

        const findings: string[] = [];
        let scannedMods = 0;
        try {
            for (const modDir of modDirs) {
                const folders = [DATA_DIR, modDir];
                // Per-mod isolation: each mod is judged against only itself plus the game tree, the
                // exact coverage a real mod workspace has.
                ReverseIncludeIndex.instance.reset();
                await ReverseIncludeIndex.instance.ensureBuilt(folders, token);
                await buildActionRootingForScan(folders, token);

                for (const file of filesUnder(modDir, '.rules')) {
                    const rel = file.replace(/\\/g, '/').split('/799600/')[1] ?? file;
                    let doc;
                    try {
                        doc = parseReal(file);
                    } catch {
                        continue;
                    }
                    for (const error of await validatePathValues(doc, token).catch(() => [])) {
                        findings.push(`${rel}:${error.node.position.line + 1} :: ${error.message}`);
                    }
                }
                scannedMods++;
                ParserResultRegistrar.instance.clear();
                writeFileSync(OUT_FILE, findings.join('\n'), 'utf8');
            }
        } finally {
            resetActionRootingForScan();
            ReverseIncludeIndex.instance.reset();
            aliasRootIndex.invalidate();
        }
        expect(scannedMods).toBe(modDirs.length);
    }, 3_000_000);
});
