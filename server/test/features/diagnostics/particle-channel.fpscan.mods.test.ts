import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join, relative } from 'path';
import { CancellationToken, Connection, WorkDoneProgressReporter } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { filePathToUri } from '../../../src/features/navigation/navigation-strategy';
import { ensureAliasRootIndex } from '../../../src/features/navigation/alias-root-builder';
import { ReverseIncludeIndex } from '../../../src/features/navigation/reverse-include.index';
import { validateUnusedParticleChannels } from '../../../src/features/diagnostics/validator.particle-channel';
import { CosmoteerWorkspaceService } from '../../../src/workspace/cosmoteer-workspace.service';
import { globalSettings } from '../../../src/settings';

const token = CancellationToken.None;

/** Every `.rules` file under `root`, skipping the directories that hold no rules. */
const rulesFilesUnder = (root: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(root)) {
        if (entry.startsWith('.') || entry === 'node_modules') continue;
        const path = join(root, entry);
        if (statSync(path).isDirectory()) rulesFilesUnder(path, out);
        else if (entry.toLowerCase().endsWith('.rules')) out.push(path);
    }
    return out;
};
const DATA_DIR = process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const MODS_DIR = process.env.COSMOTEER_MODS_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/workshop/content/799600';
const HAVE_DATA = existsSync(DATA_DIR) && existsSync(MODS_DIR);

/** Where a full listing of the findings is written when the run asks for one. */
const OUT = process.env.PARTICLE_MODSCAN_OUT;

/**
 * The ceiling the installed mods run under. Mods copy the game's effects and edit them, so a dead
 * channel is commoner there than in the game's own files. The number is a regression floor for the
 * `Def` fold rather than a claim about how many are worth fixing.
 */
const MAX_FINDINGS = 150;

// The same sweep over the installed workshop mods, which exercise shapes the game's own files never
// do: a `Def` that points into the game tree, a fragment shared by several effects, and updaters
// copied between mods. This is where a false-positive class shows up that vanilla cannot produce.
describe.skipIf(!HAVE_DATA)('unused particle channels over the installed mods', () => {
    let findings: Array<{ file: string; message: string }> = [];

    beforeAll(async () => {
        globalSettings.cosmoteerPath = DATA_DIR;
        const noop: WorkDoneProgressReporter = { begin: () => undefined, report: () => undefined, done: () => undefined };
        const service = CosmoteerWorkspaceService.instance;
        service.setConnection({
            languages: { diagnostics: { refresh: () => undefined } },
            window: { showWarningMessage: () => undefined },
        } as unknown as Connection);
        await service.initialize(DATA_DIR, noop);
        await ensureAliasRootIndex(token);
        await ReverseIncludeIndex.instance.ensureBuilt([DATA_DIR, MODS_DIR], token);
        for (const file of rulesFilesUnder(MODS_DIR)) {
            const text = readFileSync(file, 'utf8');
            if (!text.includes('Out') && !text.includes('out')) continue;
            const document = parser(lexer(text), filePathToUri(file)).value;
            for (const error of await validateUnusedParticleChannels(document, token)) {
                findings.push({ file: relative(DATA_DIR, file).replace(/\\/g, '/'), message: error.message });
            }
        }
        if (OUT) writeFileSync(OUT, findings.map((f) => `${f.file}\t${f.message}`).join('\n'), 'utf8');
    }, 600_000);

    it('stays under the ceiling the fold makes possible', () => {
        expect(findings.length).toBeLessThanOrEqual(MAX_FINDINGS);
    });

    it('reports each dead write once', () => {
        const keys = findings.map((f) => `${f.file}|${f.message}`);
        expect(new Set(keys).size).toBe(keys.length);
    });
});
