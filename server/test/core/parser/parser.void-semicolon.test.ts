import { describe, expect, it } from 'vitest';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { isGroupNode } from '../../../src/core/ast/ast';

// ObjectText terminates a field or void entry with `;` (see the `inspect-cosmoteer-ot-format`
// skill). A standalone `;` must be a silent terminator, not an "Unknown token type" error.
const parse = (src: string) => parser(lexer(src), 'file:///vs.rules');
const messages = (src: string) => parse(src).parserErrors.map((e) => e.message);

describe('void nodes and `;` terminators', () => {
    it('accepts a value field terminated by a semicolon', () => {
        expect(messages('Bar = 1;\nBaz = 2\n')).toEqual([]);
    });

    it('accepts several semicolon-terminated fields on one line', () => {
        const result = parse('A = 1; B = 2;\n');
        expect(result.parserErrors).toEqual([]);
        expect(result.value.elements).toHaveLength(2);
    });

    it('accepts a void entry (`Foo;`) without error', () => {
        const result = parse('Foo;\nBar = 1\n');
        expect(result.parserErrors).toEqual([]);
        expect(result.value.elements).toHaveLength(2);
    });

    it('keeps a void entry separate from a following named group', () => {
        // `Foo;` is a complete void; the `;` must stop `Foo` from naming `Bar`'s group.
        const result = parse('Foo;\nBar\n{\n\tX = 1\n}\n');
        expect(result.parserErrors).toEqual([]);
        const group = result.value.elements.find(isGroupNode);
        expect(group?.identifier?.name).toBe('Bar');
    });

    it('does not regress identifier→group binding without a semicolon', () => {
        const result = parse('Bar\n{\n\tX = 1\n}\n');
        const group = result.value.elements.find(isGroupNode);
        expect(group?.identifier?.name).toBe('Bar');
    });

    it('accepts semicolons inside an inline group', () => {
        expect(messages('G { W = 1; H = 2 }\n')).toEqual([]);
    });
});
