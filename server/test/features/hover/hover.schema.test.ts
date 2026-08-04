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
    const kids = isGroupNode(node) || isListNode(node) ? node.elements : isAssignmentNode(node) && node.right ? [node.right] : [];
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

/**
 * Find a named container (a `Foo { … }` group or `Foo [ … ]` list), searching depth-first.
 * @param node the node to search from.
 * @param name the container identifier to look for.
 * @returns the matching container node, or undefined when none exists.
 */
const findNamedContainer = (node: AbstractNode, name: string): AbstractNode | undefined => {
    if ((isGroupNode(node) || isListNode(node)) && node.identifier?.name === name) return node;
    const kids = isGroupNode(node) || isListNode(node) ? node.elements : isAssignmentNode(node) && node.right ? [node.right] : [];
    for (const k of kids) {
        const f = findNamedContainer(k, name);
        if (f) return f;
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

    it('warns about a deleted field and names its migration (`Flammable`)', () => {
        // The Meltdown update deleted `Flammable`; fire immunity is now the `non_flammable` part
        // category. The member stays in the schema so old mods still hover, but the hover must warn.
        const doc = parse('Part\n{\n\tFlammable = false\n}');
        const flammable = doc.elements.map((n) => findValue(n, 'Flammable')).find(Boolean);
        const hover = schemaFieldHover(flammable!);
        expect(hover).toContain('Flammable');
        expect(hover).toContain('removed in a newer game version');
        expect(hover).toContain('TypeCategories = [non_flammable]');
    });

    it('returns null for a field with no schema', () => {
        const doc = parse('Foo { Bar = baz }');
        const bar = doc.elements.map((n) => findValue(n, 'Bar')).find(Boolean);
        expect(schemaFieldHover(bar!)).toBeNull();
    });

    // A custom-deserialized engine type (a particle channel) is `opaque` in the schema, but its C#
    // type name is still worth showing, not the bare word `opaque`.
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

    // A list-form field is written without an `=` (`Resources [ … ]`), so hovering its key resolves
    // to the list node itself, not a sibling assignment. It must still document the field.
    it('documents a list-form field hovered on its key (`Resources [ … ]`)', () => {
        const doc = parse('Part\n{\n\tResources\n\t[\n\t\t[steel, 84]\n\t]\n}');
        const resources = doc.elements.map((n) => findNamedContainer(n, 'Resources')).find(Boolean);
        expect(resources).toBeDefined();
        const hover = schemaFieldHover(resources!);
        expect(hover).toContain('Resources');
    });

    // A group-typed field written in its positional list form: hovering an element documents the
    // digit field the game reads it through (`[1.5, 2]` in a Vector2 slot → element 0 = field "0").
    it('documents a positional element of a Vector2 written in list form', () => {
        const doc = parse(
            'Part\n{\n\tComponents\n\t{\n\t\tDoor\n\t\t{\n\t\t\tType = Airlock\n\t\t\tEnterExitPoint = [1.5, 2]\n\t\t}\n\t}\n}'
        );
        const findList = (node: AbstractNode): AbstractNode | undefined => {
            if (isAssignmentNode(node) && node.left.name === 'EnterExitPoint' && isListNode(node.right))
                return node.right;
            const kids = isGroupNode(node) || isListNode(node) ? node.elements : isAssignmentNode(node) && node.right ? [node.right] : [];
            for (const k of kids) {
                const f = findList(k);
                if (f) return f;
            }
            return undefined;
        };
        const list = doc.elements.map((n) => findList(n)).find(Boolean);
        expect(list).toBeDefined();
        const hover = schemaFieldHover((list as unknown as { elements: AbstractNode[] }).elements[0]);
        expect(hover).toContain('**0**');
        expect(hover).toContain('float');
    });

    // A positional entry list nested in a `list<group>` field: the element index resolves through
    // the entry class's digit field, here EditorParentPart's `"0"` (a PartRules reference).
    it('documents an element of a nested positional entry (EditorParentParts)', () => {
        const src = 'Part\n{\n\tEditorParentParts = [ [other_part, 0] ]\n}';
        const doc = parse(src);
        const lists: AbstractNode[] = [];
        const walk = (n: AbstractNode) => {
            if (isListNode(n)) lists.push(n);
            const kids = isGroupNode(n) || isListNode(n) ? n.elements : isAssignmentNode(n) && n.right ? [n.right] : [];
            for (const k of kids) walk(k);
        };
        for (const e of doc.elements) walk(e);
        const inner = lists[1] as unknown as { elements: AbstractNode[] };
        const hover = schemaFieldHover(inner.elements[0]);
        expect(hover).toContain('**0**');
        expect(hover).toContain('PartRules');
    });

    // An overriding field written as `Name : ^/0/Name [ … ]` parses to a named list with inheritance.
    // Hovering the key previously lost the schema entirely.
    it('documents an overriding list field (`TypeCategories : ^/0/TypeCategories [ … ]`)', () => {
        const doc = parse('Part\n{\n\tTypeCategories : ^/0/TypeCategories [command, uses_power]\n}');
        const typeCats = doc.elements.map((n) => findNamedContainer(n, 'TypeCategories')).find(Boolean);
        expect(typeCats).toBeDefined();
        const hover = schemaFieldHover(typeCats!);
        expect(hover).toContain('TypeCategories');
        expect(hover).toContain('PartCategory');
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

    it('shows the current name when a `Type=` was renamed in a newer game version', () => {
        // The valid `Known` sibling identifies the container's registry, so the deprecated `AmmoChange`
        // on `Old` resolves to its rename note.
        const doc = parse('Part\n{\n\tComponents\n\t{\n\t\tKnown { Type = TurretWeapon }\n\t\tOld { Type = AmmoChange }\n\t}\n}');
        const findByValue = (node: AbstractNode, v: string): ValueNode | undefined => {
            if (isValueNode(node) && node.valueType.value === v) return node;
            const kids = isGroupNode(node) || isListNode(node) ? node.elements : isAssignmentNode(node) && node.right ? [node.right] : [];
            for (const k of kids) {
                const f = findByValue(k, v);
                if (f) return f;
            }
            return undefined;
        };
        const old = doc.elements.map((n) => findByValue(n, 'AmmoChange')).find(Boolean);
        const hover = schemaDiscriminatorHover(old!);
        expect(hover).toContain('AmmoChange');
        expect(hover).toContain('renamed');
        expect(hover).toContain('ResourceChange');
    });
});
