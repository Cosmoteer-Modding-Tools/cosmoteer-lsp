import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join, relative } from 'path';
import { pathToFileURL } from 'url';
import { CancellationToken, Connection, DocumentHighlight, WorkDoneProgressReporter } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import {
    AbstractNode,
    AbstractNodeDocument,
    isAssignmentNode,
    isDocumentNode,
    isFunctionCallNode,
    isGroupNode,
    isListNode,
    isMathExpressionNode,
    ValueNode,
} from '../../../src/core/ast/ast';
import { documentHighlightsAt } from '../../../src/features/navigation/document-highlight';
import { particleChannelsOf } from '../../../src/features/navigation/particle-channel';
import { referenceNodesOf } from '../../../src/features/navigation/reference-index';
import { globalSettings } from '../../../src/settings';
import { CosmoteerWorkspaceService } from '../../../src/workspace/cosmoteer-workspace.service';

// Manual corpus run for occurrence highlighting, self-skipped unless both HIGHLIGHT_SCAN_DIR and
// HIGHLIGHT_SCAN_OUT are set, so it never runs in CI. It drives the real handler at every particle
// channel value and at a spread of reference values in every `.rules` file under the scan root, and
// checks the invariants that make the feature safe to leave on: nothing throws, nothing answers an
// empty list (which would take away the editor's own word highlighting), every range is single-line
// and covers text the document really has there, and the answer includes the member the cursor is on.
// Usage: HIGHLIGHT_SCAN_DIR=<tree> HIGHLIGHT_SCAN_OUT=<report.json> npx vitest run test/features/navigation/document-highlight.corpus.test.ts
const DATA_DIR = process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const SCAN_DIR = process.env.HIGHLIGHT_SCAN_DIR ?? '';
const OUT_FILE = process.env.HIGHLIGHT_SCAN_OUT ?? '';
const PROBES_PER_FILE = Number(process.env.HIGHLIGHT_SCAN_PROBES ?? '12');
const HAVE = existsSync(DATA_DIR) && !!SCAN_DIR && existsSync(SCAN_DIR) && !!OUT_FILE;
const token = CancellationToken.None;

