import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { CancellationToken, Connection, WorkDoneProgressReporter } from 'vscode-languageserver';
import { AbstractNodeDocument } from '../../../src/core/ast/ast';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { globalSettings } from '../../../src/settings';
import { CosmoteerWorkspaceService } from '../../../src/workspace/cosmoteer-workspace.service';
import { aliasRootIndex } from '../../../src/document/schema/alias-root';
import { ReverseIncludeIndex } from '../../../src/features/navigation/reverse-include.index';
import { SchemaIdIndex } from '../../../src/features/completion/schema-id.index';
import { LocalizationKeyIndex } from '../../../src/features/completion/localization-key.index';
import { MemberInjectionIndex } from '../../../src/mod/member-injection.index';
import { ParserResultRegistrar } from '../../../src/registrar/parser-result-registrar';
import { ValidationError } from '../../../src/features/diagnostics/validator';
import { validateIndicatorIndexes } from '../../../src/features/diagnostics/validator.indicator-index';
import { validateBlendSpriteCodes } from '../../../src/features/diagnostics/validator.blend-sprite';
import { validateRefusedEnumValues } from '../../../src/features/diagnostics/validator.refused-enum-value';
import { validateMishandledFields } from '../../../src/features/diagnostics/validator.mishandled-field';
import { validateChainedToCycles } from '../../../src/features/diagnostics/validator.chained-to-cycle';
import { validateValueRanges } from '../../../src/features/diagnostics/validator.value-range';
import { validateBulletComponents } from '../../../src/features/diagnostics/validator.bullet-components';
import { validateUnderlyingParts } from '../../../src/features/diagnostics/validator.underlying-part';
import { validateChainedBuffReceivable } from '../../../src/features/diagnostics/validator.unreceivable-buff';
import { validateTextMarkup } from '../../../src/features/diagnostics/validator.text-markup';
import { buildActionRootingForScan, resetActionRootingForScan } from '../../scan-rooting-helper';

// Triage scan of the 0.9.0 checks over every installed workshop mod, one mod at a time in
// production shape (folder set = [Data, that mod], which is exactly the coverage a mod workspace
// has). A finding here is either a genuine mod bug or one of our false positives, and the written
// report is what the triage reads, so the test only asserts the scan ran. Self-skips without the
// game, the workshop tree or MODSCAN_OUT.
const DATA_DIR = process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const MODS_DIR = process.env.COSMOTEER_MODS_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/workshop/content/799600';
const OUT_FILE = process.env.MODSCAN_OUT ?? '';
const HAVE = existsSync(DATA_DIR) && existsSync(MODS_DIR) && !!OUT_FILE;
const token = CancellationToken.None;

type Pass = (document: AbstractNodeDocument, token: CancellationToken) => Promise<ValidationError[]>;

const PASSES: { name: string; run: Pass }[] = [
    { name: 'indicator', run: validateIndicatorIndexes },
    { name: 'blendsprite', run: validateBlendSpriteCodes },
    { name: 'enum', run: validateRefusedEnumValues },
    { name: 'mishandled', run: validateMishandledFields },
    { name: 'chainedto', run: validateChainedToCycles },
    { name: 'range', run: validateValueRanges },
    { name: 'bulletcomp', run: validateBulletComponents },
    { name: 'underlying', run: validateUnderlyingParts },
    { name: 'chainedbuff', run: validateChainedBuffReceivable },
    { name: 'markup', run: validateTextMarkup },
];

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
            const path = join(dir, entry);
            let stats;
            try {
                stats = statSync(path);
            } catch {
                continue;
            }
            if (stats.isDirectory()) walk(path);
            else if (entry.toLowerCase().endsWith(ext)) out.push(path);
        }
    };
    walk(root);
    return out;
};

describe.skipIf(!HAVE)('the 0.9.0 checks over installed workshop mods', () => {
    it('collects every finding per mod for false-positive triage', async () => {
        const parseReal = (abs: string) => parser(lexer(readFileSync(abs, 'utf8')), pathToFileURL(abs).href).value;
        const resolveRef = async (fileRef: string, fromUri: string) => {
            const rel = fileRef.replace(/[<>]/g, '').trim();
            if (!rel) return undefined;
            const withExt = /\.[^/\\.]+$/.test(rel) ? rel : rel + '.rules';
            const candidates = [
                join(dirname(fileURLToPath(fromUri)), withExt),
                join(DATA_DIR, withExt),
                join(dirname(DATA_DIR), withExt),
            ];
            for (const abs of candidates) {
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
        const noop: WorkDoneProgressReporter = {
            begin: () => undefined,
            report: () => undefined,
            done: () => undefined,
        };
        const service = CosmoteerWorkspaceService.instance;
        service.setConnection({
            languages: { diagnostics: { refresh: () => undefined } },
            window: { showWarningMessage: () => undefined },
        } as unknown as Connection);
        await service.initialize(DATA_DIR, noop);
        aliasRootIndex.invalidate();
        await aliasRootIndex.build(parseReal(join(DATA_DIR, 'cosmoteer.rules')), resolveRef);

        const modDirs = readdirSync(MODS_DIR)
            .map((dir) => join(MODS_DIR, dir))
            .filter((path) => {
                try {
                    return statSync(path).isDirectory();
                } catch {
                    return false;
                }
            });

        const findings: string[] = [];
        const judged = new Map<string, number>();
        let scannedMods = 0;
        try {
            for (const modDir of modDirs) {
                const modId = modDir.replace(/\\/g, '/').split('/').pop();
                const folders = [DATA_DIR, modDir];
                ReverseIncludeIndex.instance.reset();
                SchemaIdIndex.instance.reset();
                LocalizationKeyIndex.instance.reset();
                await ReverseIncludeIndex.instance.ensureBuilt(folders, token);
                await buildActionRootingForScan(folders, token);
                // Mod actions inject members into the parts they target, and the effective-group
                // fold reads them, so the injections have to be in place or a part whose buff set a
                // manifest widens reads short.
                MemberInjectionIndex.instance.reset();
                await MemberInjectionIndex.instance.ensureBuilt(folders, token);

                for (const file of filesUnder(modDir, '.rules')) {
                    const rel = file.replace(/\\/g, '/').split('/799600/')[1] ?? file;
                    let document;
                    try {
                        document = parseReal(file);
                    } catch {
                        continue;
                    }
                    for (const pass of PASSES) {
                        judged.set(pass.name, (judged.get(pass.name) ?? 0) + 1);
                        for (const error of await pass.run(document, token).catch(() => [])) {
                            findings.push(rel + ':' + (error.node.position.line + 1) + ' :: ' + pass.name + ' :: ' + error.message);
                        }
                    }
                }
                scannedMods++;
                ParserResultRegistrar.instance.clear();
                console.log('[gapscan] ' + modId + ' done (' + scannedMods + '/' + modDirs.length + ', ' + findings.length + ' findings)');
                writeFileSync(OUT_FILE, findings.join('\n'), 'utf8');
            }
        } finally {
            resetActionRootingForScan();
            MemberInjectionIndex.instance.reset();
            ReverseIncludeIndex.instance.reset();
            SchemaIdIndex.instance.reset();
            LocalizationKeyIndex.instance.reset();
            aliasRootIndex.invalidate();
        }
        console.log('[gapscan] judged ' + JSON.stringify(Object.fromEntries(judged)));
        expect(scannedMods).toBe(modDirs.length);
    }, 3_000_000);
});
