import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { CancellationToken, Connection, WorkDoneProgressReporter } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { globalSettings } from '../../../src/settings';
import { CosmoteerWorkspaceService } from '../../../src/workspace/cosmoteer-workspace.service';
import { aliasRootIndex } from '../../../src/document/schema/alias-root';
import { ReverseIncludeIndex } from '../../../src/features/navigation/reverse-include.index';
import { SchemaIdIndex } from '../../../src/features/completion/schema-id.index';
import { LocalizationKeyIndex } from '../../../src/features/completion/localization-key.index';
import { MemberInjectionIndex } from '../../../src/mod/member-injection.index';
import { invalidateModContext } from '../../../src/mod/mod-context';
import { ParserResultRegistrar } from '../../../src/registrar/parser-result-registrar';
import { validateTextMarkup } from '../../../src/features/diagnostics/validator.text-markup';
import { resetTextImageNames } from '../../../src/features/text-markup/text-image.names';
import { buildActionRootingForScan, resetActionRootingForScan } from '../../scan-rooting-helper';

// The images a drawn string may name come from the data, so the check on them is only as good as the
// set it reads. These are the installed mods whose language files draw an image at all, and between
// them they cover every way one is registered: the game's own icons, a resource the mod wires in
// from a folder of its own, and a sprite the mod merges into the game's table with an `Overrides`
// action. Every name they write has to be accepted, and the control at the end proves a name nothing
// registers is still reported.
const DATA_DIR = process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const MODS_DIR = process.env.COSMOTEER_MODS_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/workshop/content/799600';
const IMAGE_MODS = ['2879478059', '2880017812', '2946411143', '3119349707', '3423045244'];
const HAVE = existsSync(DATA_DIR) && IMAGE_MODS.some((mod) => existsSync(join(MODS_DIR, mod)));
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

describe.skipIf(!HAVE)('image names a language file draws', () => {
    it('accepts every image the mods that draw one write, and still reports one nothing registers', async () => {
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

        const unaccepted: string[] = [];
        let judged = 0;
        let control: string[] = [];
        try {
            for (const mod of IMAGE_MODS) {
                const modDir = join(MODS_DIR, mod);
                if (!existsSync(modDir)) continue;
                const folders = [DATA_DIR, modDir];
                ReverseIncludeIndex.instance.reset();
                SchemaIdIndex.instance.reset();
                LocalizationKeyIndex.instance.reset();
                MemberInjectionIndex.instance.reset();
                invalidateModContext();
                resetTextImageNames();
                await ReverseIncludeIndex.instance.ensureBuilt(folders, token);
                await buildActionRootingForScan(folders, token);
                await MemberInjectionIndex.instance.ensureBuilt(folders, token);

                for (const file of filesUnder(modDir)) {
                    if (!/[\\/]strings[\\/]/i.test(file)) continue;
                    let document;
                    try {
                        document = parseReal(file);
                    } catch {
                        continue;
                    }
                    judged++;
                    for (const error of await validateTextMarkup(document, folders, token)) {
                        if (/registers an image named/.test(error.message)) unaccepted.push(mod + ': ' + error.message);
                    }
                }

                // Negative control, in the same mod and with the same indexes: a name nothing
                // registers has to be reported, or the run above passed for the wrong reason.
                const probe = parser(
                    lexer('__Name = English\nParts/Probe = "<img name=\'no_such_icon\'/>"\n'),
                    pathToFileURL(join(modDir, 'strings', '_probe.rules')).href
                ).value;
                control = control.concat(
                    (await validateTextMarkup(probe, folders, token)).map((error) => error.message)
                );
                ParserResultRegistrar.instance.clear();
            }
        } finally {
            resetActionRootingForScan();
            MemberInjectionIndex.instance.reset();
            ReverseIncludeIndex.instance.reset();
            SchemaIdIndex.instance.reset();
            LocalizationKeyIndex.instance.reset();
            invalidateModContext();
            resetTextImageNames();
            aliasRootIndex.invalidate();
        }
        expect(judged).toBeGreaterThan(0);
        expect(unaccepted).toEqual([]);
        expect(control.join(' | ')).toMatch(/registers an image named 'no_such_icon'/);
    }, 900_000);
});
