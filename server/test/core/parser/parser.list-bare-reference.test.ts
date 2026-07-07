import { describe, expect, it } from 'vitest';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { GroupNode, IdentifierNode, isGroupNode, isListNode, ListNode } from '../../../src/core/ast/ast';

// Inside a list the game never attaches a following `{`/`[`/`:` to a bare `&…` reference
// element (verified against Halfling.ObjectText: the reference stays its own
// OTListedReferenceNode and the `{`/`:` opens a separate anonymous element). Our parser used
// to glue them into one named/inherited group, which both desynced the structure and hid the
// bare reference from validation. The parser classifies a bare reference as an IdentifierNode
// only when the preceding sibling is not a value (e.g. right after a `}`), so every case here
// leads with a group sibling. In a group, gluing is correct: the game DOES attach a next-line
// `:`/`{` to the preceding name.
const parse = (src: string) => parser(lexer(src), 'file:///t.rules');

const firstList = (src: string): ListNode => {
    const result = parse(src);
    const list = result.value.elements.find(isListNode);
    if (!list) throw new Error('no list parsed');
    return list;
};

describe('bare reference elements in lists', () => {
    it('keeps a bare reference standalone when a colon element follows on a later line', () => {
        const list = firstList('L\n[\n\t{\n\t\tA = 1\n\t}\n\t&/PARTICLES/Foo\n\t: /BASE/X\n\t{\n\t\tSound = b.wav\n\t}\n]\n');
        expect(list.elements).toHaveLength(3);
        expect((list.elements[1] as IdentifierNode).name).toBe('&/PARTICLES/Foo');
        const third = list.elements[2] as GroupNode;
        expect(isGroupNode(third)).toBe(true);
        expect(third.identifier).toBeUndefined();
        expect(third.inheritance?.[0]?.valueType.value).toBe('/BASE/X');
    });

    it('keeps a bare reference standalone when a comment separates it from the colon element', () => {
        const list = firstList(
            'L\n[\n\t{\n\t\tA = 1\n\t}\n\t&/PARTICLES/Foo\n/*\n\t: /OLD\n*/\n\t: /BASE/X\n\t{\n\t\tX = 1\n\t}\n]\n'
        );
        expect(list.elements).toHaveLength(3);
        expect((list.elements[1] as IdentifierNode).name).toBe('&/PARTICLES/Foo');
        expect((list.elements[2] as GroupNode).inheritance?.[0]?.valueType.value).toBe('/BASE/X');
    });

    it('keeps a bare reference standalone when a group follows on a later line', () => {
        const list = firstList('L\n[\n\t{\n\t\tA = 1\n\t}\n\t&/PARTICLES/Foo\n\t{\n\t\tX = 1\n\t}\n]\n');
        expect(list.elements).toHaveLength(3);
        expect((list.elements[1] as IdentifierNode).name).toBe('&/PARTICLES/Foo');
        expect((list.elements[2] as GroupNode).identifier).toBeUndefined();
    });

    it('keeps a plain NAME standalone when a group follows on a later line (game: text element + anonymous group)', () => {
        const list = firstList('L\n[\n\tFoo\n\t{\n\t\tX = 1\n\t}\n]\n');
        expect(list.elements).toHaveLength(2);
        const second = list.elements[1] as GroupNode;
        expect(isGroupNode(second)).toBe(true);
        expect(second.identifier).toBeUndefined();
    });

    it('keeps a plain NAME standalone when a colon element follows on a later line', () => {
        const list = firstList('L\n[\n\tFoo\n\t: /BASE/X\n\t{\n\t\tX = 1\n\t}\n]\n');
        expect(list.elements).toHaveLength(2);
        const second = list.elements[1] as GroupNode;
        expect(second.identifier).toBeUndefined();
        expect(second.inheritance?.[0]?.valueType.value).toBe('/BASE/X');
    });

    it('still glues a next-line colon to a NAME inside a group (game inheritance shape)', () => {
        const result = parse('Parent\n{\n\tChild\n\t: ../Base\n\t{\n\t\tX = 1\n\t}\n}\nBase\n{\n}\n');
        const parent = result.value.elements.find(isGroupNode) as GroupNode;
        const child = parent.elements.find((e) => isGroupNode(e)) as GroupNode;
        expect(child.identifier?.name).toBe('Child');
        expect(child.inheritance?.[0]?.valueType.value).toBe('../Base');
    });
});

// The game accepts a bare `&…` reference only as a list element or a field value. In group or
// document position Halfling.ObjectText throws `Unexpected "&"` and the whole file fails to
// load, so the parser reports a parse error there (and only there).
describe('bare reference members outside lists are a parse error', () => {
    const standaloneErrors = (src: string) =>
        parse(src).parserErrors.filter((e) => e.message === 'The game cannot read a standalone reference here');

    it('flags a bare reference member of a group', () => {
        expect(standaloneErrors('G\n{\n\tA = 1\n\t&/PARTICLES/Foo\n}\n')).toHaveLength(1);
    });

    it('flags a bare file include member of a group', () => {
        expect(standaloneErrors('G\n{\n\tA = 1\n\t&<other.rules>\n}\n')).toHaveLength(1);
    });

    it('flags a bare reference at document level', () => {
        expect(standaloneErrors('A = 1\n&/PARTICLES/Foo\nB = 2\n')).toHaveLength(1);
    });

    it('flags a bare reference that heads a body inside a group', () => {
        expect(standaloneErrors('G\n{\n\t&/PARTICLES/Foo\n\t{\n\t\tX = 1\n\t}\n}\n')).toHaveLength(1);
    });

    it('does not flag a bare reference list element', () => {
        expect(standaloneErrors('L\n[\n\t{\n\t\tX = 1\n\t}\n\t&/PARTICLES/Foo\n]\n')).toHaveLength(0);
        expect(standaloneErrors('L\n[\n\t&/PARTICLES/Foo\n]\n')).toHaveLength(0);
    });

    it('does not flag a reference used as a field value', () => {
        expect(standaloneErrors('G\n{\n\tA = &/PARTICLES/Foo\n}\n')).toHaveLength(0);
    });
});
