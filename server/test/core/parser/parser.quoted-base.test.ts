import { describe, expect, it } from 'vitest';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { GroupNode, ListNode, isGroupNode, isListNode } from '../../../src/core/ast/ast';

// The game reads a base reference through `Validator.ValidatePath`, and quotes there are only the
// delimiter around the one path: `Part : "A"` and `Part : A` build the same node (executed against
// Halfling.ObjectText in HalflingCore.dll). We used to admit only the bare form, so a quoted base
// cost a parse error, dropped the member and left the body as an anonymous group.
const URI = 'file:///c%3A/mod/test.rules';

const parse = (src: string) => parser(lexer(src), URI);

const basesOf = (node: GroupNode | ListNode): string[] =>
    (node.inheritance ?? []).map((entry) => String(entry.valueType.value));

describe('a quoted inheritance base', () => {
    it('parses like the bare form', () => {
        const bare = parse('Part : A\n{\n\tID = x\n}\n');
        const quoted = parse('Part : "A"\n{\n\tID = x\n}\n');
        expect(quoted.parserErrors).toEqual([]);
        const group = quoted.value.elements.find(isGroupNode)!;
        expect(group.identifier?.name).toBe('Part');
        expect(basesOf(group)).toEqual(['&A']);
        expect(basesOf(bare.value.elements.find(isGroupNode)!)).toEqual(['&A']);
    });

    it('keeps the members that follow it', () => {
        const result = parse('Part : "A"\n{\n\tID = x\n}\nName = y\n');
        expect(result.parserErrors).toEqual([]);
        expect(result.value.elements.filter(isGroupNode)).toHaveLength(1);
    });

    it('reads several quoted bases, one per line', () => {
        const result = parse('Part : "A"\n"B"\n{\n\tID = x\n}\n');
        expect(result.parserErrors).toEqual([]);
        expect(basesOf(result.value.elements.find(isGroupNode)!)).toEqual(['&A', '&B']);
    });

    it('mixes a quoted base with a bare one across a comma', () => {
        const result = parse('Part : "A", B\n{\n\tID = x\n}\n');
        expect(result.parserErrors).toEqual([]);
        expect(basesOf(result.value.elements.find(isGroupNode)!)).toEqual(['&A', '&B']);
    });

    it('works on a list body', () => {
        const result = parse('L : "A"\n[\n\t1\n]\n');
        expect(result.parserErrors).toEqual([]);
        expect(basesOf(result.value.elements.find(isListNode)!)).toEqual(['&A']);
    });

    it('works after the `=` the game also accepts before the `:`', () => {
        const result = parse('Part = : "A"\n{\n\tID = x\n}\n');
        expect(result.parserErrors).toEqual([]);
    });

    it('still reports the missing body exactly once', () => {
        const quoted = parse('Actions : "Base"\nID = x\n');
        const bare = parse('Actions : Base\nID = x\n');
        expect(quoted.parserErrors).toHaveLength(bare.parserErrors.length);
    });
});
