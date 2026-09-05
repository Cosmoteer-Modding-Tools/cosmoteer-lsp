import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { CancellationToken, Connection, WorkDoneProgressReporter } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { globalSettings } from '../../../src/settings';
import { CosmoteerWorkspaceService } from '../../../src/workspace/cosmoteer-workspace.service';
import { aliasRootIndex } from '../../../src/document/schema/alias-root';
import { SchemaIdIndex } from '../../../src/features/completion/schema-id.index';
import { resetTextImageNames, textImageNames } from '../../../src/features/text-markup/text-image.names';

// The images a drawn string may name come from the data, not from the engine: the game root's
// `TextSprites` table, a resource's `Icon`, and a faction. This holds the reading of all three
// together, since a set that quietly loses one of them turns into a completion list that is missing
// exactly the names an author cannot guess.
const DATA_DIR = process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const HAVE = existsSync(join(DATA_DIR, 'cosmoteer.rules'));
const token = CancellationToken.None;

describe.skipIf(!HAVE)('the image names a language file may draw', () => {
    it('reads the text sprites, the resources and the factions of the game', async () => {
        const parseReal = (abs: string) => parser(lexer(readFileSync(abs, 'utf8')), pathToFileURL(abs).href).value;
        const resolveRef = async (fileRef: string, fromUri: string) => {
            const rel = fileRef.replace(/[<>]/g, '').trim();
            if (!rel) return undefined;
            const withExt = /\.[^/\\.]+$/.test(rel) ? rel : rel + '.rules';
            for (const abs of [join(dirname(fileURLToPath(fromUri)), withExt), join(DATA_DIR, withExt)]) {
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
        CosmoteerWorkspaceService.instance.setConnection({
            languages: { diagnostics: { refresh: () => undefined } },
            window: { showWarningMessage: () => undefined },
        } as unknown as Connection);
        await CosmoteerWorkspaceService.instance.initialize(DATA_DIR, noop);
        aliasRootIndex.invalidate();
        await aliasRootIndex.build(parseReal(join(DATA_DIR, 'cosmoteer.rules')), resolveRef);
        resetTextImageNames();
        try {
            const names = await textImageNames([DATA_DIR], token);
            // A key of the game root's text-sprite table.
            expect(names.has('money')).toBe(true);
            // A resource, which registers its icon under its own id.
            expect(names.has('resource.hyperium')).toBe(true);
            // A faction, which registers its icon the same way.
            expect(names.has('faction_fringe')).toBe(true);
            expect(names.has('no_such_icon')).toBe(false);
        } finally {
            resetTextImageNames();
            SchemaIdIndex.instance.reset();
            aliasRootIndex.invalidate();
        }
    }, 300_000);
});
