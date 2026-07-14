import { describe, expect, it, beforeAll } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { CancellationToken, Connection, WorkDoneProgressReporter } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { globalSettings } from '../../../src/settings';
import { CosmoteerWorkspaceService } from '../../../src/workspace/cosmoteer-workspace.service';
import { aliasRootIndex } from '../../../src/document/schema/alias-root';
import { ReverseIncludeIndex } from '../../../src/features/navigation/reverse-include.index';
import { ParserResultRegistrar } from '../../../src/registrar/parser-result-registrar';
import { validateSchemaSiblingReferences } from '../../../src/features/diagnostics/validator.schema-sibling';
import { validateCrossFileIdReferences } from '../../../src/features/diagnostics/validator.schema-id-reference';
import { validateLocalizationKeys } from '../../../src/features/diagnostics/validator.localization-key';
import { validateShaderDocument } from '../../../src/features/shader/shader-diagnostics';

// False-positive scan of the default-on cross-file/shader validators over the whole vanilla install.
// Everything the game ships loads fine in-game, so every finding here is a false positive by
// definition. Zero findings across all four passes is the contract that lets them run by default.
// Needs the install, self-skips without it.
const DATA_DIR =
    process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const HAVE_DATA = existsSync(DATA_DIR);
const token = CancellationToken.None;

const filesUnder = (root: string, ext: string): string[] => {
    const out: string[] = [];
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir)) {
            const p = join(dir, entry);
            if (statSync(p).isDirectory()) walk(p);
            else if (entry.endsWith(ext)) out.push(p);
        }
    };
    walk(root);
    return out;
};

const parseFile = (abs: string) => parser(lexer(readFileSync(abs, 'utf8')), pathToFileURL(abs).href).value;

// vitest run mode drops large console output, so each scan also writes its findings to a report file
// when FPSCAN_OUT_DIR names a directory for them.
const OUT_DIR = process.env.FPSCAN_OUT_DIR ?? '';
const report = (name: string, findings: string[]): void => {
    console.log(`\n[${name}] ${findings.length} findings\n` + findings.slice(0, 50).join('\n'));
    if (OUT_DIR) writeFileSync(join(OUT_DIR, `fpscan-${name}.txt`), findings.join('\n'), 'utf8');
};

