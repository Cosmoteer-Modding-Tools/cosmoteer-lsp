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
import { SELF_KEYED_MAP_FIELDS } from '../../../src/document/schema/entity-schema';
import { ReverseIncludeIndex } from '../../../src/features/navigation/reverse-include.index';
import { SchemaIdIndex } from '../../../src/features/completion/schema-id.index';
import { ParserResultRegistrar } from '../../../src/registrar/parser-result-registrar';
import { isModRules } from '../../../src/document/document-kind';
import {
    idReferencesOf,
    isJudgeableReference,
    isValidatedIdClass,
    judgeIdReference,
    IdReferenceJudgment,
} from '../../../src/features/diagnostics/validator.schema-id-reference';

// Coverage audit behind the cross-file id validator: judges every `ID<X>` reference of every
// reference-target class across the whole vanilla install and every installed workshop mod, in the
// same per-mod production shape the false-positive scans use. The validator carries no class list
// at all (every gate is derived: registry scope, self-keyed shapes, file-declared coverage, the
// loose declaration probe and the leftover/dependency consults), so this audit is the honesty
// check for the derivation after a game update: every judged class must show zero unresolved
// vanilla references (the zero contract, extended to all classes at once), and the per-class
// report is the triage basis for any new gap a game update opens. Needs the install, self-skips
// without it or without AUDIT_OUT.
const DATA_DIR = process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const MODS_DIR = process.env.COSMOTEER_MODS_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/workshop/content/799600';
const OUT_FILE = process.env.AUDIT_OUT ?? '';
const HAVE = existsSync(DATA_DIR) && !!OUT_FILE;
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

interface ClassTally {
    refs: number;
    verdicts: Record<IdReferenceJudgment, number>;
    samples: string[];
}

describe.skipIf(!HAVE)('cross-file id class coverage audit', () => {
    it('judges every reference class over vanilla and the installed mods', async () => {
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

        const tallies = new Map<string, ClassTally>();
        const tally = (cls: string): ClassTally => {
            let t = tallies.get(cls);
            if (!t) {
                t = { refs: 0, verdicts: { 'resolved': 0, 'no-coverage': 0, 'label-field': 0, 'declared-loosely': 0, 'vanilla-leftover': 0, 'dependency-declared': 0, 'unresolved': 0 }, samples: [] };
                tallies.set(cls, t);
            }
            return t;
        };
        const auditTree = async (root: string, folders: string[], label: string): Promise<void> => {
            const idsByClass = new Map<string, Set<string>>();
            for (const ext of ['.rules', '.txt']) {
                for (const file of filesUnder(root, ext)) {
                    let doc;
                    try { doc = parseReal(file); } catch { continue; }
                    if (isModRules(doc.uri)) continue;
                    for (const reference of idReferencesOf(doc)) {
                        if (!isJudgeableReference(reference)) continue;
                        const t = tally(reference.targetClass);
                        t.refs++;
                        const verdict = await judgeIdReference(reference, folders, idsByClass, token);
                        t.verdicts[verdict]++;
                        if (verdict === 'unresolved' && t.samples.length < 8) {
                            t.samples.push(`${label} :: ${file.replace(/\\/g, '/').split('/').slice(-2).join('/')} :: '${reference.value}'`);
                        }
                    }
                }
            }
        };

        await auditTree(DATA_DIR, [DATA_DIR], 'vanilla');
        ParserResultRegistrar.instance.clear();

        let scannedMods = 0;
        const modDirs = existsSync(MODS_DIR)
            ? readdirSync(MODS_DIR).map((d) => join(MODS_DIR, d)).filter((p) => { try { return statSync(p).isDirectory(); } catch { return false; } })
            : [];
        for (const modDir of modDirs) {
            const modId = modDir.replace(/\\/g, '/').split('/').pop()!;
            // Per-mod isolation, the same production shape as the false-positive scans: a finding a
            // real mod workspace would not see must not steer promotion either.
            ReverseIncludeIndex.instance.reset();
            SchemaIdIndex.instance.reset();
            await ReverseIncludeIndex.instance.ensureBuilt([DATA_DIR, modDir], token);
            await auditTree(modDir, [DATA_DIR, modDir], modId);
            ParserResultRegistrar.instance.clear();
            console.log(`[audit] ${modId} done (${++scannedMods}/${modDirs.length})`);
        }
        ReverseIncludeIndex.instance.reset();
        SchemaIdIndex.instance.reset();
        aliasRootIndex.invalidate();

        // Key positions of self-keyed maps declare instances rather than reference them, so an
        // unknown key is a new declaration. SELF_KEYED_MAP_FIELDS drives the validator's structural
        // bar; the report labels them for readability.
        const selfKeyedTargets = new Set(SELF_KEYED_MAP_FIELDS.values());

        const rows = [...tallies.entries()].sort((a, b) => b[1].verdicts.unresolved - a[1].verdicts.unresolved || b[1].refs - a[1].refs);
        const lines: string[] = [];
        for (const [cls, t] of rows) {
            const v = t.verdicts;
            const status = selfKeyedTargets.has(cls)
                ? 'self-keyed (barred)'
                : !isValidatedIdClass(cls)
                  ? 'component-registry (barred)'
                  : v.resolved + v['declared-loosely'] + v['vanilla-leftover'] + v['dependency-declared'] + v.unresolved > 0
                    ? 'validated'
                    : 'no coverage';
            lines.push(
                `${cls} :: refs=${t.refs} resolved=${v.resolved} no-coverage=${v['no-coverage']} label=${v['label-field']} loose=${v['declared-loosely']} leftover=${v['vanilla-leftover']} dependency=${v['dependency-declared']} unresolved=${v.unresolved} :: ${status}`
            );
            for (const sample of t.samples) lines.push(`    ${sample}`);
        }
        writeFileSync(OUT_FILE, lines.join('\n'), 'utf8');

        // Every validated class must be free of unresolved vanilla references, the zero contract
        // extended mechanically to all classes at once. A game update that gives a validated class
        // vanilla findings fails here and earns the class an exclusion entry (or a harvest fix).
        for (const [cls, t] of tallies) {
            if (!isValidatedIdClass(cls)) continue;
            expect.soft(t.samples.filter((s) => s.startsWith('vanilla')), cls).toEqual([]);
        }
        expect(tallies.size).toBeGreaterThan(10);
    }, 3_000_000);
});
