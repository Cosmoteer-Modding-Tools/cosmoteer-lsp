import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { FullNavigationStrategy } from '../../../src/features/navigation/full.navigation-strategy';
import { AbstractNode, AbstractNodeDocument, isGroupNode, isValueNode, ValueNode } from '../../../src/core/ast/ast';
import { parseFilePath } from '../../../src/utils/ast.utils';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { readFileSync } from 'fs';
import { initWorkspace, workspaceFile } from '../../workspace-helper';
import { walkAst } from '../../helpers';

// Regression for an AtlasSprite-style cross-file reference into a LIST element
// (`&<file>/…/DamageLevels/0`), in a source file that also contains `floor((&ref) * (&ref))`
// math. Before the function-call parse fixes that math corrupted the source file's AST, so the
// reference below silently resolved to null (the real Star-Wars-A-Cosmos-Divided armor part bug).
const nav = new FullNavigationStrategy();
const token = CancellationToken.None;

describe('cross-file reference into a list element (AtlasSprite regression)', () => {
    let docSource: AbstractNodeDocument;
    beforeAll(async () => {
        await initWorkspace();
        docSource = await parseFilePath(workspaceFile('atlas_source.rules'));
    });

    it('parses the math-heavy source file without errors', () => {
        const src = readFileSync(workspaceFile('atlas_source.rules'), 'utf-8');
        expect(parser(lexer(src), 'file:///atlas_source.rules').parserErrors).toEqual([]);
    });

    it('resolves the AtlasSprite reference to the DamageLevels[0] group (not null)', async () => {
        let ref: ValueNode | undefined;
        for (const node of walkAst(docSource as AbstractNode)) {
            if (isValueNode(node) && node.valueType.type === 'Reference' && String(node.valueType.value).includes('DamageLevels')) {
                ref = node;
                break;
            }
        }
        expect(ref, 'AtlasSprite reference node should parse').toBeDefined();
        const result = await nav.navigate(String(ref!.valueType.value), ref!, workspaceFile('atlas_source.rules'), token);
        expect(result).not.toBeNull();
        expect(isGroupNode(result as AbstractNode)).toBe(true);
    });
});
