import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join, relative } from 'path';
import { pathToFileURL } from 'url';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { globalSettings } from '../../../src/settings';
import { ParserResultRegistrar } from '../../../src/registrar/parser-result-registrar';
import { validateRenderLayers } from '../../../src/features/diagnostics/validator.render-layer';
import { ShipLayerContext, invalidateShipLayers } from '../../../src/features/ships/ship-layer.index';

// Triage scan of the render-layer check over every installed workshop mod, one mod at a time in
// production shape (folder set = [Data, that mod], which is what a mod workspace sees). A finding is
// either a real mod bug, which is the feature, or a false positive, which has to be fixed before the
// check may run by default. The report is for that triage, so the test asserts only that the scan
// ran. Self-skips without the game or workshop tree. LAYERSCAN_OUT names the report file.
const DATA_DIR = process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const MODS_DIR = process.env.COSMOTEER_MODS_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/workshop/content/799600';
const OUT_FILE = process.env.LAYERSCAN_OUT ?? '';
const HAVE = existsSync(DATA_DIR) && existsSync(MODS_DIR) && !!OUT_FILE;
const token = CancellationToken.None;

const filesUnder = (root: string, ext: string): string[] => {
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
            let stat;
            try {
                stat = statSync(path);
            } catch {
                continue;
            }
            if (stat.isDirectory()) walk(path);
            else if (entry.endsWith(ext)) out.push(path);
        }
    };
    walk(root);
    return out;
};

describe.skipIf(!HAVE)('render layers over installed workshop mods', () => {
    it('collects every finding per mod for false-positive triage', async () => {
        const parseReal = (abs: string) => parser(lexer(readFileSync(abs, 'utf8')), pathToFileURL(abs).href).value;
        globalSettings.cosmoteerPath = DATA_DIR;
        const gameRootPath = join(DATA_DIR, 'cosmoteer.rules');
        const gameRootDocument = parseReal(gameRootPath);

        const modRoots = readdirSync(MODS_DIR)
            .map((entry) => join(MODS_DIR, entry))
            .filter((path) => {
                try {
                    return statSync(path).isDirectory();
                } catch {
                    return false;
                }
            });

        const lines: string[] = [];
        let scanned = 0;
        let findings = 0;
        for (const modRoot of modRoots) {
            invalidateShipLayers();
            const context: ShipLayerContext = { gameRootDocument, gameRootPath, folderPaths: [DATA_DIR, modRoot] };
            for (const file of filesUnder(modRoot, '.rules')) {
                let document;
                try {
                    document = parseReal(file);
                } catch {
                    continue;
                }
                for (const error of await validateRenderLayers(document, context, token)) {
                    findings++;
                    lines.push(`${relative(MODS_DIR, file)}:${error.node.position.line + 1}: ${error.message}`);
                }
                if (++scanned % 200 === 0) ParserResultRegistrar.instance.clear();
            }
        }
        lines.unshift(`# ${modRoots.length} mods, ${scanned} files, ${findings} findings`);
        writeFileSync(OUT_FILE, lines.join('\n'), 'utf8');
        expect(scanned).toBeGreaterThan(0);
    }, 3_600_000);
});
