import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { pathToFileURL } from 'url';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { checkMissingFieldSeparator } from '../../../src/features/diagnostics/validator.assignment';
import { checkListElementSeparators } from '../../../src/features/diagnostics/validator.value';
import { validateRedundantSeparators } from '../../../src/features/diagnostics/validator.separator';
import {
    AbstractNode,
    AssignmentNode,
    ValueNode,
    isAssignmentNode,
    isGroupNode,
    isListNode,
    isValueNode,
} from '../../../src/core/ast/ast';

// False-positive scan of the missing-separator warnings over the whole vanilla install. Everything
// the game ships loads with the values the author intended, so a warning-level finding here is a
// false positive by definition. The redundant-separator HINT is exempt from the zero contract
// (vanilla itself ships hundreds of stylistic trailing separators); the scan only proves the pass
// runs crash-free over every shipped file. Needs the install, self-skips without it.
const DATA_DIR =
    process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const HAVE_DATA = existsSync(DATA_DIR);
const token = CancellationToken.None;

const filesUnder = (root: string): string[] => {
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

const collect = (node: AbstractNode, out: AbstractNode[] = []): AbstractNode[] => {
    out.push(node);
    if (isGroupNode(node) || isListNode(node) || node.type === 'Document') {
        for (const child of (node as unknown as { elements: AbstractNode[] }).elements) collect(child, out);
    }
    if (isAssignmentNode(node)) {
        collect(node.left, out);
        if (node.right) collect(node.right, out);
    }
    return out;
};

describe.skipIf(!HAVE_DATA)('separator diagnostics over vanilla Data', () => {
    it('missing-separator warnings: zero findings', async () => {
        const findings: string[] = [];
        let scanned = 0;
        for (const file of filesUnder(DATA_DIR)) {
            let nodes;
            try {
                nodes = collect(parser(lexer(readFileSync(file, 'utf8')), pathToFileURL(file).href).value);
            } catch {
                continue;
            }
            scanned++;
            for (const node of nodes) {
                const error = isAssignmentNode(node)
                    ? await checkMissingFieldSeparator(node as AssignmentNode, token)
                    : isValueNode(node)
                      ? await checkListElementSeparators(node as ValueNode, token)
                      : undefined;
                if (error) {
                    findings.push(`${relative(DATA_DIR, file)}:${error.node.position.line + 1}: ${error.message}`);
                }
            }
        }
        console.log(`\n[missing-separator] ${findings.length} findings over ${scanned} files\n` + findings.slice(0, 50).join('\n'));
        expect(scanned).toBeGreaterThan(900);
        expect(findings.slice(0, 30)).toEqual([]);
    }, 600_000);

    it('redundant-separator hints: crash-free over every shipped file', () => {
        let scanned = 0;
        let hints = 0;
        for (const file of filesUnder(DATA_DIR)) {
            const errors = validateRedundantSeparators(lexer(readFileSync(file, 'utf8')));
            hints += errors.length;
            scanned++;
        }
        console.log(`[redundant-separator] ${hints} hints over ${scanned} files`);
        expect(scanned).toBeGreaterThan(900);
    }, 600_000);
});