describe.skipIf(!HAVE_DATA)('opt-in validators over vanilla Data', () => {
    beforeAll(async () => {
        globalSettings.cosmoteerPath = DATA_DIR;
        const noop: WorkDoneProgressReporter = { begin: () => undefined, report: () => undefined, done: () => undefined };
        const svc = CosmoteerWorkspaceService.instance;
        svc.setConnection({
            languages: { diagnostics: { refresh: () => undefined } },
            window: { showWarningMessage: () => undefined },
        } as unknown as Connection);
        await svc.initialize(DATA_DIR, noop);
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
                        return parseFile(abs);
                    } catch {
                        return undefined;
                    }
                }
            }
            return undefined;
        };
        aliasRootIndex.invalidate();
        await aliasRootIndex.build(parseFile(join(DATA_DIR, 'cosmoteer.rules')), resolveRef);
        ReverseIncludeIndex.instance.reset();
        await ReverseIncludeIndex.instance.ensureBuilt([DATA_DIR], token);
    }, 300_000);

    it('component sibling references: zero findings', async () => {
        const findings: string[] = [];
        let scanned = 0;
        for (const file of filesUnder(DATA_DIR, '.rules')) {
            let doc;
            try {
                doc = parseFile(file);
            } catch {
                continue;
            }
            for (const error of await validateSchemaSiblingReferences(doc, token)) {
                findings.push(`${relative(DATA_DIR, file)}: ${error.message}`);
            }
            if (++scanned % 200 === 0) ParserResultRegistrar.instance.clear();
        }
        report('component-refs', findings);
        expect(scanned).toBeGreaterThan(900);
        expect(findings.slice(0, 30)).toEqual([]);
    }, 600_000);

    it('cross-file id references: zero findings', async () => {
        const findings: string[] = [];
        let scanned = 0;
        for (const file of filesUnder(DATA_DIR, '.rules')) {
            let doc;
            try {
                doc = parseFile(file);
            } catch {
                continue;
            }
            for (const error of await validateCrossFileIdReferences(doc, [DATA_DIR], token)) {
                findings.push(`${relative(DATA_DIR, file)}: ${error.message}`);
            }
            if (++scanned % 200 === 0) ParserResultRegistrar.instance.clear();
        }
        report('cross-file-ids', findings);
        expect(findings.slice(0, 30)).toEqual([]);
        // The game-tree exemption replaces the old hand-kept stale-id list, so a harvest regression
        // could hide behind it: every unresolved vanilla reference would self-exempt instead of
        // failing the zero contract above. Pinning the exempted set to the known vanilla leftovers
        // keeps the tripwire: a new game version adds entries here consciously, a regression fails.
        // `trade` and `unique` are builtin-ship tags that vanilla also references through
        // spawner-typed search fields, a cross-class tag reuse the harvests cannot unify, so those
        // references self-exempt like the genuine leftovers.
        // `distress` and `indicators` are the two leftovers the self-keyed value references surfaced.
        // Vanilla's `encounter_distress.rules` names `Metatype = Distress`, and no metatype by that
        // name exists (the file's own comment calls the encounter broken); four vanilla parts draw on
        // `Layer = "indicators"`, and no ship file declares a render layer by that name.
        const { gameTreeExemptions, labelFieldExemptions } = await import(
            '../../../src/features/diagnostics/validator.schema-id-reference'
        );
        expect([...gameTreeExemptions].sort()).toEqual([
            'distress',
            'graveyard_platform',
            'indicators',
            'shrapnel',
            'station_captor_defense',
            'trade',
            'unique',
        ]);
        // The label-field derivation gets the same tripwire: a field only derives as a label when
        // no vanilla usage resolves to a primary id, so a harvest regression that breaks a real
        // field's resolution would silently reclassify it here instead of failing the zero contract.
        // `SelectionTypeID` and `FlipWhenLoadingIDs` borrow the part-id type without the engine ever
        // resolving them, `UpgradedFrom` names replaced legacy techs by design (the decompiled
        // `TechUpgrades` map rewrites prerequisites and migrates saves, never a lookup that must
        // hit), and `OtherIDs` is the alias declaration itself rather than a reference.
        expect([...labelFieldExemptions].sort()).toEqual([
            'flipwhenloadingids',
            'otherids',
            'selectiontypeid',
            'upgradedfrom',
        ]);
    }, 600_000);

    it('localization keys: zero findings', async () => {
        const findings: string[] = [];
        let scanned = 0;
        for (const file of filesUnder(DATA_DIR, '.rules')) {
            let doc;
            try {
                doc = parseFile(file);
            } catch {
                continue;
            }
            for (const error of await validateLocalizationKeys(doc, [DATA_DIR], token)) {
                findings.push(`${relative(DATA_DIR, file)}: ${error.additionalInfo ?? error.message}`);
            }
            if (++scanned % 200 === 0) ParserResultRegistrar.instance.clear();
        }
        report('localization-keys', findings);
        expect(findings.slice(0, 30)).toEqual([]);
    }, 600_000);

    it('shader code: zero findings across vanilla shaders', async () => {
        const findings: string[] = [];
        for (const file of filesUnder(DATA_DIR, '.shader')) {
            const text = readFileSync(file, 'utf8');
            const diagnostics = await validateShaderDocument(text, file, DATA_DIR).catch((e) => {
                findings.push(`${relative(DATA_DIR, file)}: CRASH ${e}`);
                return [];
            });
            for (const d of diagnostics) {
                findings.push(`${relative(DATA_DIR, file)}:${d.range.start.line + 1}: ${d.message}`);
            }
        }
        report('shader-code', findings);
        expect(findings.slice(0, 30)).toEqual([]);
    }, 600_000);
});
