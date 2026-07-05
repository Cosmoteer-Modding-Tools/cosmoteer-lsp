import { describe, expect, it } from 'vitest';
import { formatShaderDocument } from '../../../src/features/formatting/shader-formatter';

const tabs = { tabSize: 4, insertSpaces: false };
const format = (text: string) => formatShaderDocument(text, tabs);

describe('.shader formatter', () => {
    it('re-indents by brace depth', () => {
        const input = 'float4 main()\n{\nreturn x;\n}\n';
        expect(format(input)).toBe('float4 main()\n{\n\treturn x;\n}\n');
    });

    it('handles nested blocks and dedents the closing brace line', () => {
        const input = 'void f()\n{\nif (a)\n{\nb();\n}\n}\n';
        expect(format(input)).toBe('void f()\n{\n\tif (a)\n\t{\n\t\tb();\n\t}\n}\n');
    });

    it('keeps preprocessor directives at column 0', () => {
        const input = 'void f()\n{\n    #include "common.hlsl"\nx();\n}\n';
        expect(format(input)).toBe('void f()\n{\n#include "common.hlsl"\n\tx();\n}\n');
    });

    it('indents wrapped argument lists one extra level', () => {
        const input = 'float x = foo(a,\nb);\n';
        expect(format(input)).toBe('float x = foo(a,\n\tb);\n');
    });

    it('never touches spacing inside a line', () => {
        expect(format('float  x=a+b;\n')).toBe('float  x=a+b;\n');
    });

    it('ignores braces inside strings and comments', () => {
        const input = 'a = "{";\n// {\nb = 1;\n';
        expect(format(input)).toBe(input);
    });

    it('preserves block-comment interiors verbatim', () => {
        const input = '/*\n   art {\n      more }\n*/\nx = 1;\n';
        expect(format(input)).toBe(input);
    });

    it('preserves macro continuation lines verbatim', () => {
        const input = '#define M(a) \\\n    (a + 1)\nx = 1;\n';
        expect(format(input)).toBe(input);
    });

    it('trims trailing whitespace, caps blank runs and normalizes the final newline', () => {
        expect(format('x = 1;   \n\n\n\n\ny = 2;')).toBe('x = 1;\n\n\ny = 2;\n');
    });

    it('preserves CRLF line endings', () => {
        expect(format('void f()\r\n{\r\nx();\r\n}\r\n')).toBe('void f()\r\n{\r\n\tx();\r\n}\r\n');
    });

    it('is idempotent', () => {
        const input = 'void f()\n{\nif (a) {\nb(c,\nd);\n}\n}\n';
        const once = format(input);
        expect(format(once)).toBe(once);
    });
});
