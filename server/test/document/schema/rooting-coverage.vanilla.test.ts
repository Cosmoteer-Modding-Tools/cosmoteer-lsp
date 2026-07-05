import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import {
    AbstractNodeDocument,
    isAssignmentNode,
    isGroupNode,
    isListNode,
} from '../../../src/core/ast/ast';
import { documentRootClass } from '../../../src/document/schema/document-root';
import { memberTypeIn, resolveGroupClass } from '../../../src/document/schema/schema-context';
import { ReverseIncludeIndex } from '../../../src/features/navigation/reverse-include.index';
import { aliasRootIndex } from '../../../src/document/schema/alias-root';
import { globalSettings } from '../../../src/settings';
import { CosmoteerWorkspaceService } from '../../../src/workspace/cosmoteer-workspace.service';
import { Connection, WorkDoneProgressReporter } from 'vscode-languageserver';

// For how many whole vanilla files does any schema feature (completion, hover, validation) work? A
// file is usable when a schema class attaches to its root, to a top-level group, or types at least one
// top-level member. The recognition test cannot see this. It divides known over (known + unknown) fields
// inside already-rooted nodes, so a fully-unrooted file contributes to neither side and stays invisible.
const DATA_DIR = process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const HAVE_DATA = existsSync(DATA_DIR);
const token = CancellationToken.None;

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

const topLevelMemberNames = (doc: AbstractNodeDocument): string[] =>
    doc.elements
        .map((n) => (isAssignmentNode(n) ? n.left.name : isGroupNode(n) || isListNode(n) ? n.identifier?.name : undefined))
        .filter((n): n is string => !!n);

/** Does any schema feature work anywhere in this document? */
const isUsable = (doc: AbstractNodeDocument): { rooted: boolean; how: string } => {
    if (documentRootClass(doc)) return { rooted: true, how: 'whole-file' };
    for (const el of doc.elements) if (isGroupNode(el) && resolveGroupClass(el)) return { rooted: true, how: 'group' };
    for (const name of topLevelMemberNames(doc)) if (memberTypeIn(doc, name)) return { rooted: true, how: 'member/alias' };
    return { rooted: false, how: 'none' };
};

describe.skipIf(!HAVE_DATA)('rooting coverage over vanilla Data', () => {
    it('reports how many vanilla files are unrooted (no completion/hover/validation)', async () => {
        // Production order, forward alias index first then reverse-include. Without the forward index the
        // command derivers never root, so their inheritance bases don't either, overcounting unrooted files.
        const parseReal = (abs: string) => parser(lexer(readFileSync(abs, 'utf8')), pathToFileURL(abs).href).value;
        const resolveRef = async (fileRef: string, fromUri: string) => {
            const rel = fileRef.replace(/[<>]/g, '').trim();
            if (!rel) return undefined;
            const withExt = /\.[^/\\.]+$/.test(rel) ? rel : `${rel}.rules`;
            for (const abs of [
                join(dirname(fileURLToPath(fromUri)), withExt),
                join(DATA_DIR, withExt),
                join(dirname(DATA_DIR), withExt),
            ]) {
                if (!existsSync(abs)) continue;
                try {
                    return parseReal(abs);
                } catch {
                    return undefined;
                }
            }
            return undefined;
        };
        // Game-root `<./Data/…>` includes resolve through FullNavigationStrategy, which needs the
        // workspace initialized against the Data root, as the running server always has it. Without it a
        // beam shot's `: <./Data/shots/…>` inheritance does not resolve and its file looks unrooted.
        globalSettings.cosmoteerPath = DATA_DIR;
        const noopProgress: WorkDoneProgressReporter = { begin: () => undefined, report: () => undefined, done: () => undefined };
        const svc = CosmoteerWorkspaceService.instance;
        svc.setConnection({ languages: { diagnostics: { refresh: () => undefined } }, window: { showWarningMessage: () => undefined } } as unknown as Connection);
        await svc.initialize(DATA_DIR, noopProgress);
        aliasRootIndex.invalidate();
        await aliasRootIndex.build(parseReal(join(DATA_DIR, 'cosmoteer.rules')), resolveRef);
        ReverseIncludeIndex.instance.reset();
        await ReverseIncludeIndex.instance.ensureBuilt([DATA_DIR], token);

        const files = rulesFiles(DATA_DIR);
        const docs = new Map<string, AbstractNodeDocument>();
        for (const file of files) {
            try {
                docs.set(file, parser(lexer(readFileSync(file, 'utf8')), pathToFileURL(file).href).value);
            } catch {
                /* parser robustness covered elsewhere */
            }
        }

        const unrooted: string[] = [];
        const byHow = new Map<string, number>();
        const byFolder = new Map<string, number>();
        for (const [file, doc] of docs) {
            const { rooted, how } = isUsable(doc);
            byHow.set(how, (byHow.get(how) ?? 0) + 1);
            if (!rooted) {
                unrooted.push(file);
                const rel = relative(DATA_DIR, file).replace(/\\/g, '/');
                const folder = rel.split('/').slice(0, 2).join('/');
                byFolder.set(folder, (byFolder.get(folder) ?? 0) + 1);
            }
        }

        const pct = ((docs.size - unrooted.length) / docs.size) * 100;
        console.log(
            `\n[rooting coverage] ${docs.size} parseable files — ${pct.toFixed(1)}% usable, ` +
                `${unrooted.length} UNROOTED\n` +
                `  by how: ${[...byHow.entries()].map(([k, v]) => `${k}=${v}`).join('  ')}\n` +
                `  unrooted by folder:\n` +
                [...byFolder.entries()]
                    .sort((a, b) => b[1] - a[1])
                    .map(([f, c]) => `    ${c.toString().padStart(4)}  ${f}`)
                    .join('\n') +
                `\n  sample unrooted files:\n` +
                unrooted
                    .slice(0, 60)
                    .map((f) => `    ${relative(DATA_DIR, f).replace(/\\/g, '/')}`)
                    .join('\n')
        );
        expect(docs.size).toBeGreaterThan(0);
        // Regression floor. The recognition and zero-warnings tests cannot see this number, since an
        // unrooted file contributes nothing to recognition and carries no schema class to validate.
        // Measured about 97.5%. The residual 24 are intentional or irreducible. Localization
        // `strings/*.rules`, the game manifest `cosmoteer.rules`, the multi-source concat containers, and
        // the `*_overclock*` fragments pulled in through a typeless macro alias or an in-file group base,
        // which have no typed slot to root them. A drop names the offending folder in the report above.
        expect(pct).toBeGreaterThanOrEqual(97);
    }, 120_000);
});
