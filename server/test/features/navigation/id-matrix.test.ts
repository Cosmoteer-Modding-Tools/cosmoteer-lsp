import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { readFileSync } from 'fs';
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
import { DefinitionService } from '../../../src/features/navigation/definition.service';
import { HoverService } from '../../../src/features/hover/hover.service';
import { ReferenceIndex } from '../../../src/features/navigation/reference-index';
import { RenameService } from '../../../src/features/navigation/rename.service';
import { SchemaIdIndex } from '../../../src/features/completion/schema-id.index';
import { crossFileReferenceTargetAtOffset } from '../../../src/features/completion/autocompletion.schema-fields';
import { singleLocation } from '../../helpers';

// The shape-times-feature matrix over every id position added in the 0.5.0 id work: for each shape
// (tuple slots, scalar-form elements, entry-form map keys, part ids, spawner tags, damage types,
// nested-in-tuple lists) drive completion, go-to-definition, hover, find-references and rename, so
// a regression in any one wiring shows up as a named cell rather than a user report.
const token = CancellationToken.None;

/**
 * First value node whose written value is `text`, searching depth-first.
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

/**
 * The line/character position of the first occurrence of `needle` in `src`, plus `offset` chars.
 *
 * @param src the source text to search.
 * @param needle the text whose first occurrence is wanted.
 * @param offset how many characters past the occurrence the position should sit.
 * @returns the line and character of that position.
 */
const positionOf = (src: string, needle: string, offset = 1) => {
    const at = src.indexOf(needle);
    const before = src.slice(0, at);
    const line = before.split('\n').length - 1;
    const character = at - (before.lastIndexOf('\n') + 1) + offset;
    return { line, character };
};

