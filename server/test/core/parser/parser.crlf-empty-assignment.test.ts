import { describe, expect, it } from 'vitest';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { GroupNode, isGroupNode } from '../../../src/core/ast/ast';

const parse = (src: string) => parser(lexer(src), 'file:///t.rules');

/**
 * An in-progress empty assignment (`Type = ` with the value still untyped) must not desync the
 * parser, regardless of line endings. The CRLF form is what a real editor buffer holds on Windows
 * the moment a completion snippet scaffolds `Type = ` or the user deletes a value, and a desync
 * there breaks every schema feature until the value is typed again.
 */
describe('empty assignment value at end of line', () => {
    for (const [name, eol] of [
        ['LF', '\n'],
        ['CRLF', '\r\n'],
    ] as const) {
        it(`keeps the structure intact with ${name} endings`, () => {
            const src = ['Components', '{', '\tFoo', '\t{', '\t\tType = ', '\t}', '\tBar', '\t{', '\t}', '}', ''].join(eol);
            const result = parse(src);
            expect(result.parserErrors).toEqual([]);
            const document = result.value;
            expect(document.elements).toHaveLength(1);
            const components = document.elements[0] as GroupNode;
            expect(isGroupNode(components)).toBe(true);
            const members = components.elements.filter(isGroupNode).map((group) => group.identifier?.name);
            expect(members).toEqual(['Foo', 'Bar']);
        });
    }
});
