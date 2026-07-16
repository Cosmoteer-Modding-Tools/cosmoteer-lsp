import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import {
    AbstractNode,
    GroupNode,
    isAssignmentNode,
    isDocumentNode,
    isGroupNode,
    isListNode,
} from '../../../src/core/ast/ast';
import { resolveGroupClass } from '../../../src/document/schema/schema-context';
import { schemaFieldNameCompletions } from '../../../src/features/completion/autocompletion.schema-fields';
import { Completion } from '../../../src/features/completion/autocompletion.service';
import { validateSchema } from '../../../src/features/diagnostics/validator.schema';

// A `Modifiable<T>` field (here TurretWeaponRules.TargetingRange, a ModifiableFloat) has two valid
// written forms: a bare scalar (`TargetingRange = 5`) or a group carrying the unmodified value plus
// inline buff/status/effect-scale modifiers. The scalar form stays a `number`. The group form is
// resolved to the curated `ModifiableValue` class so completion/hover/validation work inside the `{ }`.
const token = CancellationToken.None;
const parse = (src: string) => parser(lexer(src), 'file:///t.rules').value;
const labelsOf = (cs: Completion[]) => cs.map((c) => (typeof c === 'string' ? c : c.label));

const findGroup = (node: AbstractNode, id: string): GroupNode | undefined => {
    if (isGroupNode(node) && node.identifier?.name === id) return node;
    const kids =
        isGroupNode(node) || isListNode(node) || isDocumentNode(node)
            ? node.elements
            : isAssignmentNode(node) && node.right
              ? [node.right]
              : [];
    for (const k of kids) {
        const found = findGroup(k, id);
        if (found) return found;
    }
    return undefined;
};

const turret = (body: string) =>
    `Part\n{\n\tComponents\n\t{\n\t\tT\n\t\t{\n\t\t\tType = TurretWeapon\n${body}\n\t\t}\n\t}\n}`;

describe('Modifiable group form', () => {
    it('resolves a Modifiable field written as a group to the ModifiableValue class', () => {
        const doc = parse(turret('\t\t\tTargetingRange\n\t\t\t{\n\t\t\t\tBaseValue = 5\n\t\t\t}'));
        const group = findGroup(doc, 'TargetingRange');
        expect(resolveGroupClass(group!)).toBe('Cosmoteer.Ships.ModifiableValue');
    });

    it('offers the group-form fields for completion inside the block', async () => {
        const SRC = turret('\t\t\tTargetingRange\n\t\t\t{\n\t\t\t\t\n\t\t\t}');
        const gapOffset = SRC.indexOf('{', SRC.indexOf('TargetingRange')) + 3; // inside the blank line
        const labels = labelsOf(await schemaFieldNameCompletions(parse(SRC), gapOffset, token));
        expect(labels).toContain('BaseValue');
        expect(labels).toContain('BuffType');
        expect(labels).toContain('BuffMode');
        expect(labels).toContain('Modifiers');
        expect(labels).toContain('MinValue');
    });

    it('validates an enum field inside the group form (invalid BuffMode flagged)', async () => {
        const errors = await validateSchema(
            parse(turret('\t\t\tTargetingRange\n\t\t\t{\n\t\t\t\tBaseValue = 5\n\t\t\t\tBuffMode = Nonsense\n\t\t\t}')),
            token
        );
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain('Nonsense');
        expect(errors[0].message).toContain('ValueModificationMode');
    });

    it('accepts a valid BuffMode and the plain scalar form', async () => {
        expect(
            await validateSchema(
                parse(turret('\t\t\tTargetingRange\n\t\t\t{\n\t\t\t\tBaseValue = 5\n\t\t\t\tBuffMode = Multiply\n\t\t\t}')),
                token
            )
        ).toHaveLength(0);
        expect(await validateSchema(parse(turret('\t\t\tTargetingRange = 5')), token)).toHaveLength(0);
    });
});
