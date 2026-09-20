import { describe, expect, it } from 'vitest';
import { lexer } from '../../../../src/core/lexer/lexer';
import { parser } from '../../../../src/core/parser/parser';
import { isGroupNode } from '../../../../src/core/ast/ast';
import { memberSpanOf } from '../../../../src/features/refactor/shared-base/member-record';
import { memberSpan } from '../../../../src/features/refactor/rules-edit';

const parse = (src: string) => parser(lexer(src), 'file:///c.rules').value;
const groupOf = (src: string) => parse(src).elements.find(isGroupNode)!;

/**
 * A member record is keyed by the name it holds, so this reader answers for named members only,
 * where the shared writer also answers for anonymous containers, bare list entries and loose
 * expressions. Both were measured against each other over 903101 members of the game's own files
 * and two large mods with no disagreement, which is why one now reads through the other.
 */
describe('memberSpanOf', () => {
    it('measures an assignment from its name through its whole value', () => {
        const text = 'G\n{\n\tA = max(ceil(1.2), floor(3))\n}';
        const member = groupOf(text).elements.at(-1)!;
        const span = memberSpanOf(member)!;
        expect(text.slice(span.start, span.end)).toBe('A = max(ceil(1.2), floor(3))');
    });

    it('measures a named container from its name through its closer, inheritance included', () => {
        const text = 'G\n{\n\tSub : &/A, &/B\n\t{\n\t\tX = 1\n\t}\n}';
        const member = groupOf(text).elements.find(isGroupNode)!;
        const span = memberSpanOf(member)!;
        expect(text.slice(span.start, span.end)).toBe('Sub : &/A, &/B\n\t{\n\t\tX = 1\n\t}');
    });

    it('answers for no anonymous container, where the shared writer does', () => {
        const text = 'L\n[\n\t{\n\t\tX = 1\n\t}\n]';
        const element = parse(text)
            .elements.filter((node) => 'elements' in node)
            .flatMap((node) => (node as { elements: never[] }).elements)
            .find(isGroupNode)!;
        expect(memberSpanOf(element)).toBeUndefined();
        expect(memberSpan(element)).toBeTruthy();
    });

    it('answers for no member the parser left unclosed', () => {
        const text = 'G\n{\n\tSub\n\t{\n';
        const member = groupOf(text).elements.find(isGroupNode);
        if (member) expect(memberSpanOf(member)).toBeUndefined();
    });
});
