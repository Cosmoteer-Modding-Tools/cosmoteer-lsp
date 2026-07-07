import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { CancellationToken, Connection, WorkDoneProgressReporter } from 'vscode-languageserver';
import { lexer } from '../src/core/lexer/lexer';
import { parser } from '../src/core/parser/parser';
import { Validator, ValidationError } from '../src/features/diagnostics/validator';
import { ValidationForIdentifier, ValidationForValue } from '../src/features/diagnostics/validator.value';
import { ValidationForFunctionCall } from '../src/features/diagnostics/validator.functioncall';
import { ValidationForAssignment } from '../src/features/diagnostics/validator.assignment';
import { ValidationForMath } from '../src/features/diagnostics/validator.math';
import {
    ValidationForDocumentDuplicates,
    ValidationForGroupDuplicates,
} from '../src/features/diagnostics/validator.duplicate-key';
import { validateInheritanceCycles } from '../src/features/diagnostics/validator.inheritance-cycle';
import { validateSchema } from '../src/features/diagnostics/validator.schema';
import { ReverseIncludeIndex } from '../src/features/navigation/reverse-include.index';
import { aliasRootIndex } from '../src/document/schema/alias-root';
import { globalSettings } from '../src/settings';
import { CosmoteerWorkspaceService } from '../src/workspace/cosmoteer-workspace.service';
import { isModRules } from '../src/document/document-kind';
import { ModRulesRegistrar } from '../src/mod/mod-rules.registrar';
import { ParserResultRegistrar } from '../src/registrar/parser-result-registrar';
import { validateModActions } from '../src/features/diagnostics/validator.mod-action';

// Manual full-pipeline scan of a local mod for false-positive triage, self-skipped unless both
// MOD_SCAN_DIR and MOD_SCAN_OUT are set (so it never runs in CI). Mirrors the default-on part of
// server.ts validateTextDocument: parser errors + Validator (value/functioncall/assignment/math/
// group-duplicates) + document duplicates + inheritance cycles + schema pass + mod.rules actions.
// Writes every finding with file/line/severity/message to the MOD_SCAN_OUT json for offline grouping.
// Usage: MOD_SCAN_DIR=<mod folder> MOD_SCAN_OUT=<report.json> npx vitest run test/mod-fullscan.test.ts
const DATA_DIR = process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const MOD_DIR = process.env.MOD_SCAN_DIR ?? '';
const OUT_FILE = process.env.MOD_SCAN_OUT ?? '';
const HAVE = existsSync(DATA_DIR) && !!MOD_DIR && existsSync(MOD_DIR) && !!OUT_FILE;
const token = CancellationToken.None;

const rulesFiles = (root: string): string[] => {
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

const lineOf = (text: string, offset: number): number => {
    let line = 1;
    for (let i = 0; i < offset && i < text.length; i++) if (text[i] === '\n') line++;
    return line;
};

describe.skipIf(!HAVE)('full validation scan over a local mod', () => {
    it('collects every diagnostic for triage', async () => {
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
        ReverseIncludeIndex.instance.reset();
        await ReverseIncludeIndex.instance.ensureBuilt([DATA_DIR, MOD_DIR], token);

        Validator.instance.registerValidation(ValidationForValue);
        Validator.instance.registerValidation(ValidationForIdentifier);
        Validator.instance.registerValidation(ValidationForFunctionCall);
        Validator.instance.registerValidation(ValidationForAssignment);
        Validator.instance.registerValidation(ValidationForMath);
        Validator.instance.registerValidation(ValidationForGroupDuplicates);

        // Register the mod manifest first so the effective-tree context exists for every file.
        const manifestPath = join(MOD_DIR, 'mod.rules');
        if (existsSync(manifestPath)) {
            try {
                ModRulesRegistrar.instance.registerManifest(parseReal(manifestPath));
            } catch {
                /* manifest parse issues surface in the per-file loop */
            }
        }

        type Finding = { file: string; line: number; severity: string; kind: string; message: string };
        const findings: Finding[] = [];
        const files = rulesFiles(MOD_DIR);
        let scanned = 0;
        try {
            for (const file of files) {
                const rel = relative(MOD_DIR, file).replace(/\\/g, '/');
                let text: string;
                try {
                    text = readFileSync(file, 'utf8');
                } catch {
                    continue;
                }
                const uri = pathToFileURL(file).href;
                let parserResult;
                try {
                    parserResult = parser(lexer(text), uri);
                } catch (e) {
                    findings.push({ file: rel, line: 0, severity: 'crash', kind: 'parser-crash', message: String(e) });
                    continue;
                }
                for (const err of parserResult.parserErrors) {
                    findings.push({
                        file: rel,
                        line: lineOf(text, err.token.start),
                        severity: 'error',
                        kind: 'parser',
                        message: err.message,
                    });
                }
                let validationErrors: ValidationError[] = [];
                try {
                    const promises: Promise<ValidationError[]>[] = [];
                    for (const node of parserResult.value.elements) {
                        promises.push(Validator.instance.validate(node, token));
                    }
                    validationErrors = (await Promise.all(promises).catch(() => [])).flat();
                    const documentDuplicate = await ValidationForDocumentDuplicates.callback(parserResult.value, token).catch(
                        () => undefined
                    );
                    if (documentDuplicate) validationErrors.push(documentDuplicate);
                    validationErrors = validationErrors.concat(
                        await validateInheritanceCycles(parserResult.value, token).catch(() => [])
                    );
                    validationErrors = validationErrors.concat(await validateSchema(parserResult.value, token).catch(() => []));
                    if (isModRules(uri)) {
                        ModRulesRegistrar.instance.registerManifest(parserResult.value);
                        validationErrors = validationErrors.concat(
                            await validateModActions(ModRulesRegistrar.instance.getActions(uri), token).catch(() => [])
                        );
                    }
                } catch (e) {
                    findings.push({ file: rel, line: 0, severity: 'crash', kind: 'validator-crash', message: String(e) });
                }
                for (const err of validationErrors) {
                    findings.push({
                        file: rel,
                        line: lineOf(text, err.node.position.start),
                        severity: err.severity ?? 'error',
                        kind: 'validation',
                        message: err.message,
                    });
                }
                scanned++;
                // Cross-file navigation registers every parsed doc in ParserResultRegistrar; over
                // 4600+ files that exhausts the heap, so drop the AST cache periodically.
                if (scanned % 100 === 0) ParserResultRegistrar.instance.clear();
                if (scanned % 500 === 0) console.log(`[swscan] ${scanned}/${files.length} files, ${findings.length} findings`);
            }
        } finally {
            ReverseIncludeIndex.instance.reset();
            aliasRootIndex.invalidate();
        }

        writeFileSync(OUT_FILE, JSON.stringify({ scanned, total: files.length, findings }, null, 1), 'utf8');
        const byMessage = new Map<string, number>();
        for (const f of findings) {
            const key = f.message.replace(/'[^']*'/g, "'…'").replace(/"[^"]*"/g, '"…"').slice(0, 120);
            byMessage.set(key, (byMessage.get(key) ?? 0) + 1);
        }
        console.log(`\n[swscan] ${scanned} files scanned, ${findings.length} findings`);
        console.log(
            [...byMessage.entries()]
                .sort((a, b) => b[1] - a[1])
                .map(([m, c]) => `  ${c.toString().padStart(5)}  ${m}`)
                .join('\n')
        );
        expect(scanned).toBeGreaterThan(0);
    }, 1_800_000);
});
