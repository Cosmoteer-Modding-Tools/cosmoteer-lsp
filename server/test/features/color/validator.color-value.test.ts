import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { CancellationToken, Connection, WorkDoneProgressReporter } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { validateColorValues } from '../../../src/features/color/validator.color-value';
import { warmInheritedClasses } from '../../../src/features/completion/inheritance-resolution';
import { globalSettings } from '../../../src/settings';
import { CosmoteerWorkspaceService } from '../../../src/workspace/cosmoteer-workspace.service';
import { aliasRootIndex } from '../../../src/document/schema/alias-root';
import { ReverseIncludeIndex } from '../../../src/features/navigation/reverse-include.index';

const parse = (src: string) => parser(lexer(src), 'file:///c.rules').value;

// A Color slot on a turret's blueprint sprite, which is where a single-value colour resolves.
const sprite = (body: string) =>
    `Part\n{\n\tComponents\n\t{\n\t\tT\n\t\t{\n\t\t\tType = TurretWeapon\n\t\t\tBlueprintArcSprite\n\t\t\t{\n${body}\n\t\t\t}\n\t\t}\n\t}\n}`;

const findings = (body: string) => validateColorValues(parse(sprite(body))).map((e) => e.message);

describe('color value validator', () => {
    it('reports a hex value, which is a text-markup form and no colour name', () => {
        expect(findings('\t\t\t\tVertexColor = ff0000')).toEqual([
            "'ff0000' names no colour the game knows, so it refuses to load this file. Write one of its colour names, or the channels as a group or a list.",
        ]);
    });

    it('offers the closest colour name as a fix', () => {
        const errors = validateColorValues(parse(sprite('\t\t\t\tVertexColor = Purpl')));
        expect(errors[0].data?.quickFix?.newText).toBe(undefined);
        expect(validateColorValues(parse(sprite('\t\t\t\tVertexColor = Whte')))[0].data?.quickFix?.newText).toBe('White');
    });

    it('stays quiet on a name the engine knows, whatever its case', () => {
        expect(findings('\t\t\t\tVertexColor = transparentwhite')).toEqual([]);
    });

    it('stays quiet on the group, list and reference forms', () => {
        expect(findings('\t\t\t\tVertexColor = [255, 0, 0]')).toEqual([]);
        expect(findings('\t\t\t\tVertexColor { Rf = 1; Gf = 0; Bf = 0 }')).toEqual([]);
        expect(findings('\t\t\t\tVertexColor = &/Palette/Hull')).toEqual([]);
    });

    it('stays quiet on a word written in a slot that is no colour', () => {
        expect(findings('\t\t\t\tBlendMode = Nonsense')).toEqual([]);
    });
});

const DATA_DIR = process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const HAVE_DATA = existsSync(DATA_DIR);
const token = CancellationToken.None;
const parseFile = (abs: string) => parser(lexer(readFileSync(abs, 'utf8')), pathToFileURL(abs).href).value;

const rulesFilesUnder = (root: string): string[] => {
    const out: string[] = [];
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir)) {
            const p = join(dir, entry);
            let st;
            try {
                st = statSync(p);
            } catch {
                continue;
            }
            if (st.isDirectory()) walk(p);
            else if (entry.endsWith('.rules')) out.push(p);
        }
    };
    walk(root);
    return out;
};

describe.skipIf(!HAVE_DATA)('color value validator over vanilla Data', () => {
    let found: string[] = [];

    beforeAll(async () => {
        globalSettings.cosmoteerPath = DATA_DIR;
        const noop: WorkDoneProgressReporter = { begin: () => undefined, report: () => undefined, done: () => undefined };
        const svc = CosmoteerWorkspaceService.instance;
        svc.setConnection({
            languages: { diagnostics: { refresh: () => undefined } },
            window: { showWarningMessage: () => undefined },
        } as unknown as Connection);
        await svc.initialize(DATA_DIR, noop);
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

        found = [];
        for (const file of rulesFilesUnder(DATA_DIR)) {
            let doc;
            try {
                doc = parseFile(file);
            } catch {
                continue;
            }
            await warmInheritedClasses(doc, token).catch(() => undefined);
            for (const error of validateColorValues(doc)) {
                found.push(`${relative(DATA_DIR, file)}: ${error.message}`);
            }
        }
    }, 900_000);

    it('says nothing about the colours the game ships', () => {
        expect(found).toEqual([]);
    });
});
