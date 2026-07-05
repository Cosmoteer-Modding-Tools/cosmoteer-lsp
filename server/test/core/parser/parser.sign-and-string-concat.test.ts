import { describe, expect, it } from 'vitest';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import {
    AbstractNode,
    AbstractNodeDocument,
    isAssignmentNode,
    isGroupNode,
    isListNode,
    isValueNode,
    ValueNode,
} from '../../../src/core/ast/ast';

/**
 * Regressions found by a deep parse-audit of all 954 vanilla files + 7822 workshop-mod files.
 * Each case is a SILENT desync: a value the parser did not fold leaked out as a sibling and
 * swallowed the following field's identifier, so a valid file produced false diagnostics and
 * broke completion/goto inside the corrupted region — with zero parser errors.
 */
const parse = (src: string): AbstractNodeDocument => parser(lexer(src), 'file:///x.rules').value;

const memberNames = (node: { elements: AbstractNode[] }): string[] =>
    node.elements.map((el) => {
        if (isGroupNode(el) || isListNode(el)) return el.identifier?.name ?? '<anon>';
        if (isAssignmentNode(el)) return el.left.name;
        return `<${el.type}>`;
    });

const groupNamed = (doc: AbstractNodeDocument, name: string) =>
    doc.elements.find((e) => isGroupNode(e) && e.identifier?.name === name) as AbstractNode & {
        elements: AbstractNode[];
    };

const rhsOf = (group: { elements: AbstractNode[] }, key: string): AbstractNode | undefined => {
    const a = group.elements.find((e) => isAssignmentNode(e) && e.left.name === key);
    return a && isAssignmentNode(a) ? a.right : undefined;
};

describe('parser: unary sign before a unit-suffixed number or word constant', () => {
    it('folds `-0.6%` and does NOT steal the following `Modifiers` list (vanilla heat.rules)', () => {
        const doc = parse('R\n{\n\tBaseValue = -0.6%\n\tModifiers\n\t[\n\t\t{ Type = X }\n\t]\n}\n');
        const r = groupNamed(doc, 'R');
        // The `Modifiers` list must keep its name — before the fix `-0.6%` leaked and stole it.
        expect(memberNames(r)).toEqual(['BaseValue', 'Modifiers']);
        const bv = rhsOf(r, 'BaseValue') as ValueNode;
        expect(isValueNode(bv) && String(bv.valueType.value)).toBe('-0.6%');
    });

    it('folds `-40%` as a single value, keeping following siblings', () => {
        const doc = parse('G\n{\n\tA = -40%\n\tB = 1\n\tNested { Inner = 2 }\n}\n');
        expect(memberNames(groupNamed(doc, 'G'))).toEqual(['A', 'B', 'Nested']);
    });

    it('folds `-Infinity` (word constant) without desync (vanilla manipulator_beam)', () => {
        const doc = parse('G\n{\n\tMinIntensity = -Infinity\n\tNext { Inner = 2 }\n}\n');
        const g = groupNamed(doc, 'G');
        expect(memberNames(g)).toEqual(['MinIntensity', 'Next']);
        expect(String((rhsOf(g, 'MinIntensity') as ValueNode).valueType.value)).toBe('-Infinity');
    });

    it('leaves positive `40%` as an ordinary single value', () => {
        const doc = parse('G\n{\n\tA = 40%\n\tB = 1\n}\n');
        expect(memberNames(groupNamed(doc, 'G'))).toEqual(['A', 'B']);
    });

    it('does NOT fold a bare `-`/`+` value across a newline into the next field (vanilla ru.rules key names)', () => {
        // `MinusUnderscore = -` is a whole value; the next line `N = ""` must survive as its own field.
        const doc = parse('Keys\n{\n\tMinusUnderscore = -\n\tN = ""\n\tPlusEquals = +\n\tO = ""\n}\n');
        expect(memberNames(groupNamed(doc, 'Keys'))).toEqual(['MinusUnderscore', 'N', 'PlusEquals', 'O']);
    });
});

