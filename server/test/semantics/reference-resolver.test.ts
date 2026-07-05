import { describe, expect, it } from 'vitest';
import { stepIntoNode } from '../../src/semantics/reference-resolver';
import { isListNode, isAssignmentNode, isGroupNode } from '../../src/core/ast/ast';
import { parseFixture } from '../helpers';

// Direct unit tests for the canonical single-step navigation shared by the
// navigation and (where applicable) completion strategies.
describe('stepIntoNode', () => {
    const doc = parseFixture('colors.rules');
    const black = doc.elements.find((e) => (isGroupNode(e) || isListNode(e)) && e.identifier?.name === 'Black')!;

    it('resolves a named child of a group to the assignment right-hand side', () => {
        const rgba = stepIntoNode(black, 'RGBA');
        expect(rgba && isListNode(rgba)).toBe(true);
    });

    it('resolves `..` to the parent', () => {
        expect(stepIntoNode(black, '..')).toBe(black.parent);
    });

    it('resolves `~` to the document root', () => {
        expect(stepIntoNode(black, '~')).toBe(doc);
    });

    it('resolves a numeric segment on a list to the element at that index', () => {
        const blackSetter = doc.elements.find((e) => isAssignmentNode(e) && e.left.name === '_Black')!;
        const arr = isAssignmentNode(blackSetter) ? blackSetter.right : undefined;
        expect(arr && isListNode(arr)).toBe(true);
        const first = stepIntoNode(arr!, '0');
        expect(first && 'valueType' in first && (first as { valueType: { value: unknown } }).valueType.value).toBe(0);
    });

    it('returns null for an unknown named child', () => {
        expect(stepIntoNode(black, 'Nope')).toBeNull();
    });
});
