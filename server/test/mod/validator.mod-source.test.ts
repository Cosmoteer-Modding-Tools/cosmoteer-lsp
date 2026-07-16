import { beforeAll, describe, expect, it } from 'vitest';
import { join } from 'path';
import { CancellationToken } from 'vscode-languageserver';
import { ValidationForValue } from '../../src/features/diagnostics/validator.value';
import { AbstractNode, isListNode, isGroupNode, isValueNode, ValueNode } from '../../src/core/ast/ast';
import { parseFilePath } from '../../src/utils/ast.utils';
import { clearModRootCache } from '../../src/mod/mod-root';
import { invalidateModContext } from '../../src/mod/mod-context';
import { globalSettings } from '../../src/settings';
import { initWorkspace, WORKSPACE_DATA_DIR } from '../workspace-helper';
import { FIXTURES_DIR } from '../helpers';

const token = CancellationToken.None;

const collectValues = (node: AbstractNode, out: ValueNode[] = []): ValueNode[] => {
    if (isValueNode(node)) out.push(node);
    const n = node as unknown as {
        elements?: AbstractNode[];
        inheritance?: AbstractNode[];
        left?: AbstractNode;
        right?: AbstractNode;
    };
    if (isGroupNode(node) || isListNode(node) || node.type === 'Document')
        [...(n.elements ?? []), ...(n.inheritance ?? [])].forEach((c) => collectValues(c, out));
    if (n.left) collectValues(n.left, out);
    if (n.right) collectValues(n.right, out);
    return out;
};

describe('generic validation of mod.rules SOURCES (the wholesale skip is gone)', () => {
    let byValue: Map<string, string | undefined>;

    beforeAll(async () => {
        await initWorkspace();
        globalSettings.cosmoteerPath = WORKSPACE_DATA_DIR;
        clearModRootCache();
        invalidateModContext();
        const doc = await parseFilePath(join(FIXTURES_DIR, 'mod', 'mod_sources.rules'));
        byValue = new Map();
        for (const value of collectValues(doc)) {
            const diagnostic = await ValidationForValue.callback(value, token);
            byValue.set(String(value.valueType.value), diagnostic?.message);
        }
    });

    it('validates a SOURCE reference that resolves mod-relative (no error)', () => {
        expect(byValue.get('&<provider.rules>/Provider')).toBeUndefined();
    });

    it('flags a SOURCE reference that does not resolve', () => {
        expect(byValue.get('&<nonexistent.rules>/Provider')).toBe('Reference name is not known');
    });

    it('does not flag a quoted action TARGET (`<a.rules>`): validated against the game root instead', () => {
        expect(byValue.has('<a.rules>')).toBe(true);
        expect(byValue.get('<a.rules>')).toBeUndefined();
    });

    it('does not flag the manifest metadata (Logo asset resolves; ID/Name are plain strings)', () => {
        expect(byValue.get('logo.png')).toBeUndefined();
        expect(byValue.get('author.testmod')).toBeUndefined();
    });
});