describe('parser: adjacent string-literal concatenation (ObjectText C-style)', () => {
    it('joins a `\\`-continued string and keeps the following `Entries` list (vanilla heat_management)', () => {
        const src = 'Doc\n{\n\tText = "first "\\\n\t       "second"\n\tEntries\n\t[\n\t\t{ K = 1 }\n\t]\n}\n';
        const doc = parse(src);
        const g = groupNamed(doc, 'Doc');
        expect(memberNames(g)).toEqual(['Text', 'Entries']);
        expect(String((rhsOf(g, 'Text') as ValueNode).valueType.value)).toBe('first second');
    });

    it('joins two same-line adjacent string literals into one value', () => {
        const doc = parse('G\n{\n\tText = "a" "b"\n\tAfter = 1\n}\n');
        const g = groupNamed(doc, 'G');
        expect(memberNames(g)).toEqual(['Text', 'After']);
        expect(String((rhsOf(g, 'Text') as ValueNode).valueType.value)).toBe('ab');
    });

    it('does NOT join across an unsuppressed newline (a real value terminator)', () => {
        const doc = parse('G\n{\n\tA = "x"\n\tB = "y"\n}\n');
        const g = groupNamed(doc, 'G');
        expect(memberNames(g)).toEqual(['A', 'B']);
        expect(String((rhsOf(g, 'A') as ValueNode).valueType.value)).toBe('x');
    });
});

describe('parser: `: <ref>; { body }` inheritance-override list element', () => {
    // Per the game reader (Halfling.ObjectText): `;` terminates an inheritance reference, so a list
    // element `: ~/Base/N; { override }` is a SINGLE anonymous group that inherits from the ref and
    // whose `{}` overrides fields. Our parser only consumed a `,` between refs, so the `;` + `{ … }`
    // leaked and desynced the list's bracket matching (real workshop mod pipebase.rules).
    const src =
        'Base { ProxyableComponents [ { ComponentID = A } { ComponentID = B } ] }\n' +
        'WithSemi : ~/Base\n{\n\tProxyableComponents\n\t[\n' +
        '\t\t: ~/Base/ProxyableComponents/0; {ComponentID = X}\n' +
        '\t\t: ~/Base/ProxyableComponents/1; {ComponentID = Y}\n' +
        '\t]\n}\nNextGroup { Foo = 1 }\n';

    it('parses without desync and keeps the following top-level group', () => {
        const result = parser(lexer(src), 'file:///x.rules');
        expect(result.parserErrors).toEqual([]);
        // NextGroup must retain its identifier (before the fix it went anonymous under Document).
        expect(memberNames(result.value)).toEqual(['Base', 'WithSemi', 'NextGroup']);
    });

    it('makes each `;`-terminated element one inherited group carrying its override + inheritance', () => {
        const doc = parse(src);
        const withSemi = groupNamed(doc, 'WithSemi');
        const list = withSemi.elements.find((e) => isListNode(e)) as AbstractNode & { elements: AbstractNode[] };
        expect(list.elements).toHaveLength(2);
        for (const el of list.elements) {
            expect(isGroupNode(el)).toBe(true);
            // Each element is an override group with one member and one inheritance ref.
            expect((el as { inheritance?: unknown[] }).inheritance?.length).toBe(1);
            expect(memberNames(el as { elements: AbstractNode[] })).toEqual(['ComponentID']);
        }
    });
});

describe('parser: `,`-field-separated member that heads a group/list', () => {
    // A field terminated by a `,` separator, then a sibling member that heads a list/group
    // (`BuffAmount = { … }, Criterias [ … ]`, real mod gaugeincreaser.rules). The identifier after
    // the `,` must stay an Identifier heading its list — before the fix the `tokens[current-2] === ,`
    // guard reclassified it as a Value and orphaned the `[`, making the list anonymous.
    it('keeps the identifier after a comma when it is followed by `[`', () => {
        const doc = parse('Outer\n{\n\tBuffAmount = { BaseValue = 1 },\n\tCriterias\n\t[\n\t\t{ Cat = A }\n\t]\n}\n');
        const outer = groupNamed(doc, 'Outer');
        expect(memberNames(outer)).toEqual(['BuffAmount', 'Criterias']);
        const list = outer.elements.find((e) => isListNode(e)) as { identifier?: { name: string } };
        expect(list.identifier?.name).toBe('Criterias');
    });

    it('still treats a genuine comma-separated value list `[ &a, &b, &c ]` as values', () => {
        const doc = parse('G\n{\n\tRefs = [ &a, &b, &c ]\n\tAfter = 1\n}\n');
        expect(memberNames(groupNamed(doc, 'G'))).toEqual(['Refs', 'After']);
    });
});

