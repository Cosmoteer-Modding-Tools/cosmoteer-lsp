import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { CancellationToken, Connection, WorkDoneProgressReporter } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { globalSettings } from '../../../src/settings';
import { CosmoteerWorkspaceService } from '../../../src/workspace/cosmoteer-workspace.service';
import { aliasRootIndex } from '../../../src/document/schema/alias-root';
import { ReverseIncludeIndex } from '../../../src/features/navigation/reverse-include.index';
import { ParserResultRegistrar } from '../../../src/registrar/parser-result-registrar';
import { collectPartComponentIds } from '../../../src/features/diagnostics/validator.schema-sibling';
import { resolveGroupClass } from '../../../src/document/schema/schema-context';
import { componentSatisfiesKind, fieldOf } from '../../../src/document/schema/schema';
import { AbstractNode, isAssignmentNode, isGroupNode, isValueNode } from '../../../src/core/ast/ast';
import { childNodesOf } from '../../../src/utils/ast.utils';

// The slot-kind check is judged by two numbers, and one of them is not "zero findings". A check that
// abstains everywhere reports zero too, so this counts what it actually judged on the game's own
// files beside what it rejected. Everything the game ships loads, so a rejection here is a false
// positive by definition, and a judged count near zero means the table stopped reaching the files.
// Needs the install, self-skips without it.
const DATA_DIR = process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const HAVE_DATA = existsSync(DATA_DIR);
const token = CancellationToken.None;

const filesUnder = (root: string, ext: string): string[] => {
    const out: string[] = [];
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir)) {
            const path = join(dir, entry);
            if (statSync(path).isDirectory()) walk(path);
            else if (entry.endsWith(ext)) out.push(path);
        }
    };
    walk(root);
    return out;
};

const parseFile = (abs: string) => parser(lexer(readFileSync(abs, 'utf8')), pathToFileURL(abs).href).value;

describe.skipIf(!HAVE_DATA)('component slot kinds over vanilla Data', () => {
    beforeAll(async () => {
        globalSettings.cosmoteerPath = DATA_DIR;
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
    }, 300_000);

    it("judges thousands of the game's own values and rejects none of them", async () => {
        let judged = 0;
        let abstained = 0;
        const rejected: string[] = [];
        let scanned = 0;
        for (const file of filesUnder(DATA_DIR, '.rules')) {
            let document;
            try {
                document = parseFile(file);
            } catch {
                continue;
            }
            const ids = await collectPartComponentIds(document, token);
            if (ids.declarations.size === 0) continue;
            const visit = (node: AbstractNode): void => {
                if (isGroupNode(node)) {
                    const cls = resolveGroupClass(node);
                    if (cls) {
                        for (const element of node.elements) {
                            if (!isAssignmentNode(element) || !element.right || !isValueNode(element.right)) continue;
                            const slot = fieldOf(cls, element.left.name)?.expectedComponent;
                            if (!slot) continue;
                            const written = String(element.right.valueType.value);
                            const declaration = ids.declarations.get(written.toLowerCase());
                            const declared = declaration && isGroupNode(declaration) ? resolveGroupClass(declaration) : undefined;
                            const verdict = declared ? componentSatisfiesKind(declared, slot.kind) : undefined;
                            if (verdict === undefined) abstained++;
                            else if (verdict) judged++;
                            else rejected.push(`${relative(DATA_DIR, file)}: ${element.left.name} = ${written}`);
                        }
                    }
                }
                for (const child of childNodesOf(node)) visit(child);
            };
            for (const element of document.elements) visit(element);
            if (++scanned % 200 === 0) ParserResultRegistrar.instance.clear();
        }
        console.log(`[slot-kinds] judged ${judged}, abstained ${abstained}, rejected ${rejected.length}`);
        expect(rejected.slice(0, 30)).toEqual([]);
        expect(judged).toBeGreaterThan(1000);
    }, 600_000);
});
