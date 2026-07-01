import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { ValidationForValue } from '../../../src/features/diagnostics/validator.value';
import { AbstractNode, isListNode, isGroupNode, isValueNode, ValueNode } from '../../../src/core/ast/ast';

const token = CancellationToken.None;

const collectReferences = (node: AbstractNode, out: ValueNode[] = []): ValueNode[] => {
    if (!node || typeof node !== 'object') return out;
    if (isValueNode(node) && node.valueType.type === 'Reference') out.push(node);
    const n = node as unknown as { elements?: AbstractNode[]; inheritance?: AbstractNode[]; left?: AbstractNode; right?: AbstractNode; arguments?: AbstractNode[] };
    if (isGroupNode(node) || isListNode(node) || node.type === 'Document') {
        (n.elements ?? []).forEach((c) => collectReferences(c, out));
        (n.inheritance ?? []).forEach((c) => collectReferences(c, out));
    }
    if (n.left) collectReferences(n.left, out);
    if (n.right) collectReferences(n.right, out);
    (n.arguments ?? []).forEach((c) => collectReferences(c, out));
    return out;
};

const validate = async (src: string): Promise<Map<string, string | undefined>> => {
    const doc = parser(lexer(src), 'file:///t.rules').value;
    const result = new Map<string, string | undefined>();
    for (const ref of collectReferences(doc as AbstractNode)) {
        result.set(String(ref.valueType.value), (await ValidationForValue.callback(ref, token))?.message);
    }
    return result;
};

describe('runtime (`~`) and terminal-deref leniency', () => {
    // A part defines a member whose VALUE is a runtime `~` reference, and a nested field points at
    // that member via `&../`. The member exists; its value only resolves at instantiation.
    const src = `Part
{
\tDamagePerShot = &~/Components/BulletEmitterBase/Bullet/Damage
\tTooltip
\t{
\t\tValue = &../DamagePerShot
\t\tBroken = &NonExistentTypo
\t}
}
`;

    it('does not flag a deep `~` reference (runtime-assembled subtree)', async () => {
        const d = await validate(src);
        expect(d.get('&~/Components/BulletEmitterBase/Bullet/Damage')).toBeUndefined();
    });

    it('does not flag `&../Member` whose value is a runtime `~` reference (terminal-deref)', async () => {
        const d = await validate(src);
        expect(d.get('&../DamagePerShot')).toBeUndefined();
    });

    it('STILL flags a genuine missing alias (no over-suppression)', async () => {
        const d = await validate(src);
        expect(d.get('&NonExistentTypo')).toBe('Reference name is not known');
    });
});
