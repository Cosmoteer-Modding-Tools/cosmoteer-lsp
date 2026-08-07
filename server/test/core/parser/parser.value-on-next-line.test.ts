import { describe, expect, it } from 'vitest';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import {
    AssignmentNode,
    GroupNode,
    isAssignmentNode,
    isGroupNode,
    isListNode,
    isValueNode,
    ListNode,
} from '../../../src/core/ast/ast';

const parse = (src: string) => parser(lexer(src), 'file:///t.rules');

/** The single group every fixture wraps its members in. */
const groupOf = (src: string): GroupNode => {
    const result = parse(src);
    expect(result.parserErrors).toEqual([]);
    const group = result.value.elements[0];
    expect(isGroupNode(group)).toBe(true);
    return group as GroupNode;
};

/** The member of `group` written under `name`, whatever shape it took. */
const memberNamed = (group: GroupNode, name: string) =>
    group.elements.find((element) =>
        isAssignmentNode(element)
            ? element.left.name === name
            : (isGroupNode(element) || isListNode(element)) && element.identifier?.name === name
    );

/**
 * A newline after `=` does not end the value. The game's parser skips ahead to the next significant
 * token, so a body or a value written on the following line still belongs to the field above it.
 * Verified case by case by running Halfling.ObjectText out of HalflingCore.dll, which is also where
 * the two deliberate deviations below come from: both are inputs the game answers with a parse error
 * that cascades through the rest of the file, so staying graceful beats reproducing it.
 */
describe('a value written on the line after `=`', () => {
    it('binds a group body to the field above it (vanilla chaingun.rules)', () => {
        const group = groupOf('G\n{\n\tDamageResistances =\n\t{\n\t\tdefault = 70%\n\t}\n}\n');
        const member = memberNamed(group, 'DamageResistances');
        expect(isAssignmentNode(member)).toBe(true);
        expect(isGroupNode((member as AssignmentNode).right)).toBe(true);
    });

    it('binds a list body to the field above it', () => {
        const group = groupOf('G\n{\n\tRandomSounds =\n\t[\n\t\t"a.wav"\n\t]\n}\n');
        const member = memberNamed(group, 'RandomSounds');
        expect(isAssignmentNode(member)).toBe(true);
        expect(isListNode((member as AssignmentNode).right)).toBe(true);
    });

    it('binds a body separated by a blank line', () => {
        const group = groupOf('G\n{\n\tX =\n\n\t{\n\t\tA = 1\n\t}\n}\n');
        expect(isGroupNode((memberNamed(group, 'X') as AssignmentNode).right)).toBe(true);
    });

    it('binds a plain value, leaving the next field its own member', () => {
        const group = groupOf('G\n{\n\tX =\n\t5\n\tY = 1\n}\n');
        const x = memberNamed(group, 'X') as AssignmentNode;
        expect(isValueNode(x.right)).toBe(true);
        expect(memberNamed(group, 'Y')).toBeDefined();
    });

    it('keeps the whole misplaced-effects shape as named members', () => {
        // The shape a modder writes when they mean "inherit the hit and add media effects": the
        // reference belongs to OnDeath, and MediaEffects is a member of the enclosing group (where
        // the game ignores it, which is what makes the dead-field hint on it correct).
        const group = groupOf(
            'Death\n{\n\tType = DeathByLifetime\n\tOnDeath =\n\t\t&<f.rules>/Hit\n\n\t\tMediaEffects\n\t\t[\n\t\t\t&<a.rules>\n\t\t]\n}\n'
        );
        expect(isValueNode((memberNamed(group, 'OnDeath') as AssignmentNode).right)).toBe(true);
        const effects = memberNamed(group, 'MediaEffects');
        expect(isListNode(effects)).toBe(true);
        expect((effects as ListNode).elements).toHaveLength(1);
    });

    it('leaves the value empty before a closing brace, keeping the container intact', () => {
        // Deviation on purpose: the game swallows the `}` into the value and then runs off the end of
        // the file. This is the live-editing state right after a snippet scaffolds `Type = `, so a
        // cascading desync here would break every schema feature in the file.
        const group = groupOf('G\n{\n\tA = 1\n\tX =\n}\nH\n{\n\tB = 2\n}\n');
        expect((memberNamed(group, 'X') as AssignmentNode).right).toBeNull();
        expect(parse('G\n{\n\tA = 1\n\tX =\n}\nH\n{\n\tB = 2\n}\n').value.elements).toHaveLength(2);
    });

    it('leaves the value empty above the head of a new member', () => {
        // Deviation on purpose: the game folds the whole `Y = 1` member into X's value. No shipped
        // file relies on that, and while editing it would silently swallow the field below.
        const group = groupOf('G\n{\n\tX =\n\tY = 1\n}\n');
        expect((memberNamed(group, 'X') as AssignmentNode).right).toBeNull();
        expect(isValueNode((memberNamed(group, 'Y') as AssignmentNode).right)).toBe(true);
    });
});
