import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { CancellationToken, Connection, WorkDoneProgressReporter } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { globalSettings } from '../../../src/settings';
import { CosmoteerWorkspaceService } from '../../../src/workspace/cosmoteer-workspace.service';
import { aliasRootIndex } from '../../../src/document/schema/alias-root';
import { ParserResultRegistrar } from '../../../src/registrar/parser-result-registrar';
import { validateRedundantOverrides } from '../../../src/features/diagnostics/validator.redundant-override';
import { AbstractNode, isGroupNode, isListNode, isValueNode } from '../../../src/core/ast/ast';
import { FullNavigationStrategy } from '../../../src/features/navigation/full.navigation-strategy';
import { getStartOfAstNode } from '../../../src/utils/ast.utils';
import { stepIntoNode } from '../../../src/semantics/reference-resolver';
import { containerAtOffset } from '../../../src/features/refactor/shared-base/shared-base.analysis-entry';

// Triage scan of the redundant-override hint over a whole tree, one file at a time in production
// shape. A finding here is either a field that really is dead weight (fine, that is the feature) or
// a false positive (must be fixed before the validator may run by default), so the written report is
// what gets read, and the test itself only asserts the scan ran. Self-skips without the game tree
// and an output file. REDUNDANT_SCAN_DIR picks the tree to scan, defaulting to the game's own data.
const DATA_DIR = process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const SCAN_DIR = process.env.REDUNDANT_SCAN_DIR ?? DATA_DIR;
const OUT_FILE = process.env.REDUNDANT_SCAN_OUT ?? '';
const HAVE = existsSync(DATA_DIR) && existsSync(SCAN_DIR) && !!OUT_FILE;
const token = CancellationToken.None;

const rulesFilesUnder = (root: string): string[] => {
    const out: string[] = [];
    const walk = (dir: string): void => {
        let entries: string[];
        try {
            entries = readdirSync(dir);
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = join(dir, entry);
            let stats;
            try {
                stats = statSync(full);
            } catch {
                continue;
            }
            if (stats.isDirectory()) walk(full);
            else if (entry.endsWith('.rules')) out.push(full);
        }
    };
    walk(root);
    return out;
};

