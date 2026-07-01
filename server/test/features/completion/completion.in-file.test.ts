import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { ReferenceAutoCompletionStrategy } from '../../../src/features/completion/strategy/reference.autocompletion-strategy';
import { ValueNode } from '../../../src/core/ast/ast';
import { findReferenceNode, parseFixture } from '../../helpers';

// Characterization tests for reference autocompletion in workspace-free contexts.
const strategy = new ReferenceAutoCompletionStrategy();
const token = CancellationToken.None;

const emptyReferenceNode = (): ValueNode => ({
    type: 'Value',
    valueType: { type: 'Reference', value: '' },
    position: { line: 0, characterStart: 0, characterEnd: 0, start: 0, end: 0 },
});

describe('ReferenceAutoCompletionStrategy — in-file', () => {
    it('offers the static root reference prefixes for an empty, non-inheritance reference', async () => {
        const result = await strategy.complete({
            node: emptyReferenceNode(),
            isInheritanceNode: false,
            cancellationToken: token,
        });
        expect(result).toEqual(['&', '&<', '&~/', '&../', '&/', '&<./Data/']);
    });

    it('offers inheritance-context prefixes for an empty inheritance reference', async () => {
        const result = await strategy.complete({
            node: emptyReferenceNode(),
            isInheritanceNode: true,
            cancellationToken: token,
        });
        expect(result).toEqual(['/', '<./Data', '..', '~', '<']);
    });

    it('produces stable completions for a mid-path relative reference (&../RGBA/0)', async () => {
        const doc = parseFixture('colors.rules');
        const node = findReferenceNode(doc, '&../RGBA/0');
        const result = await strategy.complete({ node, isInheritanceNode: false, cancellationToken: token });
        // Snapshot the current behavior — this is the contract the unified resolver must preserve.
        expect(result.sort()).toMatchSnapshot();
    });
});
