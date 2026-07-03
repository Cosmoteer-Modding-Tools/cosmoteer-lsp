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
import { SchemaIdIndex } from '../../../src/features/completion/schema-id.index';
import { LocalizationKeyIndex } from '../../../src/features/completion/localization-key.index';
import { ParserResultRegistrar } from '../../../src/registrar/parser-result-registrar';
import { validateSchemaSiblingReferences } from '../../../src/features/diagnostics/validator.schema-sibling';
import { validateCrossFileIdReferences } from '../../../src/features/diagnostics/validator.schema-id-reference';
import { validateLocalizationKeys } from '../../../src/features/diagnostics/validator.localization-key';
import { validateShaderDocument } from '../../../src/features/shader/shader-diagnostics';

// Triage scan of the default-on cross-file/shader validators over every installed workshop mod, one
// mod at a time in production shape (folder set = [Data, that mod], exactly what a mod workspace sees).
// Findings here are either genuine mod bugs (fine, that is the feature) or our false positives (must
// be fixed before the validator may run by default). The written report is for that triage, so this
// test only asserts the scan ran. Self-skips without the game or workshop tree. MODSCAN_FROM/TO
// select a chunk of mods, MODSCAN_OUT is the report file.
const DATA_DIR = process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const MODS_DIR = process.env.COSMOTEER_MODS_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/workshop/content/799600';
const OUT_FILE = process.env.MODSCAN_OUT ?? '';
const FROM = Number(process.env.MODSCAN_FROM ?? '0');
const TO = Number(process.env.MODSCAN_TO ?? '9999');
const HAVE = existsSync(DATA_DIR) && existsSync(MODS_DIR) && !!OUT_FILE;
const token = CancellationToken.None;

const filesUnder = (root: string, ext: string): string[] => {
    const out: string[] = [];
    const walk = (dir: string): void => {
        let entries: string[];
        try { entries = readdirSync(dir); } catch { return; }
        for (const entry of entries) {
            const p = join(dir, entry);
            let s;
            try { s = statSync(p); } catch { continue; }
            if (s.isDirectory()) walk(p);
            else if (entry.endsWith(ext)) out.push(p);
        }
    };
    walk(root);
    return out;
};

describe.skipIf(!HAVE)('default-on validators over installed workshop mods', () => {
    it('collects every finding per mod for false-positive triage', async () => {
        const parseReal = (abs: string) => parser(lexer(readFileSync(abs, 'utf8')), pathToFileURL(abs).href).value;
        const resolveRef = async (fileRef: string, fromUri: string) => {
            const rel = fileRef.replace(/[<>]/g, '').trim();
            if (!rel) return undefined;
            const withExt = /\.[^/\\.]+$/.test(rel) ? rel : `${rel}.rules`;
            for (const abs of [join(dirname(fileURLToPath(fromUri)), withExt), join(DATA_DIR, withExt), join(dirname(DATA_DIR), withExt)]) {
                if (existsSync(abs)) { try { return parseReal(abs); } catch { return undefined; } }
            }
            return undefined;
        };
        globalSettings.cosmoteerPath = DATA_DIR;
        const noop: WorkDoneProgressReporter = { begin: () => undefined, report: () => undefined, done: () => undefined };
        const svc = CosmoteerWorkspaceService.instance;
        svc.setConnection({ languages: { diagnostics: { refresh: () => undefined } }, window: { showWarningMessage: () => undefined } } as unknown as Connection);
        await svc.initialize(DATA_DIR, noop);
        aliasRootIndex.invalidate();
        await aliasRootIndex.build(parseReal(join(DATA_DIR, 'cosmoteer.rules')), resolveRef);

        const modDirs = readdirSync(MODS_DIR)
            .map((d) => join(MODS_DIR, d))
            .filter((p) => { try { return statSync(p).isDirectory(); } catch { return false; } })
            .slice(FROM, TO);

        const findings: string[] = [];
        let scannedMods = 0;
        try {
            for (const modDir of modDirs) {
                const modId = modDir.replace(/\\/g, '/').split('/').pop();
                const folders = [DATA_DIR, modDir];
                // Per-mod isolation: each mod is judged against only itself plus the game tree, the
                // exact coverage a real mod workspace has (a dependency on another mod is invisible
                // there too, so any such finding must be triaged, not masked by a union index).
                ReverseIncludeIndex.instance.reset();
                SchemaIdIndex.instance.reset();
                LocalizationKeyIndex.instance.reset();
                await ReverseIncludeIndex.instance.ensureBuilt(folders, token);

                for (const file of filesUnder(modDir, '.rules')) {
                    const rel = file.replace(/\\/g, '/').split('/799600/')[1] ?? file;
                    let doc;
                    try { doc = parseReal(file); } catch { continue; }
                    const errors = [
                        ...(await validateSchemaSiblingReferences(doc, token).catch(() => [])).map((e) => `component :: ${e.message}`),
                        ...(await validateCrossFileIdReferences(doc, folders, token).catch(() => [])).map((e) => `crossfile :: ${e.message}`),
                        ...(await validateLocalizationKeys(doc, folders, token).catch(() => [])).map(
                            (e) => `lockey :: ${e.additionalInfo ?? e.message}`
                        ),
                    ];
                    for (const error of errors) findings.push(`${rel} :: ${error}`);
                }
                for (const file of filesUnder(modDir, '.shader')) {
                    const rel = file.replace(/\\/g, '/').split('/799600/')[1] ?? file;
                    const text = readFileSync(file, 'utf8');
                    const diagnostics = await validateShaderDocument(text, file, DATA_DIR).catch(() => []);
                    for (const d of diagnostics) findings.push(`${rel}:${d.range.start.line + 1} :: shader :: ${d.message}`);
                }
                scannedMods++;
                ParserResultRegistrar.instance.clear();
                console.log(`[modscan] ${modId} done (${scannedMods}/${modDirs.length}, ${findings.length} findings)`);
                writeFileSync(OUT_FILE, findings.join('\n'), 'utf8');
            }
        } finally {
            ReverseIncludeIndex.instance.reset();
            SchemaIdIndex.instance.reset();
            LocalizationKeyIndex.instance.reset();
            aliasRootIndex.invalidate();
        }
        expect(scannedMods).toBe(modDirs.length);
    }, 3_000_000);
});
