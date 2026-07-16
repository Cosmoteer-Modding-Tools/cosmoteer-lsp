import { describe, expect, it } from 'vitest';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import {
    AbstractNode,
    isAssignmentNode,
    isDocumentNode,
    isGroupNode,
    isListNode,
    isValueNode,
    ValueNode,
} from '../../../src/core/ast/ast';
import { CancellationToken } from 'vscode-languageserver';
import { resolveSchemaSiblingReference } from '../../../src/features/navigation/schema-reference.navigation';
import { DefinitionService } from '../../../src/features/navigation/definition.service';
import { HoverService } from '../../../src/features/hover/hover.service';
import { ReferenceIndex } from '../../../src/features/navigation/reference-index';
import { RenameService } from '../../../src/features/navigation/rename.service';
import { singleLocation } from '../../helpers';

const parse = (src: string) => parser(lexer(src), 'file:///t.rules').value;

const findValue = (node: AbstractNode, field: string): ValueNode | undefined => {
    if (isAssignmentNode(node) && node.left.name === field && isValueNode(node.right)) return node.right;
    const children =
        isGroupNode(node) || isListNode(node) || isDocumentNode(node)
            ? node.elements
            : isAssignmentNode(node) && node.right
              ? [node.right]
              : [];
    for (const child of children) {
        const found = findValue(child, field);
        if (found) return found;
    }
    return undefined;
};

const SRC = `Part
{
	Components
	{
		IsOperational { Type = MultiToggle; Mode = All }
		PowerToggle { Type = UIToggle }
		Turret { Type = TurretWeapon; OperationalToggle = IsOperational }
	}
}`;

describe('resolveSchemaSiblingReference: go-to-definition for ID<> sibling refs', () => {
    it('resolves OperationalToggle = IsOperational to the IsOperational component group', () => {
        const ref = findValue(parse(SRC), 'OperationalToggle');
        const target = resolveSchemaSiblingReference(ref);
        expect(target).toBeDefined();
        expect(isGroupNode(target!)).toBe(true);
        expect(isGroupNode(target!) && target!.identifier?.name).toBe('IsOperational');
    });

    it('returns undefined when no sibling matches the written id', () => {
        const ref = findValue(parse(SRC.replace('= IsOperational', '= Nonexistent')), 'OperationalToggle');
        expect(resolveSchemaSiblingReference(ref)).toBeUndefined();
    });

    it('returns undefined for a non-reference field (Mode is an enum, not an ID<>)', () => {
        const mode = findValue(parse(SRC), 'Mode');
        expect(resolveSchemaSiblingReference(mode)).toBeUndefined();
    });

    it('DefinitionService.getDefinition jumps from the value to the sibling definition', async () => {
        const doc = parse(SRC);
        const line = 6; // the Turret line
        const lineText = SRC.split('\n')[line];
        const character = lineText.indexOf('= IsOperational') + 2; // cursor on the `IsOperational` value
        const location = singleLocation(await DefinitionService.instance.getDefinition(doc, { line, character }, CancellationToken.None));
        expect(location.range.start.line).toBe(4); // the `IsOperational { … }` definition line
    });
});

describe('resolveSchemaSiblingReference: component ids in tuple slots', () => {
    /**
     * First value node whose written value is `text`, searching depth-first (tuple entries have no field name).
     *
     * @param node the node to search from.
     * @param text the written value to match.
     * @returns the matching value node, or undefined when nothing matches.
     */
    const findValueByText = (node: AbstractNode, text: string): ValueNode | undefined => {
        if (isValueNode(node) && String(node.valueType.value) === text) return node;
        const children =
            isGroupNode(node) || isListNode(node) || isDocumentNode(node)
                ? node.elements
                : isAssignmentNode(node) && node.right
                  ? [node.right]
                  : [];
        for (const child of children) {
            const found = findValueByText(child, text);
            if (found) return found;
        }
        return undefined;
    };

    // A network router's route generator names components in `[from, to, cost]` tuples (the vanilla
    // heat exchanger's `Routes`), and the referenced components live elsewhere in the part.
    const ROUTER_SRC = `Part
{
	Components
	{
		Port_Down { Type = MultiToggle; Mode = All }
		HeatSink { Type = MultiToggle; Mode = All }
		Router
		{
			Type = NetworkRouter
			RouteGenerators
			[
				{
					Type = Bidirectional
					Routes
					[
						[Port_Down, HeatSink, 0]
					]
				}
			]
		}
	}
}`;

    it('resolves the first tuple slot to the named component group', () => {
        const ref = findValueByText(parse(ROUTER_SRC), 'Port_Down');
        const target = resolveSchemaSiblingReference(ref);
        expect(target).toBeDefined();
        expect(isGroupNode(target!) && target!.identifier?.name).toBe('Port_Down');
    });

    it('resolves the second tuple slot too', () => {
        const ref = findValueByText(parse(ROUTER_SRC), 'HeatSink');
        const target = resolveSchemaSiblingReference(ref);
        expect(isGroupNode(target!) && target!.identifier?.name).toBe('HeatSink');
    });

    it('leaves a non-component tuple slot alone (a Resources cost entry is a resource, not a component)', () => {
        const src = 'Part\n{\n\tResources\n\t[\n\t\t[battery, 20]\n\t]\n}';
        const ref = findValueByText(parse(src), 'battery');
        expect(resolveSchemaSiblingReference(ref)).toBeUndefined();
    });
});

