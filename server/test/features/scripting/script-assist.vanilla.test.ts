import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { CancellationToken, Connection, WorkDoneProgressReporter } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { globalSettings } from '../../../src/settings';
import { CosmoteerWorkspaceService } from '../../../src/workspace/cosmoteer-workspace.service';
import { scriptCompletionsAt, scriptHoverAt } from '../../../src/features/scripting/script-assist';
import { buildSemanticTokens } from '../../../src/features/semantic/semantic-tokens.service';
import { TOKEN_TYPES } from '../../../src/features/semantic/legend';

// Hover, completion and highlighting inside the game's own codex scripts. Needs the install, since a
// codex page is a whole-file root only the game tree can resolve. Self-skips without.
const DATA_DIR = process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const HAVE_DATA = existsSync(DATA_DIR);
const token = CancellationToken.None;
const HEAT = 'codex/tutorials/heat_management/tutorial_heat_management.rules';

/** A vanilla file, optionally edited, parsed under its own uri. */
const open = (path: string, edit?: (text: string) => string) => {
    const file = join(DATA_DIR, path);
    const text = (edit ?? ((t) => t))(readFileSync(file, 'utf8'));
    const uri = pathToFileURL(file).href;
    return { text, document: parser(lexer(text), uri).value, textDocument: TextDocument.create(uri, 'rules', 0, text) };
};

describe.skipIf(!HAVE_DATA)('script hover, completion and highlighting', () => {
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

    it('hovers a method with its signature and the game doc', async () => {
        const { text, document, textDocument } = open(HEAT);
        const offset = text.indexOf('HasPartCategoryInHand') + 3;
        const hover = await scriptHoverAt(document, textDocument, offset, token);
        expect(hover).toContain('GameScriptAccess.HasPartCategoryInHand(category: String): Boolean');
    });

    it('hovers a name in the second segment of a continued script', async () => {
        const { text, document, textDocument } = open(HEAT);
        const hover = await scriptHoverAt(document, textDocument, text.indexOf('game.Fame') + 6, token);
        expect(hover).toContain('GameScriptAccess.Fame: Int32');
    });

    it('completes the members of what stands left of the dot', async () => {
        const { text, document, textDocument } = open(HEAT, (t) => t.replace('game.Fame > 0', 'game.Fa'));
        const offset = text.indexOf('game.Fa') + 'game.Fa'.length;
        const items = await scriptCompletionsAt(document, textDocument, offset, token);
        const labels = items?.map((item) => item.label) ?? [];
        expect(labels).toContain('Fame');
        expect(labels).toContain('HasTechUnlocked');
        expect(labels).not.toContain('sim');
        const edit = items?.find((item) => item.label === 'Fame')?.textEdit;
        expect(edit && 'range' in edit ? textDocument.getText(edit.range) : undefined).toBe('Fa');
    });

    it('completes members after an earlier error in the same script', async () => {
        const { text, document, textDocument } = open(HEAT, (t) =>
            t.replace('game.Fame > 0', 'stats and sim.SelectedShip.Na')
        );
        const offset = text.indexOf('SelectedShip.Na') + 'SelectedShip.Na'.length;
        const labels = (await scriptCompletionsAt(document, textDocument, offset, token))?.map((item) => item.label);
        expect(labels).toContain('Name');
    });

    it('completes the context variables and keywords at the start of a name', async () => {
        const { text, document, textDocument } = open(HEAT, (t) => t.replace('game.Fame > 0', 'game.Fame > 0 and '));
        const offset = text.indexOf('game.Fame > 0 and ') + 'game.Fame > 0 and '.length;
        const labels = (await scriptCompletionsAt(document, textDocument, offset, token))?.map((item) => item.label);
        expect(labels).toEqual(expect.arrayContaining(['game', 'sim', 'not', 'True']));
        expect(labels).not.toContain('zoom');
    });

    it('offers nothing inside a string literal of the script', async () => {
        const { text, document, textDocument } = open(HEAT);
        const offset = text.indexOf("'heat_management'") + 3;
        expect(await scriptCompletionsAt(document, textDocument, offset, token)).toEqual([]);
    });

    it('colours the names inside a script by what they bind to', () => {
        const { text, document } = open(HEAT);
        const data = buildSemanticTokens(document, text).data;
        const lines = text.split('\n');
        const typeAt = new Map<string, string>();
        for (let i = 0, line = 0, char = 0; i < data.length; i += 5) {
            line += data[i];
            char = data[i] === 0 ? char + data[i + 1] : data[i + 1];
            typeAt.set(lines[line].substr(char, data[i + 2]), TOKEN_TYPES[data[i + 3]]);
        }
        expect(typeAt.get('game')).toBe('variable');
        expect(typeAt.get('HasPartCategoryInHand')).toBe('function');
        expect(typeAt.get('Fame')).toBe('property');
        expect(typeAt.get('or')).toBe('keyword');
        expect(typeAt.get("'heat_management'")).toBe('string');
    });
});
