import { describe, expect, it, beforeAll } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { CancellationToken, Connection, WorkDoneProgressReporter } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { globalSettings } from '../../../src/settings';
import { CosmoteerWorkspaceService } from '../../../src/workspace/cosmoteer-workspace.service';
import { aliasRootIndex } from '../../../src/document/schema/alias-root';
import { ReverseIncludeIndex } from '../../../src/features/navigation/reverse-include.index';
import { clearShaderCache } from '../../../src/features/shader/shader-index';
import {
    materialGroupsOf,
    validateShaderConstants,
} from '../../../src/features/diagnostics/validator.shader-constants';

// The shader-constant validator flags an inline `_`-key the referenced shader declares no uniform for,
// and a value of the wrong shape for its type. The contract this guards (it runs by default, so the
// bar is zero warnings on shipping data):
//   - zero type-mismatch warnings on vanilla (every vanilla value is correctly typed, so any such
//     warning is a false positive from the type check being too aggressive).
//   - zero "unknown constant" warnings: the handful of dead keys the game itself ships are skipped by
//     the validator's VANILLA_DEAD_KEYS set. A new dead key in a game update, or a parser regression
//     that broke constant extraction (which would flag hundreds of real constants), both surface here.
// The scan runs against a fully initialized workspace, the same footing the whole-workspace pass gives
// the validator. Without it the class of a root-level material never resolves, nothing is checked and
// the zero-warning result means nothing, so the material count and a positive control pin it down.
// Needs the install, self-skips without it.
const DATA_DIR =
    process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const HAVE_DATA = existsSync(DATA_DIR);
const token = CancellationToken.None;

const parseFile = (abs: string) => parser(lexer(readFileSync(abs, 'utf8')), pathToFileURL(abs).href).value;

const rulesFiles = (root: string): string[] => {
    const out: string[] = [];
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir)) {
            const p = join(dir, entry);
            if (statSync(p).isDirectory()) walk(p);
            else if (entry.endsWith('.rules')) out.push(p);
        }
    };
    walk(root);
    return out;
};

describe.skipIf(!HAVE_DATA)('shader-constant validation over vanilla Data', () => {
    let warnings: string[] = [];
    let materials = 0;

    beforeAll(async () => {
        globalSettings.cosmoteerPath = DATA_DIR;
        clearShaderCache();
        const noop: WorkDoneProgressReporter = { begin: () => undefined, report: () => undefined, done: () => undefined };
        const service = CosmoteerWorkspaceService.instance;
        service.setConnection({
            languages: { diagnostics: { refresh: () => undefined } },
            window: { showWarningMessage: () => undefined },
        } as unknown as Connection);
        await service.initialize(DATA_DIR, noop);
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
                        return parseFile(abs);
                    } catch {
                        return undefined;
                    }
                }
            }
            return undefined;
        };
        aliasRootIndex.invalidate();
        await aliasRootIndex.build(parseFile(join(DATA_DIR, 'cosmoteer.rules')), resolveRef);
        ReverseIncludeIndex.instance.reset();
        await ReverseIncludeIndex.instance.ensureBuilt([DATA_DIR], token);

        warnings = [];
        materials = 0;
        for (const file of rulesFiles(DATA_DIR)) {
            let doc;
            try {
                doc = parseFile(file);
            } catch {
                continue;
            }
            for (const error of await validateShaderConstants(doc, token)) {
                warnings.push(`${file}: ${error.message}`);
            }
            materials += [...materialGroupsOf(doc)].length;
        }
    }, 600_000);

    it('produces zero warnings of any kind across vanilla', () => {
        expect(warnings.slice(0, 30)).toEqual([]);
    });

    it('actually reaches the materials it is meant to check', () => {
        // A regression that stops classifying material groups would otherwise pass the check above
        // by checking nothing at all.
        expect(materials).toBeGreaterThan(200);
    });

    it('still reports a mistyped constant on a real vanilla material (positive control)', async () => {
        const file = join(DATA_DIR, 'gui/widgets.rules');
        const src = readFileSync(file, 'utf8').replace('_highlightTime = -1000', '_highlightTimee = -1000');
        const doc = parser(lexer(src), pathToFileURL(file).href).value;
        const messages = (await validateShaderConstants(doc, token)).map((e) => e.message as string);
        expect(messages.some((m) => m.includes("'_highlightTimee'"))).toBe(true);
    });

    it('accepts a constant declared by the shader of a derived sprite', async () => {
        // `MainSprite` writes `_highlightTime` and `_clickTime`, which only `HighlightSprite :
        // MainSprite`'s shader declares. The engine builds both from the same constant block.
        const file = join(DATA_DIR, 'gui/widgets.rules');
        const doc = parseFile(file);
        const messages = (await validateShaderConstants(doc, token)).map((e) => e.message as string);
        expect(messages).toEqual([]);
    });
});
