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

describe('ReferenceAutoCompletionStrategy: in-file', () => {
    it('offers the static root reference prefixes for an empty, non-inheritance reference', async () => {
        const result = await strategy.complete({
            node: emptyReferenceNode(),
            isInheritanceNode: false,
            cancellationToken: token,
        });
        expect(result).toEqual(['&', '&<', '&~/', '&../', '&/', '&<./Data/', '&:/']);
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
        // Snapshot the current behavior. This is the contract the unified resolver must preserve.
        expect(result.sort()).toMatchSnapshot();
    });

    // The completer must complete the segment at the cursor, using `valueUpToCursor`, not the whole
    // written value. Without this, editing a middle segment of a long reference path resolved the
    // entire (possibly broken) path and offered the same stale suggestion at every cursor position,
    // the bug behind a `…/Components/CommonReloadTimerHEZ/CommonReloadTimerHE/…` completion loop. The
    // node's own value is the full path. Each case passes a different prefix as if the cursor sat there.
    describe('completes the segment at the cursor (valueUpToCursor)', () => {
        const doc = parseFixture('colors.rules');
        const node = findReferenceNode(doc, '&../RGBA/0');

        it('offers the parent container members when the cursor is right after `&../`', async () => {
            const result = await strategy.complete({
                node,
                isInheritanceNode: false,
                cancellationToken: token,
                valueUpToCursor: '&../',
            });
            expect(result).toEqual(expect.arrayContaining(['RGBA', 'RGB', 'Float']));
        });

        it('completes a deeper segment (`&../RGBA/`), not the parent members, when the cursor moves in', async () => {
            const result = await strategy.complete({
                node,
                isInheritanceNode: false,
                cancellationToken: token,
                valueUpToCursor: '&../RGBA/',
            });
            // One segment deeper than `&../`, so the parent-level members must not appear. The
            // completed segment tracks the cursor rather than the whole written value.
            expect(result).not.toContain('RGB');
            expect(result).not.toContain('Float');
        });

        it('resolves a mid-path member case-insensitively, like navigation (`&../float/`)', async () => {
            // `float` (written `Float`) must resolve so its members are listed. Go-to-def/hover resolve
            // it, and completion has to agree (stepIntoNode does exact-then-lowercase member lookup).
            const lower = await strategy.complete({
                node,
                isInheritanceNode: false,
                cancellationToken: token,
                valueUpToCursor: '&../float/',
            });
            expect(lower).toEqual(expect.arrayContaining(['Rf', 'Gf', 'Bf', 'Af']));
        });

        it('filters the offered members by a lower-case prefix (`&../fl` → Float)', async () => {
            const result = await strategy.complete({
                node,
                isInheritanceNode: false,
                cancellationToken: token,
                valueUpToCursor: '&../fl',
            });
            expect(result).toContain('Float');
        });

        it('differs from completing the whole written value (the cursor-unaware behaviour)', async () => {
            const atContainer = await strategy.complete({
                node,
                isInheritanceNode: false,
                cancellationToken: token,
                valueUpToCursor: '&../',
            });
            const wholeValue = await strategy.complete({ node, isInheritanceNode: false, cancellationToken: token });
            // The whole value `&../RGBA/0` resolves past the container, so it never offers the
            // container's own members, proving the cursor position changes the answer.
            expect(atContainer).toEqual(expect.arrayContaining(['RGBA', 'RGB', 'Float']));
            expect(wholeValue).not.toEqual(atContainer);
        });
    });
});
