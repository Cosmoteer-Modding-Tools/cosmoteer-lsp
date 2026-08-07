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
import { validateIgnoredFields } from '../../../src/features/diagnostics/validator.ignored-field';
import { buildActionRootingForScan, resetActionRootingForScan } from '../../scan-rooting-helper';

// Triage scan of the ignored-field hint over every installed workshop mod, one mod at a time in
// production shape (folder set = [Data, that mod], with mod-action rooting built per mod in
// production order so action-wired fragments validate typed). Findings are bucketed by the written
// shape of the member they landed on, because the pass judges the assignment and the bare named list
// but never the bare named group. Mods are cruft-heavy, so a finding here is usually a genuine dead
// field rather than a false positive, which is why the report exists and this test only asserts the
// scan ran. Self-skips without the game or workshop tree. MODSCAN_FROM/TO select a chunk of mods,
// IGNORED_MODSCAN_OUT is the report file.
const DATA_DIR = process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const MODS_DIR = process.env.COSMOTEER_MODS_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/workshop/content/799600';
const OUT_FILE = process.env.IGNORED_MODSCAN_OUT ?? '';
const FROM = Number(process.env.MODSCAN_FROM ?? '0');
const TO = Number(process.env.MODSCAN_TO ?? '9999');
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
            const p = join(dir, entry);
            let s;
            try {
                s = statSync(p);
            } catch {
                continue;
            }
            if (s.isDirectory()) walk(p);
            else if (entry.endsWith('.rules')) out.push(p);
        }
    };
    walk(root);
    return out;
};

/**
 * The written shape of the member a finding landed on, read back from the source, deciding it by
 * what follows the reported name.
 *
 * @param text the file's source.
 * @param start the finding's start offset, which is the member's name.
 * @returns one of `assignment`, `bare-list`, `bare-group` or `other`.
 */
const shapeAt = (text: string, start: number): string => {
    const afterName = text.slice(start).replace(/^[^\s=[{]+/, '');
    const trimmed = afterName.replace(/^(\s|\/\/[^\n]*)+/, '');
    if (trimmed.startsWith('=')) return 'assignment';
    if (trimmed.startsWith('[')) return 'bare-list';
    if (trimmed.startsWith('{')) return 'bare-group';
    return 'other';
};

const lineOf = (text: string, offset: number): number => {
    let line = 1;
    for (let i = 0; i < offset && i < text.length; i++) if (text[i] === '\n') line++;
    return line;
};

describe.skipIf(!HAVE)('ignored-field hint over installed workshop mods', () => {
    it('collects every finding per mod, bucketed by member shape', async () => {
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
            })
            .slice(FROM, TO);

        const findings: string[] = [];
        const counts = new Map<string, number>();
        let scannedMods = 0;
        try {
            for (const modDir of modDirs) {
                const folders = [DATA_DIR, modDir];
                ReverseIncludeIndex.instance.reset();
                await ReverseIncludeIndex.instance.ensureBuilt(folders, token);
                await buildActionRootingForScan(folders, token);

                for (const file of rulesFilesUnder(modDir)) {
                    const rel = file.replace(/\\/g, '/').split('/799600/')[1] ?? file;
                    let text: string;
                    let doc;
                    try {
                        text = readFileSync(file, 'utf8');
                        doc = parseReal(file);
                    } catch {
                        continue;
                    }
                    for (const error of await validateIgnoredFields(doc, token).catch(() => [])) {
                        const start = error.range?.start ?? 0;
                        const shape = shapeAt(text, start);
                        counts.set(shape, (counts.get(shape) ?? 0) + 1);
                        findings.push(`${shape}\t${rel}:${lineOf(text, start)}\t${error.message}`);
                    }
                }
                scannedMods++;
                ParserResultRegistrar.instance.clear();
                const summary = [...counts.entries()].map(([k, v]) => `${k}=${v}`).join(' ');
                console.log(`[ignoredscan] ${scannedMods}/${modDirs.length} ${summary}`);
                writeFileSync(OUT_FILE, findings.slice().sort().join('\n'), 'utf8');
            }
        } finally {
            resetActionRootingForScan();
            ReverseIncludeIndex.instance.reset();
            aliasRootIndex.invalidate();
        }
        expect(scannedMods).toBe(modDirs.length);
    }, 3_000_000);
});
