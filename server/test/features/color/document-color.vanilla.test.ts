import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { CancellationToken, Connection, WorkDoneProgressReporter } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { colorPresentations, documentColors } from '../../../src/features/color/document-color';
import { markupColorPresentations, markupColors } from '../../../src/features/color/markup-color';
import { warmInheritedClasses } from '../../../src/features/completion/inheritance-resolution';
import { globalSettings } from '../../../src/settings';
import { CosmoteerWorkspaceService } from '../../../src/workspace/cosmoteer-workspace.service';
import { aliasRootIndex } from '../../../src/document/schema/alias-root';
import { ReverseIncludeIndex } from '../../../src/features/navigation/reverse-include.index';

// Colour sweep over the whole vanilla install. Two contracts: every swatch the editor shows writes
// back byte for byte when the picker hands the same colour in again (so using the picker never
// flattens an overbright channel or reformats a number), and no swatch lands on a slot the engine
// does not read as a colour. The second is pinned by the set of field names swatches sit on, which
// is what a rect or a padding slipping into the colour path would grow.
// Set COLOR_SWEEP_OUT to dump every swatch for eyeballing. Needs the install, self-skips without it.
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

/** The byte offset a line and character position sits at, for slicing the swatch's own text back out. */
const offsetOf = (starts: readonly number[], position: { line: number; character: number }): number =>
    starts[position.line] + position.character;

const lineStartsOf = (text: string): number[] => {
    const starts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
    return starts;
};

/** The field name a swatch sits on, read off the text in front of its anchor. */
const ownerOf = (text: string, start: number): string => {
    const before = text.slice(Math.max(0, start - 200), start);
    const named = /([A-Za-z_][\w.]*)\s*[=:]?\s*$/.exec(before);
    if (/^[A-Za-z_]/.test(text.slice(start, start + 1))) return /^[A-Za-z_][\w.]*/.exec(text.slice(start))![0];
    return named ? named[1] : '(anon)';
};

describe.skipIf(!HAVE_DATA)('color swatches over vanilla Data', () => {
    let swatches: { file: string; line: number; owner: string; text: string; written: string }[] = [];

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

        swatches = [];
        for (const file of rulesFilesUnder(DATA_DIR)) {
            const text = readFileSync(file, 'utf8');
            let doc;
            try {
                doc = parser(lexer(text), pathToFileURL(file).href).value;
            } catch {
                continue;
            }
            await warmInheritedClasses(doc, token).catch(() => undefined);
            const starts = lineStartsOf(text);
            const markup = markupColors(doc);
            for (const found of [...(await documentColors(doc, token)), ...markup]) {
                const from = offsetOf(starts, found.range.start);
                const to = offsetOf(starts, found.range.end);
                const presentations = markup.includes(found)
                    ? markupColorPresentations(doc, found.range, found.color)
                    : await colorPresentations(doc, text, found.range, found.color, token);
                swatches.push({
                    file: relative(DATA_DIR, file),
                    line: found.range.start.line + 1,
                    owner: ownerOf(text, from),
                    text: text.slice(from, to),
                    written: presentations[0]?.textEdit?.newText ?? '(no presentation)',
                });
            }
        }
        if (process.env.COLOR_SWEEP_OUT) {
            writeFileSync(
                process.env.COLOR_SWEEP_OUT,
                swatches.map((s) => `${s.file}:${s.line} ${s.owner}\n  ${JSON.stringify(s.text)}\n  ${JSON.stringify(s.written)}`).join('\n'),
                'utf8'
            );
        }
    }, 900_000);

    it('finds the colours the install writes', () => {
        expect(swatches.length).toBeGreaterThan(2700);
    });

    it('writes every swatch back byte for byte when the picked colour is the one shown', () => {
        const lossy = swatches
            .filter((s) => s.written !== s.text)
            .map((s) => `${s.file}:${s.line} ${JSON.stringify(s.text)} -> ${JSON.stringify(s.written)}`);
        expect(lossy).toEqual([]);
    });

    it('puts no swatch on a slot the engine reads as something other than a colour', () => {
        // Every name a vanilla swatch sits on. A rect, a padding or an offset appearing here means the
        // slot typing gave way and a four-number list of some other kind took the colour path.
        const owners = [...new Set(swatches.map((s) => s.owner))].sort();
        const shaped = owners.filter((name) => /colou?r/i.test(name));
        expect(new Set(owners.filter((name) => !shaped.includes(name)))).toEqual(
            new Set([
                '(anon)',
                'Default',
                'FromValue',
                'GlobalDiffuseLight',
                'GlobalMinDiffuseLight',
                'GlobalSpecularLight',
                'Max',
                'Min',
                'ToValue',
                'Value',
            ])
        );
    });
});
