import { describe, expect, it } from 'vitest';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { isAssignmentNode } from '../../../src/core/ast/ast';

// ObjectText treats `,` exactly like `;` as a node terminator (OTGroupedReferenceNode/-FieldNode
// consume either into `_terminator`, verified by decompiling HalflingCore.dll). Our document loop
// used to consume only `;`, so `A = 1, C = 2` on one line reported a bogus "Not expected comma".
const parse = (src: string) => parser(lexer(src), 'file:///t.rules');

describe('comma as a top-level field terminator', () => {
    it('parses two comma-terminated assignments on one line without errors', () => {
        const result = parse('A = 1, C = 2');
        expect(result.parserErrors).toEqual([]);
        const names = result.value.elements.filter(isAssignmentNode).map((a) => a.left.name);
        expect(names).toEqual(['A', 'C']);
    });

    it('parses comma-terminated reference assignments on one line without errors', () => {
        const result = parse('A = &B, C = &B\nB = 4');
        expect(result.parserErrors).toEqual([]);
        const names = result.value.elements.filter(isAssignmentNode).map((a) => a.left.name);
        expect(names).toEqual(['A', 'C', 'B']);
    });

    it('does not bind a comma-terminated entry to the following group', () => {
        // Like the void-`;` rule: after `A = 1,` the group `Bar { … }` must own its own identifier.
        const result = parse('A = 1, Bar\n{\n\tX = 2\n}');
        expect(result.parserErrors).toEqual([]);
        const group = result.value.elements.find((e) => e.type === 'Group');
        expect(group && 'identifier' in group ? (group as { identifier?: { name?: string } }).identifier?.name : undefined).toBe(
            'Bar'
        );
    });
});
