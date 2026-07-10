import { afterEach, describe, expect, it } from 'vitest';
import { stepIntoNode, registerInheritanceExtensionSource } from '../../src/semantics/reference-resolver';
import { AbstractNode, isListNode, isAssignmentNode, isGroupNode } from '../../src/core/ast/ast';
import { lexer } from '../../src/core/lexer/lexer';
import { parser } from '../../src/core/parser/parser';
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

// `^/N` reads the node's own inheritance list first, then the bases a mod's AddBase action appends,
// supplied by the registered extension source (the AddBaseIndex in production). This keeps navigation,
// validation, hover and completion resolving an added base identically.
describe('stepIntoNode inheritance extension (AddBase)', () => {
    const doc = parser(lexer('Base\n{\n\tX = 1\n}\nDerived : Base\n{\n\tY = 2\n}\n'), 'file:///t.rules').value;
    const derived = doc.elements.find((e) => (isGroupNode(e) || isListNode(e)) && e.identifier?.name === 'Derived')!;

    afterEach(() => registerInheritanceExtensionSource(undefined));

    it('returns the written inheritance entry for an in-range index', () => {
        const base = stepIntoNode(derived, '0', true);
        expect(base && 'valueType' in base).toBe(true); // the `&Base` inheritance reference
    });

    it('returns undefined past the written list when no source is registered', () => {
        expect(stepIntoNode(derived, '1', true)).toBeUndefined();
    });

    it('consults the registered source for an index past the written list', () => {
        const appended = doc.elements[0] as AbstractNode; // stand-in for an AddBase-appended base
        registerInheritanceExtensionSource((node, extraIndex) =>
            node === derived && extraIndex === 0 ? appended : undefined
        );
        expect(stepIntoNode(derived, '1', true)).toBe(appended);
        // The written entry at slot 0 is still returned from the node's own list, not the source.
        expect(stepIntoNode(derived, '0', true)).not.toBe(appended);
    });
});
