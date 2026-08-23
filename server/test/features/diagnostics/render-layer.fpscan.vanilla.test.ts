import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { pathToFileURL } from 'url';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { globalSettings } from '../../../src/settings';
import { validateRenderLayers } from '../../../src/features/diagnostics/validator.render-layer';
import { ShipLayerContext, invalidateShipLayers } from '../../../src/features/ships/ship-layer.index';

// False-positive scan of the render-layer check over the whole vanilla install. Everything the game
// ships draws in-game, so every finding here is a false positive by definition, which is the
// contract that lets the check run by default. Needs the install, self-skips without it.
const DATA_DIR = process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const HAVE_DATA = existsSync(DATA_DIR);
const token = CancellationToken.None;

const parseFile = (abs: string) => parser(lexer(readFileSync(abs, 'utf8')), pathToFileURL(abs).href).value;

const rulesFilesUnder = (root: string): string[] => {
    const out: string[] = [];
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir)) {
            const path = join(dir, entry);
            if (statSync(path).isDirectory()) walk(path);
            else if (entry.endsWith('.rules')) out.push(path);
        }
    };
    walk(root);
    return out;
};

describe.skipIf(!HAVE_DATA)('render layers over vanilla Data', () => {
    let context: ShipLayerContext;

    beforeAll(() => {
        globalSettings.cosmoteerPath = DATA_DIR;
        invalidateShipLayers();
        context = {
            gameRootDocument: parseFile(join(DATA_DIR, 'cosmoteer.rules')),
            gameRootPath: join(DATA_DIR, 'cosmoteer.rules'),
            folderPaths: [],
        };
    }, 120_000);

    it('reports nothing on the game own files', async () => {
        const findings: string[] = [];
        for (const file of rulesFilesUnder(DATA_DIR)) {
            let document;
            try {
                document = parseFile(file);
            } catch {
                continue;
            }
            for (const error of await validateRenderLayers(document, context, token)) {
                findings.push(`${relative(DATA_DIR, file)}:${error.node.position.line + 1}: ${error.message}`);
            }
        }
        expect(findings, findings.slice(0, 20).join('\n')).toEqual([]);
    }, 600_000);
});
