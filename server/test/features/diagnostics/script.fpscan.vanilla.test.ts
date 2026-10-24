import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { pathToFileURL } from 'url';
import { CancellationToken, Connection, WorkDoneProgressReporter } from 'vscode-languageserver';
import { descendants } from '../../../src/core/ast/ast';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { globalSettings } from '../../../src/settings';
import { CosmoteerWorkspaceService } from '../../../src/workspace/cosmoteer-workspace.service';
import { validateScripts } from '../../../src/features/diagnostics/validator.script';
import { compileScriptAt } from '../../../src/features/scripting/script-field';

// Every script the game ships compiles when it loads, so a finding here is a false positive by
// definition. Needs the install, self-skips without.
const DATA_DIR = process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const HAVE_DATA = existsSync(DATA_DIR);
const token = CancellationToken.None;
const SCRIPT_FIELD =
    /^\s*(CueCondition|DynamicCondition|DynamicVolume|FadeOutCondition|ShowCondition|TempShowCondition|OnSeen)\s*=/gm;

const rulesUnder = (dir: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) rulesUnder(full, out);
        else if (entry.toLowerCase().endsWith('.rules')) out.push(full);
    }
    return out;
};

describe.skipIf(!HAVE_DATA)('the script check over vanilla Data', () => {
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

    it('compiles every script the game ships, and finds nothing to say', async () => {
        const findings: string[] = [];
        let written = 0;
        let compiled = 0;
        for (const file of [...rulesUnder(join(DATA_DIR, 'codex')), ...rulesUnder(join(DATA_DIR, 'music'))]) {
            const text = readFileSync(file, 'utf8');
            written += text.match(SCRIPT_FIELD)?.length ?? 0;
            const document = parser(lexer(text), pathToFileURL(file).href).value;
            for (const node of descendants(document)) if (await compileScriptAt(node, text, token)) compiled++;
            for (const error of await validateScripts(document, text, token)) {
                findings.push(`${relative(DATA_DIR, file)}: ${error.message}`);
            }
        }
        // Anti-vacuity: every script field the game writes has to have been found and compiled.
        expect(written).toBeGreaterThan(50);
        expect(compiled).toBe(written);
        expect(findings).toEqual([]);
    }, 600_000);

    it('reports a vanilla script once it uses what the game dropped', async () => {
        const file = join(DATA_DIR, 'codex/tutorials/welcome/tutorial_welcome.rules');
        const text = readFileSync(file, 'utf8').replace(/(ShowCondition\s*=\s*")[^"]*"/, '$1stats.Kills > 1"');
        expect(text).toContain('stats.Kills');
        const document = parser(lexer(text), pathToFileURL(file).href).value;
        const found = await validateScripts(document, text, token);
        expect(found.map((error) => error.message)).toEqual([
            "The game refuses to load this script: Unknown variable 'stats'.",
        ]);
        const range = found[0].range!;
        expect(text.slice(range.start, range.end)).toBe('stats');
    });

    /**
     * The findings of a vanilla file with one edit applied, each with the text its range covers.
     *
     * @param path the file under Data.
     * @param from the text to replace.
     * @param to the replacement.
     * @returns `message @ covered text` per finding.
     */
    const brokenFindings = async (path: string, from: string, to: string): Promise<string[]> => {
        const file = join(DATA_DIR, path);
        const original = readFileSync(file, 'utf8');
        expect(original).toContain(from);
        const text = original.replace(from, to);
        const document = parser(lexer(text), pathToFileURL(file).href).value;
        return (await validateScripts(document, text, token)).map(
            (error) => `${error.message} @ ${text.slice(error.range!.start, error.range!.end)}`
        );
    };

    it('places a finding in the second segment of a line-continued script', async () => {
        expect(
            await brokenFindings(
                'codex/tutorials/heat_management/tutorial_heat_management.rules',
                'game.Fame > 0',
                'game.Fame > stats'
            )
        ).toEqual(["The game refuses to load this script: Unknown variable 'stats'. @ stats"]);
    });

    it('reads escaped quotes the way the game does', async () => {
        expect(
            await brokenFindings(
                'codex/tutorials/fires/tutorial_fires.rules',
                'HasStatus(\\"cosmoteer.fire\\")',
                'HasStatus(\\"cosmoteer.fire\\", 1)'
            )
        ).toEqual([
            "The game refuses to load this script: 'HasStatus' cannot be called with arguments (String, Int32). @ HasStatus",
        ]);
    });
});
