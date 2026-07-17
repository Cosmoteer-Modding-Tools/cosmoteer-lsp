import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { FullNavigationStrategy } from '../../../src/features/navigation/full.navigation-strategy';
import { isListNode, isAssignmentNode, isGroupNode } from '../../../src/core/ast/ast';
import { findReferenceNode, parseFixture } from '../../helpers';

// Characterization tests for in-file reference navigation. These pin the current
// behavior of FullNavigationStrategy so the unified resolver (Phase 2) must match.
const nav = new FullNavigationStrategy();
const token = CancellationToken.None;

describe('FullNavigationStrategy: in-file references', () => {
    it('resolves &~/_Black/0 to element 0 of the document-level _Black list', async () => {
        const doc = parseFixture('colors.rules');
        const node = findReferenceNode(doc, '&~/_Black/0');
        const result = await nav.navigate(String(node.valueType.value), node, doc.uri, token);
        // _Black = [0, 0, 0, 255] -> element 0 is the Number 0.
        expect(result).toBeTruthy();
        expect(result && 'valueType' in result && (result as { valueType: { value: unknown } }).valueType.value).toBe(
            0
        );
    });

    it('resolves &../RGBA/0 (relative parent) to the RGBA list first element', async () => {
        const doc = parseFixture('colors.rules');
        const node = findReferenceNode(doc, '&../RGBA/0');
        const result = await nav.navigate(String(node.valueType.value), node, doc.uri, token);
        expect(result).toBeTruthy();
    });

    it('returns null for an unknown identifier', async () => {
        const doc = parseFixture('colors.rules');
        const someRef = findReferenceNode(doc, '&../RGBA/0');
        const result = await nav.navigate('&DoesNotExist', someRef, doc.uri, token);
        expect(result).toBeNull();
    });

    it('sanity: colors.rules exposes the expected top-level identifiers', () => {
        const doc = parseFixture('colors.rules');
        const names = doc.elements
            .map((el) => {
                if (isAssignmentNode(el)) return el.left.name;
                if (isGroupNode(el) || isListNode(el)) return el.identifier?.name;
                return undefined;
            })
            .filter(Boolean);
        expect(names).toContain('_Black');
        expect(names).toContain('Black');
    });
});
