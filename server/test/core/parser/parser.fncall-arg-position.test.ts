import { describe, expect, it } from 'vitest';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { AssignmentNode, FunctionCallNode, isAssignmentNode } from '../../../src/core/ast/ast';

/**
 * Regression: the first-argument shortcut in the function-call branch built the argument's
 * line-relative position from the function-NAME token (`ceil`) instead of the argument's own
 * token. The reference value inside `ceil((&<file>/Cost)*(&~/X))` then carried a range starting
 * at `ceil`, so the document-link underline and go-to-definition origin covered the function
 * name and stopped short of the reference's real end.
 */
describe('parser: function-call first-argument position', () => {
    const firstArgOf = (src: string): { characterStart: number; characterEnd: number; line: number } => {
        const doc = parser(lexer(src), 'file:///x.rules').value;
        const assignment = doc.elements.find((e) => isAssignmentNode(e)) as AssignmentNode;
        const call = assignment.right as FunctionCallNode;
        expect(call.type).toBe('FunctionCall');
        return call.arguments[0].position;
    };

    it('anchors a parenthesized reference argument at the reference, not the function name', () => {
        const ref = '&<../base_part.rules>/Cost';
        const src = `X = ceil((${ref})*(&~/MULT))\n`;
        const pos = firstArgOf(src);
        expect(pos.characterStart).toBe(src.indexOf('&'));
        expect(pos.characterEnd).toBe(src.indexOf(ref) + ref.length);
        expect(pos.line).toBe(0);
    });

    it('anchors a bare reference argument at the reference', () => {
        const src = 'X = ceil(&a/b)\n';
        const pos = firstArgOf(src);
        expect(pos.characterStart).toBe(src.indexOf('&'));
        expect(pos.characterEnd).toBe(src.indexOf('&') + '&a/b'.length);
    });

    it('anchors a bare number argument at the number', () => {
        const src = 'X = ceil(5.5)\n';
        const pos = firstArgOf(src);
        expect(pos.characterStart).toBe(src.indexOf('5.5'));
        expect(pos.characterEnd).toBe(src.indexOf('5.5') + '5.5'.length);
    });
});
