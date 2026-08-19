import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { CancellationToken, Connection, WorkDoneProgressReporter } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { lexer } from '../../../../src/core/lexer/lexer';
import { parser } from '../../../../src/core/parser/parser';
import { globalSettings } from '../../../../src/settings';
import { CosmoteerWorkspaceService } from '../../../../src/workspace/cosmoteer-workspace.service';
import { aliasRootIndex } from '../../../../src/document/schema/alias-root';
import { ReverseIncludeIndex } from '../../../../src/features/navigation/reverse-include.index';
import { buildBaseFileText, relativeRulesReference } from '../../../../src/features/refactor/shared-base/base-file.emitter';
import { buildConsumerEdits } from '../../../../src/features/refactor/shared-base/consumer-rewrite';
import {
    Candidate,
    candidatesInFile,
    plansFromCandidates,
} from '../../../../src/features/refactor/shared-base/duplicate-field.analysis';
import { editableModRootOf } from '../../../../src/features/refactor/shared-base/shared-base.analysis-entry';

// Corpus sweep of the shared-base extraction over a real mod, written to a report for triage. Every
// plan is a claim that N files say exactly the same thing and could inherit it instead, so the report
// prints the base file the extraction would write and one rewritten consumer next to it: a plan whose
// consumer no longer reads like the original is a bug, not a finding. The test only asserts the sweep
// ran, since what the corpus contains is not ours to assert. Self-skips without the paths.
const DATA_DIR = process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const SCAN_DIR = process.env.SHAREDBASE_SCAN_DIR ?? '';
const OUT_FILE = process.env.SHAREDBASE_OUT ?? '';
const MAX_REPORTED = Number(process.env.SHAREDBASE_TOP ?? '25');
const HAVE = existsSync(DATA_DIR) && !!SCAN_DIR && existsSync(SCAN_DIR) && !!OUT_FILE;
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
            const path = join(dir, entry);
            let stats;
            try {
                stats = statSync(path);
            } catch {
                continue;
            }
            if (stats.isDirectory()) walk(path);
            else if (entry.toLowerCase().endsWith('.rules')) out.push(path.replace(/\\/g, '/'));
        }
    };
    walk(root);
    return out.sort();
};

describe.skipIf(!HAVE)('shared base extraction over a real mod', () => {
    it('reports what it would extract, with the base file and one rewritten consumer', async () => {
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
        const service = CosmoteerWorkspaceService.instance;
        service.setConnection({
            languages: { diagnostics: { refresh: () => undefined } },
            window: { showWarningMessage: () => undefined },
        } as unknown as Connection);
        await service.initialize(DATA_DIR, noop);
        aliasRootIndex.invalidate();
        await aliasRootIndex.build(parseReal(join(DATA_DIR, 'cosmoteer.rules')), resolveRef);
        await ReverseIncludeIndex.instance.ensureBuilt([DATA_DIR, SCAN_DIR], token);

        // The extraction rewrites files, so it must never reach into the game's own install. The
        // duplication in the vanilla tree is real and large, which is exactly why this is asserted
        // rather than assumed.
        const vanillaFile = join(DATA_DIR, 'ships/terran/armor/armor.rules');
        if (existsSync(vanillaFile)) expect(editableModRootOf(vanillaFile)).toBeUndefined();

        const anchorDir = SCAN_DIR.replace(/\\/g, '/');
        const files = rulesFilesUnder(SCAN_DIR);
        const candidates: Candidate[] = [];
        let parsed = 0;
        for (const file of files) {
            let text: string;
            try {
                text = readFileSync(file, 'utf8');
            } catch {
                continue;
            }
            let document;
            try {
                document = parser(lexer(text), file).value;
            } catch {
                continue;
            }
            parsed++;
            candidates.push(...candidatesInFile({ document, text, fsPath: file, uri: pathToFileURL(file).href }, anchorDir, 2));
        }
        const plans = plansFromCandidates(candidates);

        const report: string[] = [
            `scanned ${files.length} files, parsed ${parsed}, ${candidates.length} candidate containers`,
            `${plans.length} extraction plans, showing the ${Math.min(MAX_REPORTED, plans.length)} largest`,
            '',
        ];
        for (const plan of plans.slice(0, MAX_REPORTED)) {
            report.push('='.repeat(100));
            report.push(
                `${plan.tier} :: ${plan.className} :: ${plan.fields.length} fields x ${plan.participants.length} files :: ${plan.savedBytes} bytes`
            );
            report.push(`base -> ${plan.baseFsPath}`);
            report.push(`fields: ${plan.fields.join(', ')}`);
            report.push(`files: ${plan.participants.map((p) => p.fsPath.replace(anchorDir, '')).join(' ')}`);
            report.push('--- generated base file ---');
            report.push(buildBaseFileText(plan));
            const participant = plan.participants[0];
            try {
                const text = readFileSync(participant.fsPath, 'utf8');
                const doc = TextDocument.create(participant.uri, 'rules', 0, text);
                const reference = relativeRulesReference(dirname(participant.fsPath), plan.baseFsPath, plan.groupName);
                report.push(`--- ${participant.fsPath.replace(anchorDir, '')} after the rewrite ---`);
                report.push(TextDocument.applyEdits(doc, buildConsumerEdits(doc, participant, plan, reference)));
            } catch {
                report.push('--- consumer could not be rewritten ---');
            }
            report.push('');
        }
        writeFileSync(OUT_FILE, report.join('\n'), 'utf8');
        console.log(`[sharedbase] ${plans.length} plans over ${files.length} files -> ${OUT_FILE}`);
        expect(parsed).toBeGreaterThan(0);
    }, 900_000);
});
