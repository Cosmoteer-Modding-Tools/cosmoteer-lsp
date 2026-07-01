import { readFileSync } from 'fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { ValidationForValue } from '../../../src/features/diagnostics/validator.value';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { AbstractNodeDocument, isValueNode, ValueNode } from '../../../src/core/ast/ast';
import { globalSettings } from '../../../src/settings';
import { findReferenceNode, walkAst } from '../../helpers';
import { initWorkspace, WORKSPACE_DATA_DIR, workspaceFile } from '../../workspace-helper';

const token = CancellationToken.None;
const ASSETS_URI = workspaceFile('effects', 'assets.rules').replace(/\\/g, '/');

const assetNode = (doc: AbstractNodeDocument, value: string): ValueNode => {
    for (const node of walkAst(doc)) {
        if (isValueNode(node) && 'value' in node.valueType && node.valueType.value === value) return node;
    }
    throw new Error(`No value node found for "${value}"`);
};

describe('did-you-mean diagnostics', () => {
    beforeAll(async () => {
        await initWorkspace();
        globalSettings.cosmoteerPath = WORKSPACE_DATA_DIR;
    });

    describe('references', () => {
        const validate = (src: string, reference: string) =>
            ValidationForValue.callback(findReferenceNode(parser(lexer(src), 'file:///refs.rules').value, reference), token);

        it('suggests the closest in-scope name for a typo and offers a quick fix', async () => {
            const error = await validate('Root = 1\nProhibitedBy = 5\nBad = &PrhibitedBy\n', '&PrhibitedBy');
            expect(error?.message).toBe('Reference name is not known');
            expect(error?.additionalInfo).toContain('Did you mean');
            expect(error?.additionalInfo).toContain('ProhibitedBy');
            expect(error?.data?.quickFix?.newText).toBe('&ProhibitedBy');
            expect(error?.data?.quickFix?.title).toContain('ProhibitedBy');
        });

        it('omits a suggestion when nothing in scope is close', async () => {
            const error = await validate('Root = 1\nBad = &Zzzzzzzzz\n', '&Zzzzzzzzz');
            expect(error?.message).toBe('Reference name is not known');
            expect(error?.additionalInfo).not.toContain('Did you mean');
            expect(error?.data).toBeUndefined();
        });
    });

    describe('assets', () => {
        let doc: AbstractNodeDocument;
        beforeAll(() => {
            doc = parser(lexer(readFileSync(ASSETS_URI, 'utf-8')), ASSETS_URI).value;
        });

        it('suggests the closest existing filename for a typo and offers a quick fix', async () => {
            const error = await ValidationForValue.callback(assetNode(doc, 'sparkk.png'), token);
            expect(error?.message).toBe('Asset not found');
            expect(error?.additionalInfo).toContain('Did you mean');
            expect(error?.additionalInfo).toContain('spark.png');
            expect(error?.data?.quickFix?.newText).toBe('spark.png');
        });

        it('does not flag an asset that exists', async () => {
            expect(await ValidationForValue.callback(assetNode(doc, 'spark.png'), token)).toBeUndefined();
        });
    });
});
