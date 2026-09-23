import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { dirname, join, relative } from 'path';
import { pathToFileURL } from 'url';
import { CancellationToken, Connection, WorkDoneProgressReporter } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { globalSettings } from '../../../src/settings';
import { CosmoteerWorkspaceService } from '../../../src/workspace/cosmoteer-workspace.service';
import { ParserResultRegistrar } from '../../../src/document/parser-result-registrar';
import { validateDivisionByZero } from '../../../src/features/diagnostics/validator.division-by-zero';

// The check reads the type of the field a value lands in, and the group-typed fields written in
// their scalar shorthand (every `Halfling.Timing.Time`) were added to that set. The game's own data
// and the mods it ships load, so anything reported here is a false positive by definition. Needs
// the install, self-skips without it.
const DATA_DIR = process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const STANDARD_MODS = join(dirname(DATA_DIR), 'Standard Mods');
const HAVE_DATA = existsSync(DATA_DIR);
const token = CancellationToken.None;

/** Every `.rules` file under `root`, walked depth first. */
const filesUnder = (root: string): string[] => {
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
            else if (entry.toLowerCase().endsWith('.rules')) out.push(path);
        }
    };
    walk(root);
    return out;
};

const parseFile = (abs: string) => parser(lexer(readFileSync(abs, 'utf8')), pathToFileURL(abs).href).value;

describe.skipIf(!HAVE_DATA)('division by zero over the data the game ships', () => {
    beforeAll(async () => {
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
    }, 300_000);

    it('reports nothing on vanilla Data or on the Standard Mods', async () => {
        const roots = [DATA_DIR, ...(existsSync(STANDARD_MODS) ? [STANDARD_MODS] : [])];
        const findings: string[] = [];
        let scanned = 0;
        for (const root of roots) {
            for (const file of filesUnder(root)) {
                let document;
                try {
                    document = parseFile(file);
                } catch {
                    continue;
                }
                for (const error of await validateDivisionByZero(document, token)) {
                    findings.push(`${relative(root, file)}: ${error.message}`);
                }
                if (++scanned % 200 === 0) ParserResultRegistrar.instance.clear();
            }
        }
        expect(findings.slice(0, 20)).toEqual([]);
        expect(scanned).toBeGreaterThan(500);
    }, 600_000);
});
