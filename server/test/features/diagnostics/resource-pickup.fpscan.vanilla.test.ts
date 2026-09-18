import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { pathToFileURL } from 'url';
import { CancellationToken, Connection, WorkDoneProgressReporter } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { globalSettings } from '../../../src/settings';
import { CosmoteerWorkspaceService } from '../../../src/workspace/cosmoteer-workspace.service';
import { validateResourcePickups } from '../../../src/features/diagnostics/validator.resource-pickup';

// The check reads the resource's stack out of another file, so the whole game tree has to be the
// project for it to resolve anything. Every file the game ships loads and runs, so a finding here
// is a false positive by definition. Needs the install, self-skips without.
const DATA_DIR = process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const HAVE_DATA = existsSync(DATA_DIR);
const token = CancellationToken.None;

const rulesUnder = (dir: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) rulesUnder(full, out);
        else if (entry.toLowerCase().endsWith('.rules')) out.push(full);
    }
    return out;
};

describe.skipIf(!HAVE_DATA)('the resource-pickup check over vanilla Data', () => {
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

    it('finds nothing to say about the files the game ships', async () => {
        const findings: string[] = [];
        let judged = 0;
        for (const file of rulesUnder(DATA_DIR)) {
            let text: string;
            try {
                text = readFileSync(file, 'utf8');
            } catch {
                continue;
            }
            // Only a file that writes one of the two pickup sizes can produce a finding, and
            // parsing the whole tree for the rest costs minutes.
            if (!/MaxResourcesPickUp|InitPickUp/.test(text)) continue;
            let document;
            try {
                document = parser(lexer(text), pathToFileURL(file).href).value;
            } catch {
                continue;
            }
            judged += 1;
            for (const error of await validateResourcePickups(document, [DATA_DIR], token)) {
                findings.push(`${relative(DATA_DIR, file)}: ${error.message}`);
            }
        }
        // Anti-vacuity: the game writes these sizes, so a run that reached no file proves nothing.
        expect(judged).toBeGreaterThan(0);
        expect(findings).toEqual([]);
    }, 600_000);
});