describe('resolvePartComponentDeclaration: part-wide goto beyond the same container', () => {
    // The referenced component lives in an inherited base part, which the same-container search
    // cannot see. The async part-wide resolver walks the inheritance like validation does.
    const INHERITED = `BasePart
{
	Components
	{
		HiddenToggle { Type = MultiToggle; Mode = All }
	}
}
Part : BasePart
{
	Components
	{
		Turret { Type = TurretWeapon; OperationalToggle = HiddenToggle }
	}
}`;

    it('resolves an assignment-form reference to a component of the inherited base', async () => {
        const doc = parse(INHERITED);
        const line = INHERITED.split('\n').findIndex((l) => l.includes('OperationalToggle'));
        const character = INHERITED.split('\n')[line].indexOf('= HiddenToggle') + 3;
        const location = singleLocation(await DefinitionService.instance.getDefinition(doc, { line, character }, CancellationToken.None));
        expect(location.range.start.line).toBe(4); // the base's `HiddenToggle { … }` line
    });

    it('resolves a route-tuple reference to a component of the inherited base', async () => {
        const src = `BasePart
{
	Components
	{
		HeatSink { Type = MultiToggle; Mode = All }
	}
}
Part : BasePart
{
	Components
	{
		Port { Type = MultiToggle; Mode = All }
		Router
		{
			Type = NetworkRouter
			RouteGenerators
			[
				{
					Type = Bidirectional
					Routes
					[
						[Port, HeatSink, 0]
					]
				}
			]
		}
	}
}`;
        const doc = parse(src);
        const line = src.split('\n').findIndex((l) => l.includes('[Port, HeatSink'));
        const character = src.split('\n')[line].indexOf('HeatSink') + 2;
        const location = singleLocation(await DefinitionService.instance.getDefinition(doc, { line, character }, CancellationToken.None));
        expect(location.range.start.line).toBe(4); // the base's `HeatSink { … }` line
    });
});

describe('find-all-references + rename for ID<> sibling refs', () => {
    const token = CancellationToken.None;
    const defLine = 4; // `IsOperational { … }`
    const refLine = 6; // `… OperationalToggle = IsOperational`

    it('finds the reference site and declaration from the definition', async () => {
        const doc = parse(SRC);
        const locations = await ReferenceIndex.instance.findReferences(doc, { line: defLine, character: 5 }, true, [], token);
        const lines = locations.map((l) => l.range.start.line).sort();
        expect(lines).toEqual([defLine, refLine]);
    });

    it('finds the same set from the reference value (cursor on the use site)', async () => {
        const doc = parse(SRC);
        const refChar = SRC.split('\n')[refLine].indexOf('= IsOperational') + 2;
        const locations = await ReferenceIndex.instance.findReferences(doc, { line: refLine, character: refChar }, false, [], token);
        expect(locations.map((l) => l.range.start.line)).toEqual([refLine]); // declaration excluded
    });

    it('hover on a sibling reference shows what it resolves to', async () => {
        const doc = parse(SRC);
        const character = SRC.split('\n')[refLine].indexOf('= IsOperational') + 2;
        const hover = await HoverService.instance.getHover(doc, { line: refLine, character }, CancellationToken.None);
        const value = typeof hover?.contents === 'object' && 'value' in hover.contents ? hover.contents.value : '';
        expect(value).toContain('IsOperational'); // → group `IsOperational`
        expect(value).toContain('→');
    });

    it('renames the component and its sibling reference together', async () => {
        const doc = parse(SRC);
        const edit = await RenameService.instance.rename(doc, { line: defLine, character: 5 }, 'PrimaryToggle', [], token);
        expect(edit).not.toBeNull();
        const fileEdits = Object.values(edit!.changes!)[0];
        expect(fileEdits).toHaveLength(2);
        expect(fileEdits.every((e) => e.newText === 'PrimaryToggle')).toBe(true);
        expect(fileEdits.map((e) => e.range.start.line).sort()).toEqual([defLine, refLine]);
    });
});
