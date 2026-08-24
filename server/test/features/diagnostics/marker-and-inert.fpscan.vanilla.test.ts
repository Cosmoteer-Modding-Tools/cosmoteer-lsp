import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join, relative } from 'path';
import { pathToFileURL } from 'url';
import { CancellationToken, Connection, WorkDoneProgressReporter } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { globalSettings } from '../../../src/settings';
import { CosmoteerWorkspaceService } from '../../../src/workspace/cosmoteer-workspace.service';
import { ParserResultRegistrar } from '../../../src/registrar/parser-result-registrar';
import { validateMarkerVocabulary } from '../../../src/features/diagnostics/validator.marker-vocabulary';
import { validateInertFields } from '../../../src/features/diagnostics/validator.inert-field';
import { validateEffectBuckets } from '../../../src/features/diagnostics/validator.effect-bucket';

// False-positive scan of the three checks that judge a file against the game's own rules rather
// than against another file. Everything the game ships loads and runs, so every finding here is a
// false positive by definition, and all three default to on. Needs the install, self-skips without.
const DATA_DIR =
    process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const HAVE_DATA = existsSync(DATA_DIR);
const token = CancellationToken.None;

const rulesUnder = (root: string): string[] => {
    const out: string[] = [];
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir)) {
            const path = join(dir, entry);
            if (statSync(path).isDirectory()) walk(path);
            else if (entry.toLowerCase().endsWith('.rules')) out.push(path);
        }
    };
    walk(root);
    return out;
};

const parseFile = (abs: string) => parser(lexer(readFileSync(abs, 'utf8')), pathToFileURL(abs).href).value;

// vitest run mode drops large console output, so the scan also writes its findings to a file when
// FPSCAN_OUT_DIR names a directory for them.
const OUT_DIR = process.env.FPSCAN_OUT_DIR ?? '';
const report = (name: string, findings: string[]): void => {
    console.log(`\n[${name}] ${findings.length} findings\n` + findings.slice(0, 50).join('\n'));
    if (OUT_DIR) writeFileSync(join(OUT_DIR, `fpscan-${name}.txt`), findings.join('\n'), 'utf8');
};

describe.skipIf(!HAVE_DATA)('the game-rule checks over vanilla Data', () => {
    beforeAll(async () => {
        globalSettings.cosmoteerPath = DATA_DIR;
        const noop: WorkDoneProgressReporter = { begin: () => undefined, report: () => undefined, done: () => undefined };
        const service = CosmoteerWorkspaceService.instance;
        service.setConnection({
            languages: { diagnostics: { refresh: () => undefined } },
            window: { showWarningMessage: () => undefined },
        } as unknown as Connection);
        await service.initialize(DATA_DIR, noop);
    }, 300_000);

    it('finds nothing to say about the categories, the switched-off fields and the buckets', async () => {
        const marker: string[] = [];
        const inert: string[] = [];
        const buckets: string[] = [];
        let scanned = 0;
        for (const file of rulesUnder(DATA_DIR)) {
            let document;
            try {
                document = parseFile(file);
            } catch {
                continue;
            }
            const name = relative(DATA_DIR, file);
            for (const error of await validateMarkerVocabulary(document, [DATA_DIR], token)) {
                marker.push(`${name}: ${error.message}`);
            }
            for (const error of await validateInertFields(document, token)) inert.push(`${name}: ${error.message}`);
            for (const error of await validateEffectBuckets(document, token)) buckets.push(`${name}: ${error.message}`);
            if (++scanned % 200 === 0) ParserResultRegistrar.instance.clear();
        }
        report('marker-vocabulary', marker);
        report('inert-fields', inert);
        report('effect-buckets', buckets);
        expect(scanned).toBeGreaterThan(900);
        expect(marker.slice(0, 30)).toEqual([]);
        expect(inert.slice(0, 30)).toEqual([]);
        expect(buckets.slice(0, 30)).toEqual([]);
    }, 900_000);
});
