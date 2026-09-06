import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import {
    AbstractNode,
    AbstractNodeDocument,
    GroupNode,
    isAssignmentNode,
    isDocumentNode,
    isGroupNode,
    isListNode,
} from '../../../src/core/ast/ast';
import { findActionsList } from '../../../src/mod/action-parser';
import { validateActionEntries } from '../../../src/features/diagnostics/validator.mod-action';
import {
    ValidationForDocumentDuplicates,
    ValidationForGroupDuplicates,
} from '../../../src/features/diagnostics/validator.duplicate-key';

// Both checks describe a file the game refuses to read, so content that ships and works cannot carry
// one. The action entry check is gated at zero. The duplicate key check already reported the exact
// spelling and now folds case, so what is gated there is that folding adds nothing: a case-only
// repeat is a real failure the game would refuse, and there is none in content that loads.
// Self-skips without the game installed. Set MODSCAN_OUT to write the findings out for triage.
const DATA_DIR = process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const STANDARD_MODS = join(DATA_DIR, '..', 'Standard Mods');
const MODS_DIR = process.env.COSMOTEER_MODS_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/workshop/content/799600';
const HAVE = existsSync(DATA_DIR);
const token = CancellationToken.None;

const rulesUnder = (root: string): string[] => {
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

/** The name a child contributes to its scope, mirroring the validator's own key reading. */
const keyOf = (node: AbstractNode): string | undefined => {
    if (isAssignmentNode(node)) return node.left.name;
    if ((isGroupNode(node) || isListNode(node)) && node.identifier) return node.identifier.name;
    return undefined;
};

/** Whether a scope repeats a key under an exact comparison, which is what the check reported before. */
const repeatsExactly = (elements: readonly AbstractNode[]): boolean => {
    const seen = new Set<string>();
    for (const element of elements) {
        const key = keyOf(element);
        if (!key) continue;
        if (seen.has(key)) return true;
        seen.add(key);
    }
    return false;
};

describe.skipIf(!HAVE)('action entries and duplicate keys over the installed content', () => {
    it('reports no unbraced action entry, and folds case without adding a duplicate finding', async () => {
        const files = [DATA_DIR, STANDARD_MODS, MODS_DIR].filter(existsSync).flatMap(rulesUnder);
        const entryHits: string[] = [];
        const caseOnlyHits: string[] = [];
        const duplicateHits: string[] = [];
        for (const file of files) {
            let text: string;
            try {
                text = readFileSync(file, 'utf8');
            } catch {
                continue;
            }
            const uri = pathToFileURL(file).toString();
            const document = parser(lexer(text), uri).value;
            if (!document) continue;
            for (const finding of validateActionEntries(findActionsList(document))) {
                entryHits.push(`${file} :: ${finding.message}`);
            }
            const scopes: (AbstractNodeDocument | GroupNode)[] = [document];
            while (scopes.length > 0) {
                const scope = scopes.pop();
                if (!scope) continue;
                const finding = isDocumentNode(scope)
                    ? await ValidationForDocumentDuplicates.callback(scope, token)
                    : await ValidationForGroupDuplicates.callback(scope, token);
                if (finding) {
                    duplicateHits.push(`${file} :: ${finding.message}`);
                    if (!repeatsExactly(scope.elements)) caseOnlyHits.push(`${file} :: ${finding.message}`);
                }
                for (const element of scope.elements) if (isGroupNode(element)) scopes.push(element);
            }
        }
        if (process.env.MODSCAN_OUT) {
            writeFileSync(process.env.MODSCAN_OUT, [...entryHits, ...duplicateHits].join('\n'), 'utf8');
        }
        expect(files.length).toBeGreaterThan(0);
        expect(entryHits).toEqual([]);
        expect(caseOnlyHits).toEqual([]);
    }, 600000);
});
