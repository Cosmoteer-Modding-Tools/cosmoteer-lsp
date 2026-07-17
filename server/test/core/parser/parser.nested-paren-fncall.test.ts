import { describe, expect, it } from 'vitest';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { AbstractNode, isAssignmentNode, isGroupNode, isListNode } from '../../../src/core/ast/ast';

/**
 * The name of each member of a group, list or document, in source order.
 *
 * @param node the container whose members are wanted.
 * @returns each member's identifier name, an anonymous marker for an unnamed group or list, or the
 * node type for anything else.
 */
const memberNames = (node: { elements: AbstractNode[] }): string[] =>
    node.elements.map((el) => {
        if (isGroupNode(el) || isListNode(el)) return el.identifier?.name ?? '<anon>';
        if (isAssignmentNode(el)) return el.left.name;
        return el.type;
    });

/**
 * Parse a `Part` group whose `Value` field holds the expression under test, followed by a plain
 * sibling field and a nested group. Both siblings disappear from the result once the expression
 * desyncs paren matching, which is what makes them the assertion.
 *
 * @param expr the expression to place in the `Value` field.
 * @returns the parsed `Part` group.
 */
const partWith = (expr: string) => {
    const src = `Part\n{\n\tValue = ${expr}\n\tAfter = 1\n\tNested\n\t{\n\t\tInner = 2\n\t}\n}\n`;
    const doc = parser(lexer(src), 'file:///x.rules').value;
    return doc.elements.find((e) => isGroupNode(e)) as AbstractNode & { elements: AbstractNode[] };
};

/**
 * Regression: a parenthesized nested function call used as a math operand, `ceil((ceil(&b))/4)`,
 * used to leak the `(` it opened (the `startWithParens` shortcut consumed it, then the nested-call
 * guard skipped the matching close), desyncing paren matching so every sibling after the assignment
 * was dropped from the group. That silently truncated the AST (e.g. a part's `Components`),
 * producing false "reference name is not known" diagnostics for paths into the dropped members.
 * See the real-world `AtlasSprite = …/DamageLevels/0` case.
 */
describe('parser: parenthesized nested function call as a math operand', () => {
    it('keeps siblings after `ceil((ceil(&b))/4)`', () => {
        const part = partWith('ceil((ceil(&b))/4)');
        expect(memberNames(part)).toEqual(['Value', 'After', 'Nested']);
    });

    it('keeps siblings after the real-world `ceil((ceil((&a)*(&b)))/4)` shape', () => {
        const part = partWith('ceil((ceil((&a)*(&b)))/4)');
        expect(memberNames(part)).toEqual(['Value', 'After', 'Nested']);
    });

    it('still parses the simple parenthesized arg `ceil((&b))`', () => {
        const part = partWith('ceil((&b))');
        expect(memberNames(part)).toEqual(['Value', 'After', 'Nested']);
    });

    it('still parses a parenthesized math (non-call) operand `ceil(((&b)*2)/4)`', () => {
        const part = partWith('ceil(((&b)*2)/4)');
        expect(memberNames(part)).toEqual(['Value', 'After', 'Nested']);
    });
});

/**
 * Regression: a unary minus (or plus) before a parenthesized group, `-(&A/B)` or `-(5)`, used to
 * return a lone `Expression('-')` and leave the `( … )` unconsumed, which then leaked out as sibling
 * fields and swallowed the following group's identifier (a silent desync with zero parser errors).
 * Seen on vanilla `ION_ENERGY = -(&Part/Components/…/BaseValue)` in ion_beam_emitter.rules, which
 * corrupted the `Part` group so every ref into it was flagged "reference name is not known".
 */
describe('parser: unary sign before a parenthesized group', () => {
    /**
     * The name of each top-level member of a source.
     *
     * @param src the .rules source to parse.
     * @returns each top-level member's name.
     */
    const rootNames = (src: string) => {
        const doc = parser(lexer(src), 'file:///x.rules').value;
        return memberNames(doc);
    };

    it('keeps the following named group after `-(&A/B/C)`', () => {
        expect(rootNames('ION = -(&A/B/C)\nPart\n{\n\tX = 1\n}\n')).toEqual(['ION', 'Part']);
    });

    it('keeps the following named group after `-(5)` (a parenthesized number)', () => {
        expect(rootNames('ION = -(5)\nPart\n{\n\tX = 1\n}\n')).toEqual(['ION', 'Part']);
    });

    it('reports no parser errors and yields a MathExpression value for `-(&A)`', () => {
        const doc = parser(lexer('ION = -(&A)\n'), 'file:///x.rules');
        expect(doc.parserErrors).toEqual([]);
        const assignment = doc.value.elements.find((e) => isAssignmentNode(e))!;
        expect(isAssignmentNode(assignment) && assignment.right?.type).toBe('MathExpression');
    });

    it('still treats a binary minus before a paren as a binary operator (`(&A) - (&B)`)', () => {
        // lastCompletesValue is true after `(&A)`, so the `-` must not be taken as a unary sign.
        expect(rootNames('ION = (&A) - (&B)\nPart\n{\n\tX = 1\n}\n')).toEqual(['ION', 'Part']);
    });

    it('still folds a bare negative number `-5` (unchanged)', () => {
        const doc = parser(lexer('ION = -5\n'), 'file:///x.rules');
        const assignment = doc.value.elements.find((e) => isAssignmentNode(e))!;
        expect(isAssignmentNode(assignment) && assignment.right?.type).toBe('Value');
        expect(
            isAssignmentNode(assignment) &&
                (assignment.right as { valueType: { value: unknown } }).valueType.value
        ).toBe(-5);
    });
});
