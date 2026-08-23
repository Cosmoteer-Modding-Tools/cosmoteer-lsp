import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { CancellationToken } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { isModRules } from '../../../src/document/document-kind';
import { allDeprecationSymbols, deprecationBySymbol } from '../../../src/document/schema/deprecations';
import { validateIgnoredFields } from '../../../src/features/diagnostics/validator.ignored-field';
import { validateSchema } from '../../../src/features/diagnostics/validator.schema';
import { collectFileMigration } from '../../../src/features/migration/migrate-workspace';

// The proof the bulk deprecation fix rests on, over the real corpus: collecting one registry entry
// at a time must add up to exactly what the whole-file migration collects, and nothing may be
// collected twice or fall through untagged. Text matching would not survive this: `ComponentID`
// alone occurs thousands of times across the installed mods and is deprecated on one class.
// The written report is per-symbol triage material, so the test only asserts the invariants. The
// walk takes in `.txt` as well, since the game loads those as rules too, which puts the prose ones
// into the unparsable count.
// Self-skips without the game or workshop tree. MODSCAN_FROM/TO select a chunk of mods,
// MODSCAN_OUT is the report file.
const DATA_DIR = process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const MODS_DIR = process.env.COSMOTEER_MODS_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/workshop/content/799600';
const OUT_FILE = process.env.MODSCAN_OUT ?? '';
const FROM = Number(process.env.MODSCAN_FROM ?? '0');
const TO = Number(process.env.MODSCAN_TO ?? '9999');
const HAVE = existsSync(DATA_DIR) && existsSync(MODS_DIR) && !!OUT_FILE;
const token = CancellationToken.None;

/** Every rules file under a tree, the same set the workspace migration walks. */
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
            const path = join(dir, entry);
            let stats;
            try {
                stats = statSync(path);
            } catch {
                continue;
            }
            if (stats.isDirectory()) walk(path);
            else if (/\.(rules|txt)$/i.test(entry) && !/^(readme|changelog)\./i.test(entry)) out.push(path);
        }
    };
    walk(root);
    return out;
};

/** An edit as a comparable string, so two runs can be compared without depending on their order. */
const editKeys = (edits: readonly { range: { start: { line: number; character: number } }; newText: string }[]) =>
    edits.map((edit) => `${edit.range.start.line}:${edit.range.start.character}=${edit.newText}`).sort();

describe.skipIf(!HAVE)('per-symbol migration over the installed corpus', () => {
    it('partitions the whole-file migration exactly, symbol by symbol', async () => {
        const symbols = allDeprecationSymbols();
        const trees: Array<{ name: string; root: string }> = [{ name: 'vanilla', root: DATA_DIR }];
        for (const entry of readdirSync(MODS_DIR).slice(FROM, TO)) {
            const path = join(MODS_DIR, entry);
            try {
                if (statSync(path).isDirectory()) trees.push({ name: entry, root: path });
            } catch {
                continue;
            }
        }

        const perSymbolEdits: Record<string, number> = {};
        const perSymbolManual: Record<string, number> = {};
        const untagged: string[] = [];
        const mismatches: string[] = [];
        let files = 0;
        let unparsable = 0;
        let totalEdits = 0;
        let totalManual = 0;

        for (const tree of trees) {
            for (const file of rulesFilesUnder(tree.root)) {
                let text: string;
                try {
                    text = readFileSync(file, 'utf8');
                } catch {
                    continue;
                }
                files++;
                const uri = pathToFileURL(file).href;
                const parserResult = parser(lexer(text), uri);
                // The migration never edits a file it could not fully read: an edit computed against
                // a desynced tree could land anywhere.
                if (parserResult.parserErrors.length > 0) {
                    unparsable++;
                    continue;
                }
                const errors = [
                    ...(await validateSchema(parserResult.value, token).catch(() => [])),
                    ...(await validateIgnoredFields(parserResult.value, token).catch(() => [])),
                ];
                const migrations = errors.filter((error) => error.data?.migration);
                for (const error of migrations) {
                    const symbol = error.data?.migration?.symbol;
                    if (!symbol || !deprecationBySymbol(symbol)) untagged.push(`${file}: ${error.message}`);
                }
                // A manifest carries no diagnostics at all (its loader lives outside the
                // serialization system), so it is always run through the collector rather than
                // being skipped for having no findings.
                if (migrations.length === 0 && !isModRules(uri)) continue;

                const doc = TextDocument.create(uri, 'rules', 0, text);
                const whole = await collectFileMigration(parserResult.value, doc, false, token);
                totalEdits += whole.edits.length;
                totalManual += whole.manual.length;
                const parts: string[] = [];
                let partManual = 0;
                for (const symbol of symbols) {
                    const one = await collectFileMigration(parserResult.value, doc, false, token, symbol);
                    if (one.edits.length === 0 && one.manual.length === 0) continue;
                    perSymbolEdits[symbol] = (perSymbolEdits[symbol] ?? 0) + one.edits.length;
                    perSymbolManual[symbol] = (perSymbolManual[symbol] ?? 0) + one.manual.length;
                    parts.push(...editKeys(one.edits));
                    partManual += one.manual.length;
                }
                const expected = editKeys(whole.edits);
                if (parts.sort().join('|') !== expected.join('|') || partManual !== whole.manual.length) {
                    mismatches.push(`${file}: ${parts.length}/${partManual} vs ${expected.length}/${whole.manual.length}`);
                }
            }
        }

        const lines = [
            `files ${files}, unparsable ${unparsable}, edits ${totalEdits}, manual ${totalManual}`,
            '',
            ...symbols.map(
                (symbol) => `${symbol}: ${perSymbolEdits[symbol] ?? 0} edits, ${perSymbolManual[symbol] ?? 0} manual`
            ),
            '',
            `untagged findings ${untagged.length}`,
            ...untagged.slice(0, 50),
            `partition mismatches ${mismatches.length}`,
            ...mismatches.slice(0, 50),
            '',
        ];
        writeFileSync(OUT_FILE, lines.join('\n'), 'utf8');

        expect(files).toBeGreaterThan(1000);
        expect(untagged).toEqual([]);
        expect(mismatches).toEqual([]);
        // Every applied fix belongs to exactly one symbol, so the per-symbol counts add up.
        expect(Object.values(perSymbolEdits).reduce((a, b) => a + b, 0)).toBe(totalEdits);
        expect(Object.values(perSymbolManual).reduce((a, b) => a + b, 0)).toBe(totalManual);
    }, 1_800_000);
});
