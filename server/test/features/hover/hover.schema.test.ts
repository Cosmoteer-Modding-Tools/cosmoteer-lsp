import { describe, expect, it } from 'vitest';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import {
    AbstractNode,
    isAssignmentNode,
    isGroupNode,
    isIdentifierNode,
    isListNode,
    isValueNode,
    ValueNode,
} from '../../../src/core/ast/ast';
import { schemaDiscriminatorHover, schemaFieldHover } from '../../../src/features/hover/schema-hover';

const parse = (src: string) => parser(lexer(src), 'file:///t.rules').value;

const findValue = (node: AbstractNode, field: string): ValueNode | undefined => {
    if (isAssignmentNode(node) && node.left.name === field && isValueNode(node.right)) return node.right;
    const kids = isGroupNode(node) || isListNode(node) ? node.elements : isAssignmentNode(node) ? [node.right] : [];
    for (const k of kids) {
        const f = findValue(k, field);
        if (f) return f;
    }
    return undefined;
};

const findIdentifier = (node: AbstractNode, name: string): AbstractNode | undefined => {
    if (isGroupNode(node) || isListNode(node)) {
        for (const k of node.elements) {
            if (isIdentifierNode(k) && k.name === name) return k;
            const f = findIdentifier(k, name);
            if (f) return f;
        }
    }
    return undefined;
};

const PART = `Part
{
	Components
	{
		Turret
		{
			Type = TurretWeapon
			FiringArc = 115d
		}
		IsOp
		{
			Type = MultiToggle
			Mode = All
		}
	}
}`;

describe('schemaFieldHover', () => {
    it('documents a field’s type and required-ness', () => {
        const doc = parse(PART);
        const firingArc = doc.elements.map((n) => findValue(n, 'FiringArc')).find(Boolean);
        const hover = schemaFieldHover(firingArc!);
        expect(hover).toContain('FiringArc');
        expect(hover).toContain('number');
        expect(hover).toContain('required');
    });

    it('lists the members for an enum field', () => {
        const doc = parse(PART);
        const mode = doc.elements.map((n) => findValue(n, 'Mode')).find(Boolean);
        const hover = schemaFieldHover(mode!);
        expect(hover).toContain('Mode');
        expect(hover).toContain('one of');
        expect(hover).toContain('None');
    });

    it('returns null for a field with no schema', () => {
        const doc = parse('Foo { Bar = baz }');
        const bar = doc.elements.map((n) => findValue(n, 'Bar')).find(Boolean);
        expect(schemaFieldHover(bar!)).toBeNull();
    });

    // A custom-deserialized engine type (a particle channel) is `opaque` in the schema, but its C#
    // type name is still worth showing — not the bare word `opaque`.
    const RENDERER = `Def
{
	Renderer
	{
		Type = StandardQuadRenderer
		ScaleIn = scale
		Scale2In
	}
}`;

    it('shows the type name for an opaque field instead of `opaque`', () => {
        const doc = parse(RENDERER);
        const scaleIn = doc.elements.map((n) => findValue(n, 'ScaleIn')).find(Boolean);
        const hover = schemaFieldHover(scaleIn!);
        expect(hover).toContain('ScaleIn');
        expect(hover).toContain('ParticleDataID');
        expect(hover).not.toContain('opaque');
    });

    it('resolves the field type for a valueless bare key (`Scale2In`)', () => {
        const doc = parse(RENDERER);
        const scale2In = doc.elements.map((n) => findIdentifier(n, 'Scale2In')).find(Boolean);
        expect(scale2In).toBeDefined();
        const hover = schemaFieldHover(scale2In!);
        expect(hover).toContain('Scale2In');
        expect(hover).toContain('ParticleDataID');
    });
});

describe('schemaDiscriminatorHover', () => {
    it('shows the concrete class a `Type=` discriminator selects', () => {
        const doc = parse(PART);
        const type = doc.elements.map((n) => findValue(n, 'Type')).find(Boolean);
        const hover = schemaDiscriminatorHover(type!);
        expect(hover).toContain('TurretWeapon');
        expect(hover).toContain('TurretWeaponRules');
    });

    it('returns null for a non-discriminator value', () => {
        const doc = parse(PART);
        const firingArc = doc.elements.map((n) => findValue(n, 'FiringArc')).find(Boolean);
        expect(schemaDiscriminatorHover(firingArc!)).toBeNull();
    });
});