describe.skipIf(!HAVE)('the redundant-override hint over a whole tree', () => {
    it('collects every finding for false-positive triage', async () => {
        const parseReal = (abs: string) => parser(lexer(readFileSync(abs, 'utf8')), pathToFileURL(abs).href).value;
        const resolveRef = async (fileRef: string, fromUri: string) => {
            const rel = fileRef.replace(/[<>]/g, '').trim();
            if (!rel) return undefined;
            const withExtension = /\.[^/\\.]+$/.test(rel) ? rel : `${rel}.rules`;
            for (const abs of [
                join(dirname(fileURLToPath(fromUri)), withExtension),
                join(DATA_DIR, withExtension),
                join(dirname(DATA_DIR), withExtension),
            ]) {
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
        const service = CosmoteerWorkspaceService.instance;
        service.setConnection({
            languages: { diagnostics: { refresh: () => undefined } },
            window: { showWarningMessage: () => undefined },
        } as unknown as Connection);
        await service.initialize(DATA_DIR, noop);
        aliasRootIndex.invalidate();
        await aliasRootIndex.build(parseReal(join(DATA_DIR, 'cosmoteer.rules')), resolveRef);

        const files = rulesFilesUnder(SCAN_DIR);
        const navigation = new FullNavigationStrategy();
        const findings: string[] = [];
        const unproven: string[] = [];
        let scanned = 0;
        try {
            for (const file of files) {
                const relative = file.replace(/\\/g, '/').slice(SCAN_DIR.replace(/\\/g, '/').length + 1);
                const fsPath = file.replace(/\\/g, '/');
                let text: string;
                let document;
                try {
                    text = readFileSync(file, 'utf8');
                    document = parser(lexer(text), fsPath).value;
                } catch {
                    continue;
                }
                for (const error of await validateRedundantOverrides(document, text, token).catch(() => [])) {
                    const span = error.range as { start: number; end: number } | undefined;
                    const line = span ? text.slice(0, span.start).split('\n').length : 0;
                    findings.push(`${relative}:${line} :: ${error.message}`);
                    const proof = span ? await provesRemovable(navigation, fsPath, text, error.node, span) : 'no span';
                    if (proof) unproven.push(`${relative}:${line} :: ${proof} :: ${error.message}`);
                }
                scanned++;
                if (scanned % 500 === 0) {
                    console.log(`[redundant] ${scanned}/${files.length}, ${findings.length} findings`);
                    ParserResultRegistrar.instance.clear();
                }
            }
        } finally {
            aliasRootIndex.invalidate();
            ParserResultRegistrar.instance.clear();
        }
        writeFileSync(OUT_FILE, findings.join('\n'), 'utf8');
        if (unproven.length > 0) writeFileSync(`${OUT_FILE}.unproven`, unproven.join('\n'), 'utf8');
        console.log(
            `[redundant] ${scanned} files, ${findings.length} findings, ${unproven.length} unproven -> ${OUT_FILE}`
        );
        expect(scanned).toBeGreaterThan(0);
        // Every hint claims the field can be deleted, so every hint is checked by deleting it: the
        // name has to still resolve, and it has to resolve into another file. The oracle is the real
        // cross-file lookup, the same one the game's own resolution mirrors, not the comparison the
        // hint was made with.
        expect(unproven).toEqual([]);
    }, 3_000_000);
});

/** How far up a chain the proof follows, past every real one in the game's data and its mods. */
const MAX_PROOF_DEPTH = 12;

/**
 * Prove a flagged field really is supplied by the chain, by walking that chain with the real
 * cross-file navigator and stepping into each base for the name.
 *
 * Deliberately never asks for the field's own value. A value can itself be a reference (`Bullet =
 * &/SW_SHOTS/…`), and resolving one of those needs the mod's own root, which a scan of a mod against
 * the game tree alone does not have. What the hint claims is that a base declares the name, so that
 * is what is proven.
 *
 * @param navigation the cross-file lookup to prove it with.
 * @param fsPath the file the field is written in.
 * @param text that file's source.
 * @param anchor the diagnostic's node, the container's own identifier.
 * @param span the field's byte span.
 * @returns undefined when a base provably declares the field, or why that could not be shown.
 */
const provesRemovable = async (
    navigation: FullNavigationStrategy,
    fsPath: string,
    text: string,
    anchor: AbstractNode,
    span: { start: number; end: number }
): Promise<string | undefined> => {
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(span.start, span.end))?.[0];
    if (!name) return 'the field has no readable name';
    const container = containerAtOffset(parser(lexer(text), fsPath).value, anchor.position.start);
    if (!container) return 'the container could not be found';

    const seen = new Set<AbstractNode>([container]);
    const walk = async (node: AbstractNode, depth: number): Promise<boolean> => {
        if (depth > MAX_PROOF_DEPTH) return false;
        const bases = (isGroupNode(node) || isListNode(node) ? (node.inheritance ?? []) : []).filter(isValueNode);
        for (const base of bases) {
            const reference = String(base.valueType.value);
            const owner = getStartOfAstNode(node).uri.replace(/^file:\/\/\/?/, '').replace(/\\/g, '/');
            const resolved = (await navigation.navigate(reference, node, owner, token).catch(() => null)) as
                | AbstractNode
                | null;
            if (!resolved || seen.has(resolved)) continue;
            seen.add(resolved);
            if (stepIntoNode(resolved, name)) return true;
            if (await walk(resolved, depth + 1)) return true;
        }
        return false;
    };
    return (await walk(container, 0)) ? undefined : `no base in the chain declares ${name}`;
};