describe('parser: implicit multiplication `N(expr)` (mXparser / flat-value)', () => {
    // A value immediately followed by `(` on the same line is implied multiplication (`3(&~/Range)` =
    // `3 * (&~/Range)`). The game reads the field value flat and mXparser evaluates it; our parser must
    // fold it into one MathExpression instead of leaking the `( … )` as a sibling value.
    it('folds `3(&~/Range)` and keeps following siblings', () => {
        const doc = parse('Comp\n{\n\tDistance = 3(&~/Range)\n\tHasTarget = false\n}\n');
        const comp = groupNamed(doc, 'Comp');
        expect(memberNames(comp)).toEqual(['Distance', 'HasTarget']);
        expect(rhsOf(comp, 'Distance')?.type).toBe('MathExpression');
    });

    it('does not implicit-multiply across a newline (a value on its own line stays alone)', () => {
        const doc = parse('Comp\n{\n\tA = 3\n\t(&x)\n\tB = 1\n}\n');
        // `3` and `(&x)` are on different lines — no implicit multiplication; the `A` value is just 3.
        expect(rhsOf(groupNamed(doc, 'Comp'), 'A')?.type).toBe('Value');
    });
});

describe('parser: `\\`-continuation across comments and blank lines (game IsUnsuppressedNewLine)', () => {
    // The game evaluates the whole whitespace/comment run between two tokens: a `\` before the run's
    // first newline suppresses termination for the ENTIRE run — including intervening `//` comment
    // lines and blank lines. So a continued string keeps concatenating across them.
    it('concatenates a continued string across an intervening `//` comment line', () => {
        const src = 'Doc\n{\n\tText = "first "\\\n//   a comment\n\t       "second"\n\tEntries\n\t[\n\t\t{ K = 1 }\n\t]\n}\n';
        const doc = parse(src);
        const g = groupNamed(doc, 'Doc');
        expect(memberNames(g)).toEqual(['Text', 'Entries']);
        expect(String((rhsOf(g, 'Text') as ValueNode).valueType.value)).toBe('first second');
    });

    it('concatenates a continued string across a blank line', () => {
        const doc = parse('G\n{\n\tBlank = "aa"\\\n\n\t        "bb"\n\tAfter = 1\n}\n');
        const g = groupNamed(doc, 'G');
        expect(memberNames(g)).toEqual(['Blank', 'After']);
        expect(String((rhsOf(g, 'Blank') as ValueNode).valueType.value)).toBe('aabb');
    });

    it('a `\\` AFTER the first newline does NOT retroactively suppress it', () => {
        // `A = "x"` ends at its newline (no leading `\`); the next line is a separate field.
        const doc = parse('G\n{\n\tA = "x"\n\tB = "y"\n}\n');
        expect(memberNames(groupNamed(doc, 'G'))).toEqual(['A', 'B']);
    });
});

describe('parser: a lone reference sigil is a literal value, not a reference', () => {
    // Keyboard key-name strings (`strings/*.rules`): `TildeBacktick = ~`. A lone `~` has no path to
    // resolve, so typing it as a Reference produced a bogus "Reference should start with an ampersand"
    // error. It must be a plain String value. (`/`, `^`, `&` lex as their own tokens handled by other
    // branches and never triggered the FP.)
    const rhsValueType = (src: string, key: string) => {
        const g = parse(`G\n{\n\t${src}\n}\n`);
        const r = rhsOf(groupNamed(g, 'G'), key) as ValueNode | undefined;
        return r?.valueType?.type;
    };

    it('types a lone `~` as String, not Reference', () => {
        expect(rhsValueType('TildeBacktick = ~', 'TildeBacktick')).toBe('String');
    });

    it('still types a real reference path (sigil + member) as Reference', () => {
        expect(rhsValueType('A = &Name', 'A')).toBe('Reference');
        expect(rhsValueType('A = ~/Foo/Bar', 'A')).toBe('Reference');
    });
});