/** Every `.rules` file under a tree, the corpus the probes are drawn from. */
const rulesFiles = (root: string): string[] => {
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

/** A single-line text span an AST node occupies, the ground truth a highlight range must sit inside. */
interface NodeSpan {
    readonly line: number;
    readonly start: number;
    readonly end: number;
}

/** Every span the document's AST occupies, identifiers included, collected depth-first. */
const nodeSpansOf = (document: AbstractNodeDocument): NodeSpan[] => {
    const spans: NodeSpan[] = [];
    const visit = (node: AbstractNode | null | undefined): void => {
        if (!node) return;
        const position = node.position;
        if (position && typeof position.line === 'number') {
            spans.push({ line: position.line, start: position.characterStart, end: position.characterEnd });
        }
        if (isGroupNode(node) || isListNode(node)) {
            visit(node.identifier);
            for (const inheritance of node.inheritance ?? []) visit(inheritance);
            for (const child of node.elements) visit(child);
        } else if (isDocumentNode(node)) {
            for (const child of node.elements) visit(child);
        } else if (isAssignmentNode(node)) {
            visit(node.left);
            visit(node.right);
        } else if (isFunctionCallNode(node)) {
            for (const argument of node.arguments) visit(argument);
        } else if (isMathExpressionNode(node)) {
            for (const element of node.elements) visit(element);
        }
    };
    visit(document);
    return spans;
};

/** One cursor placement, and the value node the cursor sits in. */
interface Probe {
    readonly node: ValueNode;
    readonly character: number;
}

/**
 * The positions to probe: every particle channel value, plus a spread of the file's references, each
 * probed twice. The last character sits on the name a path ends with, which is the case the reader
 * hits most, and the first sits on the sigil, which is where the server is expected to decline.
 */
const probesOf = (document: AbstractNodeDocument): Probe[] => {
    const probes: Probe[] = [...particleChannelsOf(document)].map((channel) => ({
        node: channel.node,
        character: channel.node.position.characterStart + 1,
    }));
    const references = [...referenceNodesOf(document)];
    const step = Math.max(1, Math.ceil(references.length / PROBES_PER_FILE));
    for (let i = 0; i < references.length; i += step) {
        const node = references[i];
        probes.push({ node, character: node.position.characterStart });
        probes.push({ node, character: Math.max(node.position.characterStart, node.position.characterEnd - 1) });
    }
    return probes;
};

/** The report fields naming where a probe was placed. */
const positionOf = (file: string, position: { line: number; character: number }) => ({
    file,
    line: position.line,
    character: position.character,
});

describe.skipIf(!HAVE)('documentHighlight over a real corpus', () => {
    it('holds its invariants at every probe', { timeout: 60 * 60 * 1000 }, async () => {
        globalSettings.cosmoteerPath = DATA_DIR;
        const noop: WorkDoneProgressReporter = { begin: () => undefined, report: () => undefined, done: () => undefined };
        const service = CosmoteerWorkspaceService.instance;
        service.setConnection({
            languages: { diagnostics: { refresh: () => undefined } },
            window: { showWarningMessage: () => undefined },
        } as unknown as Connection);
        await service.initialize(DATA_DIR, noop);

        type Violation = { file: string; line: number; character: number; kind: string; detail: string };
        const violations: Violation[] = [];
        const files = rulesFiles(SCAN_DIR);
        let probeCount = 0;
        let answered = 0;
        let declined = 0;
        const started = Date.now();

        for (const file of files) {
            const rel = relative(SCAN_DIR, file).replace(/\\/g, '/');
            let document: AbstractNodeDocument;
            try {
                document = parser(lexer(readFileSync(file, 'utf8')), pathToFileURL(file).href).value;
            } catch (e) {
                violations.push({ file: rel, line: 0, character: 0, kind: 'parse-crash', detail: String(e) });
                continue;
            }
            const spans = nodeSpansOf(document);
            for (const probe of probesOf(document)) {
                const position = { line: probe.node.position.line, character: probe.character };
                probeCount++;
                let highlights: DocumentHighlight[] | null;
                try {
                    highlights = await documentHighlightsAt(document, position, true, undefined, token);
                } catch (e) {
                    violations.push({ ...positionOf(rel, position), kind: 'throw', detail: String(e) });
                    continue;
                }
                if (highlights === null) {
                    declined++;
                    continue;
                }
                answered++;
                if (highlights.length === 0) {
                    violations.push({ ...positionOf(rel, position), kind: 'empty-list', detail: 'answered []' });
                    continue;
                }
                for (const highlight of highlights) {
                    const { start, end } = highlight.range;
                    if (start.line !== end.line) {
                        violations.push({ ...positionOf(rel, position), kind: 'multi-line', detail: JSON.stringify(highlight.range) });
                        continue;
                    }
                    const known = spans.some(
                        (span) => span.line === start.line && span.start <= start.character && span.end >= end.character
                    );
                    if (!known) {
                        violations.push({ ...positionOf(rel, position), kind: 'unknown-range', detail: JSON.stringify(highlight.range) });
                    }
                }
                const covers = highlights.some(
                    (highlight) =>
                        highlight.range.start.line === probe.node.position.line &&
                        highlight.range.start.character >= probe.node.position.characterStart &&
                        highlight.range.end.character <= probe.node.position.characterEnd
                );
                if (!covers) {
                    violations.push({
                        ...positionOf(rel, position),
                        kind: 'cursor-not-covered',
                        detail: String(probe.node.valueType.value),
                    });
                }
            }
        }

        const report = {
            scanRoot: SCAN_DIR,
            files: files.length,
            probes: probeCount,
            answered,
            declined,
            elapsedMs: Date.now() - started,
            violations,
        };
        writeFileSync(OUT_FILE, JSON.stringify(report, null, 2), 'utf8');
        expect(violations).toEqual([]);
    });
});