describe('id shape and feature matrix', () => {
    let dir: string;
    let folders: string[];

    beforeAll(async () => {
        dir = await mkdtemp(join(tmpdir(), 'cosmo-matrix-'));
        await mkdir(join(dir, 'resources'), { recursive: true });
        await writeFile(join(dir, 'resources', 'battery.rules'), 'ID = battery\nNameKey = "x"\nBuyPrice = 1\n');
        await mkdir(join(dir, 'parts'), { recursive: true });
        await writeFile(join(dir, 'parts', 'armor.rules'), 'Part\n{\n\tID = test.armor\n\tOtherIDs = [old.armor]\n\tMaxHealth = 100\n}\n');
        // A live part referencing the armor part, on disk so find-references and rename can see it.
        await writeFile(join(dir, 'parts', 'wedge.rules'), 'Part\n{\n\tID = test.wedge\n\tEditorParentParts = ["test.armor"]\n}\n');
        await mkdir(join(dir, 'ships'), { recursive: true });
        await writeFile(
            join(dir, 'ships', 'terran.rules'),
            'RenderLayers\n[\n\t{\n\t\tKey = "structure"\n\t\tValue\n\t\t{\n\t\t\tUniqueBucket = true\n\t\t}\n\t}\n\t{\n\t\tKey = "doors"\n\t\tValue\n\t\t{\n\t\t\tUniqueBucket = : ^/0/Value/UniqueBucket ["structure"]\n\t\t}\n\t}\n]\n'
        );
        await mkdir(join(dir, 'modes', 'sectors'), { recursive: true });
        await writeFile(
            join(dir, 'modes', 'sectors', 'sysgen.rules'),
            'Type = None\nTags = [hub_tag]\nRootLocationTag = hub_tag\nSubSpawners\n[\n]\nWeight = 1\n'
        );
        await writeFile(join(dir, 'factions.rules'), 'Factions\n[\n\t{\n\t\tID = monolith\n\t}\n]\n');
        await writeFile(join(dir, 'effect.rules'), 'Type = ExplosiveDamage\nDamageType = fire\nDamageAmount = 100\n');
        folders = [pathToFileURL(dir).href];
        SchemaIdIndex.instance.reset();
    });
    afterAll(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    const parse = (src: string, uri = 'file:///mod/parts/probe.rules') => parser(lexer(src), uri).value;
    const labelsFor = async (node: ValueNode | undefined) =>
        (await SchemaIdIndex.instance.idCompletions(node!, folders, token)).map((c) =>
            typeof c === 'string' ? c : c.label
        );

    describe('damage-type map keys', () => {
        const SRC = 'Part\n{\n\tDamageResistances\n\t{\n\t\tfire = 50%\n\t}\n}';

        it('goto jumps from the key to the declaring hit effect', async () => {
            const doc = parse(SRC);
            const location = singleLocation(await DefinitionService.instance.getDefinition(doc, positionOf(SRC, 'fire = 50%'), token, folders));
            expect(location.uri.toLowerCase()).toContain('effect.rules');
        });

        it('find-references finds the usage and the declaration', async () => {
            const src = readFileSync(join(dir, 'effect.rules'), 'utf8');
            const doc = parser(lexer(src), pathToFileURL(join(dir, 'effect.rules')).href).value;
            const locations = await ReferenceIndex.instance.findReferences(doc, positionOf(src, 'fire', 1), true, folders, token);
            expect(locations.length).toBeGreaterThanOrEqual(1);
            expect(locations.some((l) => l.uri.toLowerCase().includes('effect.rules'))).toBe(true);
        });
    });

    describe('nested list inside a tuple slot', () => {
        const SRC = 'Galaxy\n{\n\tType = StartingNodePicker\n\tCandidatesClosestToFactions = [3, [monolith]]\n}';

        it('goto jumps from the nested faction to its declaration', async () => {
            const doc = parse(SRC);
            const location = singleLocation(
                await DefinitionService.instance.getDefinition(doc, positionOf(SRC, 'monolith'), token, folders)
            );
            expect(location.uri.toLowerCase()).toContain('factions.rules');
        });

        it('hover shows where the nested faction id is defined', async () => {
            const doc = parse(SRC);
            const hover = await HoverService.instance.getHover(doc, positionOf(SRC, 'monolith'), token, folders);
            const value = typeof hover?.contents === 'object' && 'value' in hover.contents ? hover.contents.value : '';
            expect(value).toContain('factions.rules');
        });
    });

    describe('tuple resource slots', () => {
        const SRC = 'Part\n{\n\tResources\n\t[\n\t\t[battery, 20]\n\t]\n}';

        it('hover on the tuple resource id shows the declaring file', async () => {
            const doc = parse(SRC);
            const hover = await HoverService.instance.getHover(doc, positionOf(SRC, 'battery'), token, folders);
            const value = typeof hover?.contents === 'object' && 'value' in hover.contents ? hover.contents.value : '';
            expect(value).toContain('battery.rules');
        });
    });

    describe('part ids', () => {
        it('find-references from the usage finds the declaration and the usage', async () => {
            const src = readFileSync(join(dir, 'parts', 'wedge.rules'), 'utf8');
            const doc = parser(lexer(src), pathToFileURL(join(dir, 'parts', 'wedge.rules')).href).value;
            const locations = await ReferenceIndex.instance.findReferences(
                doc,
                positionOf(src, '"test.armor"', 2),
                true,
                folders,
                token
            );
            const uris = locations.map((l) => l.uri.toLowerCase());
            expect(uris.some((u) => u.includes('armor.rules'))).toBe(true); // the `ID = test.armor` declaration
            expect(uris.some((u) => u.includes('wedge.rules'))).toBe(true); // the EditorParentParts usage
        });

        it('rename rewrites the declaration and the usage together', async () => {
            const src = readFileSync(join(dir, 'parts', 'wedge.rules'), 'utf8');
            const doc = parser(lexer(src), pathToFileURL(join(dir, 'parts', 'wedge.rules')).href).value;
            const edit = await RenameService.instance.rename(doc, positionOf(src, '"test.armor"', 2), 'test.plate', folders, token);
            expect(edit).not.toBeNull();
            const changed = Object.keys(edit!.changes!).map((u) => u.toLowerCase());
            expect(changed.some((u) => u.includes('armor.rules'))).toBe(true);
            expect(changed.some((u) => u.includes('wedge.rules'))).toBe(true);
        });

        it('hover on a part-id reference shows the declaring file', async () => {
            const src = readFileSync(join(dir, 'parts', 'wedge.rules'), 'utf8');
            const doc = parser(lexer(src), pathToFileURL(join(dir, 'parts', 'wedge.rules')).href).value;
            const hover = await HoverService.instance.getHover(doc, positionOf(src, '"test.armor"', 2), token, folders);
            const value = typeof hover?.contents === 'object' && 'value' in hover.contents ? hover.contents.value : '';
            expect(value).toContain('armor.rules');
        });
    });

    describe('spawner tags', () => {
        it('find-references on a tag finds the declaration and the reference', async () => {
            const src = readFileSync(join(dir, 'modes', 'sectors', 'sysgen.rules'), 'utf8');
            const doc = parser(lexer(src), pathToFileURL(join(dir, 'modes', 'sectors', 'sysgen.rules')).href).value;
            const locations = await ReferenceIndex.instance.findReferences(
                doc,
                positionOf(src, 'RootLocationTag = hub_tag', 'RootLocationTag = '.length),
                true,
                folders,
                token
            );
            expect(locations.length).toBeGreaterThanOrEqual(2); // the Tags entry and the RootLocationTag use
        });
    });

    describe('entry-form map keys', () => {
        it('find-references on a key finds declaration and reference across entries', async () => {
            const src = readFileSync(join(dir, 'ships', 'terran.rules'), 'utf8');
            const doc = parser(lexer(src), pathToFileURL(join(dir, 'ships', 'terran.rules')).href).value;
            // The inheriting `["structure"]` list element references the first entry's key.
            const locations = await ReferenceIndex.instance.findReferences(
                doc,
                positionOf(src, 'Key = "structure"', 'Key = "'.length),
                true,
                folders,
                token
            );
            expect(locations.length).toBeGreaterThanOrEqual(1);
        });

        it('the empty `Key = ` offset position resolves the map key target', () => {
            const src = 'RenderLayers\n[\n\t{\n\t\tKey = \n\t}\n]\n';
            const doc = parse(src, 'file:///mod/ships/probe.rules');
            const offset = src.indexOf('Key = ') + 'Key = '.length;
            expect(crossFileReferenceTargetAtOffset(doc, offset, '\t\tKey = ')).toBe('Cosmoteer.Ships.ShipRenderLayerRules');
        });

        it('completion at a typed key offers the declared layers', async () => {
            const src = 'RenderLayers\n[\n\t{\n\t\tKey = doors\n\t\tValue { }\n\t}\n]\n';
            const labels = await labelsFor(findValueByText(parse(src, 'file:///mod/ships/probe.rules'), 'doors'));
            expect(labels).toContain('structure');
        });
    });

    describe('route-tuple component ids (same file)', () => {
        const SRC = `Part
{
	Components
	{
		Port_Down { Type = MultiToggle; Mode = All }
		Router
		{
			Type = NetworkRouter
			RouteGenerators
			[
				{
					Type = Bidirectional
					Routes
					[
						[Port_Down, Port_Down, 0]
					]
				}
			]
		}
	}
}`;

        it('find-references on the component finds the tuple usages', async () => {
            const doc = parse(SRC);
            const locations = await ReferenceIndex.instance.findReferences(doc, positionOf(SRC, 'Port_Down {', 2), true, [], token);
            expect(locations.length).toBeGreaterThanOrEqual(3); // declaration and both tuple slots
        });

        it('rename rewrites the component and its tuple usages', async () => {
            const doc = parse(SRC);
            const edit = await RenameService.instance.rename(doc, positionOf(SRC, 'Port_Down {', 2), 'Port_Up', [], token);
            expect(edit).not.toBeNull();
            const edits = Object.values(edit!.changes!)[0];
            expect(edits.length).toBeGreaterThanOrEqual(3);
            expect(edits.every((e) => e.newText === 'Port_Up')).toBe(true);
        });

        it('hover on a route endpoint describes the component', async () => {
            const doc = parse(SRC);
            const hover = await HoverService.instance.getHover(doc, positionOf(SRC, '[Port_Down', 2), token, []);
            const value = typeof hover?.contents === 'object' && 'value' in hover.contents ? hover.contents.value : '';
            expect(value).toContain('Port_Down');
        });
    });

    describe('scalar-form component fields (FireTrigger = Turret)', () => {
        const SRC = `Part
{
	Components
	{
		Turret { Type = TurretWeapon }
		BulletEmitter
		{
			Type = BulletEmitter
			FireTrigger = Turret
		}
	}
}`;

        it('goto jumps from the scalar trigger to the component', async () => {
            const doc = parse(SRC);
            const at = positionOf(SRC, 'FireTrigger = Turret', 'FireTrigger = '.length + 1);
            const location = singleLocation(await DefinitionService.instance.getDefinition(doc, at, token, []));
        });

        it('hover on the scalar trigger describes the component', async () => {
            const doc = parse(SRC);
            const at = positionOf(SRC, 'FireTrigger = Turret', 'FireTrigger = '.length + 1);
            const hover = await HoverService.instance.getHover(doc, at, token, []);
            const value = typeof hover?.contents === 'object' && 'value' in hover.contents ? hover.contents.value : '';
            expect(value).toContain('Turret');
        });

        it('the empty `FireTrigger = ` value position resolves the component target', () => {
            const src = 'Part\n{\n\tComponents\n\t{\n\t\tEmitter\n\t\t{\n\t\t\tType = BulletEmitter\n\t\t\tFireTrigger = \n\t\t}\n\t}\n}';
            const doc = parse(src);
            const offset = src.indexOf('FireTrigger = ') + 'FireTrigger = '.length;
            expect(crossFileReferenceTargetAtOffset(doc, offset, '\t\t\tFireTrigger = ')).toBe(
                'Cosmoteer.Ships.Parts.PartComponentRules'
            );
        });

        it('validation flags a scalar trigger naming no component', async () => {
            const src = SRC.replace('FireTrigger = Turret', 'FireTrigger = Turet');
            const { validateSchemaSiblingReferences } = await import(
                '../../../src/features/diagnostics/validator.schema-sibling'
            );
            const errors = await validateSchemaSiblingReferences(parse(src), token);
            expect(errors.map((e) => e.message)).toEqual(["No component named 'Turet' in this part."]);
        });

        it('validation accepts a scalar trigger naming a declared component', async () => {
            const { validateSchemaSiblingReferences } = await import(
                '../../../src/features/diagnostics/validator.schema-sibling'
            );
            expect(await validateSchemaSiblingReferences(parse(SRC), token)).toEqual([]);
        });

        it('find-references on the component finds the scalar trigger usage', async () => {
            const doc = parse(SRC);
            const locations = await ReferenceIndex.instance.findReferences(doc, positionOf(SRC, 'Turret {', 2), true, [], token);
            expect(locations.length).toBeGreaterThanOrEqual(2); // the declaration and the FireTrigger value
        });

        it('rename rewrites the component and the scalar trigger together', async () => {
            const doc = parse(SRC);
            const edit = await RenameService.instance.rename(doc, positionOf(SRC, 'Turret {', 2), 'MainTurret', [], token);
            expect(edit).not.toBeNull();
            const edits = Object.values(edit!.changes!)[0];
            expect(edits.length).toBeGreaterThanOrEqual(2);
            expect(edits.every((e) => e.newText === 'MainTurret')).toBe(true);
        });

        it('a half-typed scalar trigger in an unclosed buffer resolves the component target', async () => {
            const src = 'Part\n{\n\tComponents\n\t{\n\t\tTurret { Type = TurretWeapon }\n\t\tEmitter\n\t\t{\n\t\t\tType = BulletEmitter\n\t\t\tFireTrigger = Tur';
            const doc = parse(src);
            const { schemaReferenceFieldOf } = await import('../../../src/features/navigation/schema-id-reference.navigation');
            const ref = schemaReferenceFieldOf(findValueByText(doc, 'Tur')!);
            expect(ref?.targetClass).toBe('Cosmoteer.Ships.Parts.PartComponentRules');
            const { componentIdCompletionsForTarget } = await import(
                '../../../src/features/completion/autocompletion.component-id'
            );
            const names = (await componentIdCompletionsForTarget(ref!.targetClass, doc, token))!.map((c) => (typeof c === 'string' ? c : c.label));
            expect(names).toContain('Turret');
        });
    });

    describe('other scalar payload classes', () => {
        it('a scalar spawner search (`SpawnAtTag = tag`) resolves and navigates as a tag', async () => {
            const src = 'Type = None\nSubSpawners\n[\n\t{\n\t\tType = Mission\n\t\tSpawnAt = Tag\n\t\tSpawnAtTag = hub_tag\n\t}\n]\nWeight = 1\n';
            const uri = pathToFileURL(join(dir, 'modes', 'sectors', 'probe.rules')).href;
            const doc = parser(lexer(src), uri).value;
            const { schemaReferenceFieldOf } = await import('../../../src/features/navigation/schema-id-reference.navigation');
            const ref = schemaReferenceFieldOf(findValueByText(doc, 'hub_tag')!);
            expect(ref?.targetClass).toBe('Cosmoteer.Generators.Simulation.SimObjectSpawner');
            const location = singleLocation(
                await DefinitionService.instance.getDefinition(doc, positionOf(src, 'SpawnAtTag = hub_tag', 'SpawnAtTag = '.length + 1), token, folders)
            );
            expect(location.uri.toLowerCase()).toContain('sysgen.rules');
        });

        it('a scalar ship entry (`Ships = [id]`) resolves the builtin-ship target', async () => {
            const src = 'Type = None\nSubSpawners\n[\n\t{\n\t\tType = Ships\n\t\tShips = [some.ship]\n\t}\n]\nWeight = 1\n';
            const doc = parse(src, 'file:///mod/modes/sectors/probe.rules');
            const { schemaReferenceFieldOf } = await import('../../../src/features/navigation/schema-id-reference.navigation');
            const ref = schemaReferenceFieldOf(findValueByText(doc, 'some.ship')!);
            expect(ref?.targetClass).toBe('Cosmoteer.Data.BuiltinShipRules');
        });
    });

    describe('component trigger group form (TriggerID builtins)', () => {
        it('the empty `TriggerID = ` position resolves the provider interface', () => {
            const src =
                'Part\n{\n\tComponents\n\t{\n\t\tEmitter\n\t\t{\n\t\t\tType = BulletEmitter\n\t\t\tFireTrigger\n\t\t\t{\n\t\t\t\tID = Turret\n\t\t\t\tTriggerID = \n\t\t\t}\n\t\t}\n\t}\n}';
            const doc = parse(src);
            const offset = src.indexOf('TriggerID = ') + 'TriggerID = '.length;
            expect(crossFileReferenceTargetAtOffset(doc, offset, '\t\t\t\tTriggerID = ')).toBe(
                'Cosmoteer.Ships.Parts.Logic.IComponentTriggerProvider'
            );
        });

        it('completion for the provider interface offers the code-registered trigger names', async () => {
            const labels = (
                await SchemaIdIndex.instance.idCompletionsForClass(
                    'Cosmoteer.Ships.Parts.Logic.IComponentTriggerProvider',
                    folders,
                    token
                )
            ).map((c) => (typeof c === 'string' ? c : c.label));
            expect(labels).toContain('HitIntervalElapsed');
            expect(labels).toContain('CrewResourcesReceived');
        });
    });

    describe('damage-type resistance validation', () => {
        it('flags a resistance key naming a damage type nothing deals', async () => {
            const { validateCrossFileIdReferences } = await import(
                '../../../src/features/diagnostics/validator.schema-id-reference'
            );
            const doc = parse('Part\n{\n\tDamageResistances\n\t{\n\t\tfyre = 50%\n\t}\n}');
            const errors = await validateCrossFileIdReferences(doc, folders, token);
            expect(errors.map((e) => e.message)).toEqual(["No DamageType named 'fyre' in the project."]);
        });

        it('accepts declared and code-registered damage types', async () => {
            const { validateCrossFileIdReferences } = await import(
                '../../../src/features/diagnostics/validator.schema-id-reference'
            );
            const doc = parse('Part\n{\n\tDamageResistances\n\t{\n\t\tfire = 50%\n\t\texplosive = 25%\n\t}\n}');
            expect(await validateCrossFileIdReferences(doc, folders, token)).toEqual([]);
        });
    });

    describe('part-wide component references (inherited base)', () => {
        const SRC = `BasePart
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

        it('hover describes a component declared only in the inherited base', async () => {
            const doc = parse(SRC);
            const hover = await HoverService.instance.getHover(doc, positionOf(SRC, '= HiddenToggle', 3), token, []);
            const value = typeof hover?.contents === 'object' && 'value' in hover.contents ? hover.contents.value : '';
            expect(value).toContain('HiddenToggle');
        });
    });

    describe('typing states: half-typed ids in unclosed buffers', () => {
        // The buffer as it exists mid-keystroke: nothing after the caret, every container unclosed.
        it('a half-typed resource in an unclosed tuple completes', async () => {
            const doc = parse('Part\n{\n\tResources\n\t[\n\t\t[bat');
            const labels = await labelsFor(findValueByText(doc, 'bat'));
            expect(labels).toContain('battery');
        });

        it('a half-typed part id in an unclosed EditorParentParts completes', async () => {
            const doc = parse('Part\n{\n\tEditorParentParts = [test.arm');
            const labels = await labelsFor(findValueByText(doc, 'test.arm'));
            expect(labels).toContain('test.armor');
        });

        it('a half-typed entry key in an unclosed RenderLayers completes', async () => {
            const doc = parse('RenderLayers\n[\n\t{\n\t\tKey = str', 'file:///mod/ships/probe.rules');
            const labels = await labelsFor(findValueByText(doc, 'str'));
            expect(labels).toContain('structure');
        });

        it('a half-typed route endpoint in an unclosed Routes tuple resolves part-wide', async () => {
            const src =
                'Part\n{\n\tComponents\n\t{\n\t\tPort_Down { Type = MultiToggle; Mode = All }\n\t\tRouter\n\t\t{\n\t\t\tType = NetworkRouter\n\t\t\tRouteGenerators\n\t\t\t[\n\t\t\t\t{\n\t\t\t\t\tType = Bidirectional\n\t\t\t\t\tRoutes\n\t\t\t\t\t[\n\t\t\t\t\t\t[Po';
            const doc = parse(src);
            const { componentIdCompletionsForTarget } = await import(
                '../../../src/features/completion/autocompletion.component-id'
            );
            const result = await componentIdCompletionsForTarget('Cosmoteer.Ships.Parts.PartComponentRules', doc, token);
            const names = result!.map((c) => (typeof c === 'string' ? c : c.label));
            expect(names).toContain('Port_Down');
        });
    });

    describe('scalar-form list elements at an empty offset', () => {
        it('the empty `EditorParentParts = ` value position resolves the part target', () => {
            const src = 'Part\n{\n\tEditorParentParts = \n}';
            const doc = parse(src);
            const offset = src.indexOf('= ') + 2;
            expect(crossFileReferenceTargetAtOffset(doc, offset, '\tEditorParentParts = ')).toBe(
                'Cosmoteer.Ships.Parts.PartRules'
            );
        });

        it('inside the empty `[ ]` no scaffold is offered, so the id fallback can run', async () => {
            // A scalar-form element class must not scaffold `{ … }` blocks. The server then falls
            // through to the enclosing-list target resolution (covered in the schema-context tests)
            // and offers part ids.
            const src = 'Part\n{\n\tEditorParentParts = [ ]\n}';
            const doc = parse(src);
            const offset = src.indexOf('[ ]') + 1;
            const { schemaFieldNameCompletions } = await import(
                '../../../src/features/completion/autocompletion.schema-fields'
            );
            expect(await schemaFieldNameCompletions(doc, offset, token)).toEqual([]);
        });
    });
});
