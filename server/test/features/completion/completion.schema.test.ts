import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import {
    AbstractNode,
    GroupNode,
    isAssignmentNode,
    isGroupNode,
    isListNode,
    isValueNode,
    ValueNode,
} from '../../../src/core/ast/ast';
import { AutoCompletionSchema } from '../../../src/features/completion/autocompletion.schema';
import { componentIdCompletionsForTarget } from '../../../src/features/completion/autocompletion.component-id';
import {
    schemaFieldNameCompletions,
    schemaValueCompletionsAtOffset,
} from '../../../src/features/completion/autocompletion.schema-fields';
import { Completion } from '../../../src/features/completion/autocompletion.service';
import { classByDiscriminator } from '../../../src/document/schema/schema';
import { resolveGroupClass } from '../../../src/document/schema/schema-context';
import { documentRootClass } from '../../../src/document/schema/document-root';

const findGroup = (node: AbstractNode, id: string): GroupNode | undefined => {
    if (isGroupNode(node) && node.identifier?.name === id) return node;
    const kids = isGroupNode(node) || isListNode(node) ? node.elements : [];
    for (const k of kids) {
        const f = findGroup(k, id);
        if (f) return f;
    }
    return undefined;
};

const parseUri = (src: string, uri: string) => parser(lexer(src), uri).value;
const fieldLabels = (cs: Completion[]) => cs.map((c) => (typeof c === 'string' ? c : c.label));

const token = CancellationToken.None;
const completer = new AutoCompletionSchema();
const parse = (src: string) => parser(lexer(src), 'file:///t.rules').value;

/** First value node that is the RHS of an assignment named `field`, searching depth-first. */
const findValue = (node: AbstractNode, field: string): ValueNode | undefined => {
    if (isAssignmentNode(node) && node.left.name === field && isValueNode(node.right)) return node.right;
    const children = isGroupNode(node) || isListNode(node) ? node.elements : isAssignmentNode(node) ? [node.right] : [];
    for (const child of children) {
        const found = findValue(child, field);
        if (found) return found;
    }
    return undefined;
};

const labels = async (value: ValueNode | undefined): Promise<string[]> => {
    expect(value).toBeDefined();
    const results: Completion[] = await completer.getCompletions(value!, token);
    return results.map((c) => (typeof c === 'string' ? c : c.label));
};

// A part-shaped fixture: a Components container whose children dispatch on `Type=`.
const PART = `
Part
{
    Components
    {
        IsOperational
        {
            Type = MultiToggle
            Mode = All
        }
        Turret
        {
            Type = TurretWeapon
            ReturnToCenter = true
        }
    }
}
`;

describe('AutoCompletionSchema — schema-driven value completion', () => {
    it('completes an enum field (Mode) with its members, via the group’s Type', async () => {
        const doc = parse(PART);
        for (const node of doc.elements) {
            const mode = findValue(node, 'Mode');
            if (mode) {
                expect((await labels(mode)).sort()).toEqual(['All', 'Any', 'None', 'One']);
                return;
            }
        }
        throw new Error('Mode value not found');
    });

    it('completes Type= with the PartComponentRules discriminators (registry inferred from siblings)', async () => {
        const doc = parse(PART);
        const type = doc.elements.map((n) => findValue(n, 'Type')).find(Boolean);
        const result = await labels(type);
        expect(result).toContain('TurretWeapon');
        expect(result).toContain('MultiToggle');
        expect(result).toContain('BulletEmitter');
        expect(result.length).toBeGreaterThan(100); // ~147 component types
    });

    it('completes a boolean field (ReturnToCenter) with true/false', async () => {
        const doc = parse(PART);
        const flag = doc.elements.map((n) => findValue(n, 'ReturnToCenter')).find(Boolean);
        expect((await labels(flag)).sort()).toEqual(['false', 'true']);
    });

    it('completes an ID<> reference field with sibling component names', async () => {
        const src = `Part
{
	Components
	{
		IsOperational { Type = MultiToggle; Mode = All }
		PowerToggle { Type = UIToggle }
		Turret { Type = TurretWeapon; OperationalToggle = x }
	}
}`;
        const doc = parse(src);
        const ref = doc.elements.map((n) => findValue(n, 'OperationalToggle')).find(Boolean);
        const result = await labels(ref);
        expect(result).toContain('IsOperational');
        expect(result).toContain('PowerToggle');
        expect(result).not.toContain('Turret'); // self excluded
    });

    it('offers component ids from an inherited base part (part-wide, beyond direct siblings)', async () => {
        // The engine resolves an `ID<PartComponent>` part-wide, so a component declared only in the
        // inherited base must complete too (previously only same-container siblings were offered).
        const src = `BasePart
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
		IsOperational { Type = MultiToggle; Mode = All }
		Turret { Type = TurretWeapon; OperationalToggle = x }
	}
}`;
        const doc = parse(src);
        const ref = doc.elements.map((n) => findValue(n, 'OperationalToggle')).find(Boolean);
        const result = await completer.getCompletions(ref!, token);
        const names = result.map((c) => (typeof c === 'string' ? c : c.label));
        expect(names).toContain('IsOperational'); // direct sibling
        expect(names).toContain('HiddenToggle'); // inherited base component
        expect(names).not.toContain('Turret'); // self excluded
        // Siblings sort above the inherited part-wide ids.
        const sortOf = (label: string) =>
            result.map((c) => (typeof c === 'string' ? undefined : c)).find((c) => c?.label === label)?.sortText;
        expect(sortOf('IsOperational')!.localeCompare(sortOf('HiddenToggle')!)).toBeLessThan(0);
    });

    it('serves a part-component target (a router Routes tuple slot) from the part-wide union', async () => {
        const src = `Part
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
						[Port_Down, x, 0]
					]
				}
			]
		}
	}
}`;
        const doc = parse(src);
        const result = await componentIdCompletionsForTarget('Cosmoteer.Ships.Parts.PartComponentRules', doc, token);
        const names = result!.map((c) => (typeof c === 'string' ? c : c.label));
        expect(names).toContain('Port_Down');
        expect(names).toContain('HeatSink');
        expect(names).toContain('Router');
        // A cross-file target stays with the id index, not the component union.
        expect(await componentIdCompletionsForTarget('Cosmoteer.Resources.ResourceRules', doc, token)).toBeUndefined();
    });

    it('offers no local ids inside a cross-part proxy (its ComponentID targets the adjacent part)', async () => {
        const src = `Part
{
	Components
	{
		LocalStorage { Type = ResourceStorage; ResourceType = bullet }
		AmmoProxy
		{
			Type = ResourceStorageProxy
			PartLocation = [0, 4]
			ComponentID = x
		}
	}
}`;
        const doc = parse(src);
        const ref = doc.elements.map((n) => findValue(n, 'ComponentID')).find(Boolean);
        expect(await labels(ref)).toEqual([]);
    });

    it('completes a whole-file root’s top-level Type= with the root registry discriminators', async () => {
        // A doodad file's top-level `Type = …` is dispatched within DoodadRules (known by folder).
        const doc = parseUri('ID = test\nType = x\n', 'file:///c%3A/mod/doodads/x/test.rules');
        const type = doc.elements.map((n) => findValue(n, 'Type')).find(Boolean);
        const result = await labels(type);
        expect(result).toContain('GeneratedShip');
        expect(result.length).toBeGreaterThan(1);
    });

    it('completes Type= inside a typed LIST element (container is a List, registry from the slot)', async () => {
        // A nebula file's `ActiveEffects [ { Type = … } ]` — elements are NebulaActiveEffectRules.
        const src = 'ID = test\nToolTipKey = "x"\nActiveEffects\n[\n\t{\n\t\tType = x\n\t}\n]\n';
        const doc = parseUri(src, 'file:///c%3A/mod/nebulas/test.rules');
        const type = doc.elements.map((n) => findValue(n, 'Type')).find(Boolean);
        const result = await labels(type);
        expect(result).toContain('DamageCrew');
        expect(result).toContain('LightningStrikes');
    });

    it('returns nothing for a field with no schema (free-form group)', async () => {
        const doc = parse(`Foo { Bar = baz }`);
        const bar = doc.elements.map((n) => findValue(n, 'Bar')).find(Boolean);
        expect(await labels(bar)).toEqual([]);
    });

    // The first value node inside the `[list]` assigned to `field`, searching depth-first.
    const findListValue = (node: AbstractNode, field: string): ValueNode | undefined => {
        if (isAssignmentNode(node) && node.left.name === field && isListNode(node.right)) {
            return node.right.elements.find(isValueNode);
        }
        const children = isGroupNode(node) || isListNode(node) ? node.elements : isAssignmentNode(node) ? [node.right] : [];
        for (const child of children) {
            const found = findListValue(child, field);
            if (found) return found;
        }
        return undefined;
    };

    it('completes an enum value inside a map entry’s Value list (ExternalWallsByCell → AdjacencyFlags)', async () => {
        // A part's `ExternalWallsByCell` is a `map<IntVector2, AdjacencyFlags>` serialized as
        // `[{ Key=…; Value=[Edge, …] }]`. The entry group has no class, so `Value` resolves through
        // the enclosing map field to the flags enum.
        const src = `Part
{
	ExternalWallsByCell
	[
		{
			Key = [0, 0]
			Value = [T]
		}
	]
}`;
        const value = parse(src).elements.map((n) => findListValue(n, 'Value')).find(Boolean);
        const result = await labels(value);
        expect(result).toContain('TopLeft');
        expect(result).toContain('Top');
        expect(result).toContain('BottomRight');
    });
});

describe('schemaFieldNameCompletions — field-NAME completion inside a typed group', () => {
    // A blank (tabs-only) line inside a Turret component → its class is TurretWeaponRules.
    const SRC = 'Part\n{\n\tComponents\n\t{\n\t\tTurret\n\t\t{\n\t\t\tType = TurretWeapon\n\t\t\t\n\t\t}\n\t}\n}';
    const gapOffset = SRC.indexOf('\n', SRC.indexOf('Type = TurretWeapon')) + 3; // inside the blank line

    it('offers the resolved class’s fields, excluding ones already present', async () => {
        const doc = parse(SRC);
        const labels = (await schemaFieldNameCompletions(doc, gapOffset, token)).map((c) => (typeof c === 'string' ? c : c.label));
        expect(labels).toContain('FiringArc');
        expect(labels).toContain('RotateSpeed');
        expect(labels).not.toContain('Type'); // already written
        expect(labels.length).toBeGreaterThan(20);
    });

    it('excludes a bare valueless field (`FiringArc` on its own line) like an assigned one', async () => {
        // Vanilla particle files write valueless members (`ScaleIn` with no `=`), which the game
        // reads as present. They parse as lone identifiers, and must still count as present.
        const src = SRC.replace('Type = TurretWeapon\n\t\t\t', 'Type = TurretWeapon\n\t\t\tFiringArc\n\t\t\t');
        const offset = src.indexOf('\n', src.indexOf('FiringArc')) + 4; // blank line after the bare field
        const doc = parse(src);
        const labels = (await schemaFieldNameCompletions(doc, offset, token)).map((c) => (typeof c === 'string' ? c : c.label));
        expect(labels).toContain('RotateSpeed');
        expect(labels).not.toContain('FiringArc'); // present as a bare valueless member
    });

    it('omits positional digit fields (`0`/`1`) inside a Vector2-typed group', async () => {
        // Vector2 (and Color, Rect, …) carry schema fields `0`/`1` so list-form `[7.2, 7.2]`
        // elements type-resolve. Inside `{}` only the named components are useful suggestions.
        const src =
            'Part\n{\n\tComponents\n\t{\n\t\tDoor\n\t\t{\n\t\t\tType = Airlock\n\t\t\tEnterExitPoint\n\t\t\t{\n\t\t\t\t\n\t\t\t}\n\t\t}\n\t}\n}';
        const offset = src.indexOf('\t\t\t\t\n') + 4; // inside the blank line of EnterExitPoint's body
        const doc = parse(src);
        const labels = (await schemaFieldNameCompletions(doc, offset, token)).map((c) => (typeof c === 'string' ? c : c.label));
        expect(labels).toContain('X');
        expect(labels).toContain('Y');
        expect(labels).not.toContain('0');
        expect(labels).not.toContain('1');
    });

    it('attaches schema signature documentation to each field-name completion', async () => {
        const doc = parse(SRC);
        const items = (await schemaFieldNameCompletions(doc, gapOffset, token)).filter(
            (c): c is Exclude<typeof c, string> => typeof c !== 'string'
        );
        const firingArc = items.find((c) => c.label === 'FiringArc');
        expect(firingArc?.documentation).toContain('**FiringArc**');
        expect(firingArc?.documentation).toContain('`'); // type rendered in code span
    });

    it('offers a single completion that scaffolds all missing required fields', async () => {
        const doc = parse(SRC);
        const items = (await schemaFieldNameCompletions(doc, gapOffset, token)).filter(
            (c): c is Exclude<typeof c, string> => typeof c !== 'string'
        );
        const bundle = items.find((c) => /Insert \d+ required fields/.test(c.label));
        expect(bundle).toBeDefined();
        expect(bundle!.isSnippet).toBe(true);
        // multiple numbered tab stops, one per required field, and it includes FiringArc
        expect(bundle!.insertText).toMatch(/\$1/);
        expect(bundle!.insertText).toMatch(/\$2/);
        expect(bundle!.insertText).toContain('FiringArc');
    });

    it('inserts a field scaffold snippet (scalar `= $0`; structural block)', async () => {
        const doc = parse(SRC);
        const items = (await schemaFieldNameCompletions(doc, gapOffset, token)).filter(
            (c): c is Exclude<typeof c, string> => typeof c !== 'string'
        );
        const firingArc = items.find((c) => c.label === 'FiringArc');
        expect(firingArc?.isSnippet).toBe(true);
        expect(firingArc?.insertText).toBe('FiringArc = $0');
        // at least one field is structural (group/list) → its snippet opens a block
        expect(items.some((c) => /\n\{|\n\[/.test(c.insertText ?? ''))).toBe(true);
    });

    it('offers PartRules fields at the root Part group', async () => {
        const src = 'Part\n{\n\tID = cosmoteer.test\n\t\n}';
        const doc = parse(src);
        const offset = src.indexOf('\n', src.indexOf('ID = cosmoteer.test')) + 2;
        const labels = fieldLabels(await schemaFieldNameCompletions(doc, offset, token));
        expect(labels).toContain('MaxHealth');
        expect(labels).toContain('Size');
        expect(labels).not.toContain('ID');
    });

    it('suggests `Type` first in a polymorphic group that has not chosen its subtype', async () => {
        // NewComp sits in a Components container (PartComponentRules, proven by the typed sibling) but
        // has no Type yet → the only useful completion is `Type` (not a schema field; injected).
        const src = 'Part\n{\n\tComponents\n\t{\n\t\tExisting { Type = MultiToggle }\n\t\tNewComp\n\t\t{\n\t\t\t\n\t\t}\n\t}\n}';
        const doc = parse(src);
        const offset = src.indexOf('NewComp\n\t\t{\n\t\t\t') + 'NewComp\n\t\t{\n\t\t\t'.length;
        const items = (await schemaFieldNameCompletions(doc, offset, token)).filter(
            (c): c is Exclude<typeof c, string> => typeof c !== 'string'
        );
        const type = items.find((c) => c.label === 'Type');
        expect(type).toBeDefined();
        expect(type!.insertText).toBe('Type = $0');
        expect(type!.sortText).toBe('0'); // sorts above all other fields
    });

    it('resolves the class THROUGH inheritance when a group has no own Type (`MyTurret : BaseTurret`)', async () => {
        const src =
            'Part\n{\n\tComponents\n\t{\n\t\tBaseTurret\n\t\t{\n\t\t\tType = TurretWeapon\n\t\t}\n\t\tMyTurret : BaseTurret\n\t\t{\n\t\t\t\n\t\t}\n\t}\n}';
        const doc = parse(src);
        const offset = src.indexOf('MyTurret : BaseTurret\n\t\t{\n\t\t\t') + 'MyTurret : BaseTurret\n\t\t{\n\t\t\t'.length;
        const labels = fieldLabels(await schemaFieldNameCompletions(doc, offset, token));
        // MyTurret declares no Type but inherits TurretWeapon from BaseTurret → TurretWeaponRules fields.
        expect(labels).toContain('FiringArc');
        expect(labels).toContain('RotateSpeed');
    });

    it('descends a concrete group field to its class, resolving the ISprite slot to concrete Sprite', () => {
        const doc = parse('Part\n{\n\tEditorIcon\n\t{\n\t\tSize = [1, 1]\n\t}\n}');
        const editorIcon = doc.elements.map((n) => findGroup(n, 'EditorIcon')).find(Boolean);
        expect(editorIcon).toBeDefined();
        // `EditorIcon` is typed as the abstract `ISprite`; it is always deserialized as the concrete
        // `Sprite` (which extends Material), so the slot resolves to that for fuller completion.
        expect(resolveGroupClass(editorIcon!)).toBe('Halfling.Graphics.Sprite');
    });

    it('WHOLE-FILE root: offers BulletRules fields at a shot file’s top level', async () => {
        const src = 'ID = cosmoteer.test_shot\n\n';
        const doc = parseUri(src, 'file:///c%3A/mod/shots/test/test.rules');
        const labels = fieldLabels(await schemaFieldNameCompletions(doc, src.length - 1, token));
        expect(labels).toContain('Range');
        expect(labels).toContain('Speed');
        expect(labels).not.toContain('ID'); // already present
    });

    it('resolves a dual-form Texture group (image-asset slot written as a group) and offers its fields', async () => {
        // A particle effect's Material.Texture is written as a GROUP. schemagen only saw the scalar
        // (`Texture = path`) form, so the slot is an image asset; the overlay + structural rule still
        // resolve the group to Halfling.Graphics.Texture and offer File/MipLevels/SampleMode/….
        const src =
            'Type = Particles\nDef\n{\n\tMaterial\n\t{\n\t\tTexture\n\t\t{\n\t\t\tFile = spark.png\n\t\t\t\n\t\t}\n\t}\n}\n';
        const uri = 'file:///c%3A/mod/common_effects/p.rules';
        const doc = parseUri(src, uri);
        const offset = src.indexOf('\n', src.indexOf('File = spark.png')) + 3; // the blank line in Texture
        const labels = fieldLabels(await schemaFieldNameCompletions(doc, offset, token));
        expect(labels).toContain('SampleMode');
        expect(labels).toContain('MipLevels');
        expect(labels).not.toContain('File'); // already present
    });

    it('value-completes a Texture group enum field (SampleMode → Point/Linear)', async () => {
        const marker = 'SampleMode = ';
        const src =
            'Type = Particles\nDef\n{\n\tMaterial\n\t{\n\t\tTexture\n\t\t{\n\t\t\t' + marker + '\n\t\t}\n\t}\n}\n';
        const uri = 'file:///c%3A/mod/common_effects/p.rules';
        const doc = parseUri(src, uri);
        const offset = src.indexOf(marker) + marker.length; // the empty value position after `SampleMode = `
        const values = fieldLabels((await schemaValueCompletionsAtOffset(doc, offset, marker, token)) ?? []);
        expect(values).toContain('Linear');
        expect(values).toContain('Point');
    });

    it('POLYMORPHIC whole-file root: doodad file dispatched by top-level Type', async () => {
        // A doodad file IS a DoodadRules, concrete class chosen by its top-level `Type`.
        const src = 'ID = cosmoteer.test_doodad\nType = GeneratedShip\n\n';
        const doc = parseUri(src, 'file:///c%3A/mod/doodads/test/test.rules');
        const labels = fieldLabels(await schemaFieldNameCompletions(doc, src.length - 1, token));
        expect(labels).toContain('Allegiance'); // GeneratedShipDoodadRules field
        expect(labels).toContain('CategoryKey');
        expect(labels).not.toContain('ID'); // already present
    });
});

describe('documentRootClass — whole-file data roots', () => {
    const root = (src: string, uri: string) => documentRootClass(parseUri(src, uri));

    it('roots a resource file (ID-shaped) as ResourceRules', () => {
        const src = 'ID = test\nNameKey = "x"\nBuyPrice = 100\nSellPrice = 50\n';
        expect(root(src, 'file:///c%3A/mod/resources/test.rules')).toBe('Cosmoteer.Resources.ResourceRules');
    });

    it('roots a status file as StatusType', () => {
        const src = 'ID = cosmoteer.test\nLayer = Part\nStatusCombineMode = ApplyNewInstance\n';
        expect(root(src, 'file:///c%3A/mod/statuses/test.rules')).toBe('Cosmoteer.Ships.Statuses.StatusType');
    });

    it('roots a per-type nebula file as NebulaTypeRules (not the index NebulaRules)', () => {
        const src = 'ID = test\nToolTipKey = "x"\nDefaultLogicalFeather = 150\n';
        expect(root(src, 'file:///c%3A/mod/nebulas/test.rules')).toBe('Cosmoteer.Nebulas.NebulaTypeRules');
    });

    it('roots crew.rules as CrewRules', () => {
        const src = 'CostPerCrew = 500\nMaxHealth = 500\nBaseSpeed = 3.2\n';
        expect(root(src, 'file:///c%3A/mod/crew/crew.rules')).toBe('Cosmoteer.Crew.CrewRules');
    });

    it('content-dispatches an effect file by top-level Type=Particles, regardless of folder', () => {
        const src = 'Type = Particles\nDef = "x"\nBucket = Normal\n';
        // Lives under crew/, but its top-level Type makes it a media effect, not a CrewRules.
        expect(root(src, 'file:///c%3A/mod/crew/jet_trail.rules')).toContain('ParticleEffectRules');
    });

    it('offers inherited base-class fields on an effect (PartQuad → BaseQuadEffectRules.Sprite/Bucket)', async () => {
        // Enriched extractor: abstract base BaseQuadEffectRules carries Sprite/Bucket/FadeInTime.
        const src = 'Type = PartQuad\nRectType = BoundingBox\nInflate = 1\n';
        const uri = 'file:///c%3A/mod/ships/x/effect.rules';
        const doc = parseUri(src, uri);
        expect(documentRootClass(doc)).toContain('PartQuadEffectRules');
        const labels = fieldLabels(await schemaFieldNameCompletions(doc, src.length - 1, token));
        expect(labels).toContain('Sprite'); // from the abstract base, previously missing
        expect(labels).toContain('Bucket');
        expect(labels).toContain('FadeInTime');
    });

    it('content-dispatches a music file by top-level Type=FSM', () => {
        const src = 'Type = FSM\nIntroTracks\n[\n]\nDebugName = "x"\n';
        expect(root(src, 'file:///c%3A/mod/music/cluster.rules')).toContain('MusicFsmTrackRules');
    });

    it('roots a name generator (path-scoped, generic discriminators)', () => {
        const src = 'Type = Multi\nSubGenerators\n[\n]\n';
        expect(root(src, 'file:///c%3A/mod/name_generators/names.rules')).toContain('NameGenerator');
    });

    // --- mis-root rejections (the coverage guard / path-scoping) ---

    it('roots a sysgen file to the spawner registry (Type=None → NoneSpawner, not the colliding NameGenerator)', () => {
        // A `/sectors/` file is a whole-file `SimObjectSpawner` dispatched by its top-level `Type=`.
        // `Type = None` collides with NameGenerator's generic `None`, so it is path-scoped to the
        // spawner registry — rooting it to `NoneSpawner` (so its `SubSpawners` resolve), never NameGenerator.
        const src = 'Type = None\nSubSpawners\n[\n]\nWeight = 1\n';
        expect(root(src, 'file:///c%3A/mod/modes/sectors/sysgen.rules')).toContain('NoneSpawner');
    });

    it('does NOT mis-root a codex file whose nested path substring-matches /resources/', () => {
        const src = 'TitleKey = "x"\nBodyKey = "y"\nIcon\n{\n}\n';
        expect(root(src, 'file:///c%3A/mod/codex/tutorials/resources/tutorial.rules')).toBeUndefined();
    });

    it('does NOT root an override/def fragment in shots that owns few real BulletRules fields', () => {
        const src = 'BASE = &<base.rules>\nFLAK_FIELD = &<field.rules>\nBeam : BASE\n{\n}\n';
        expect(root(src, 'file:///c%3A/mod/shots/flak_overclock.rules')).toBeUndefined();
    });
});

describe('schemaValueCompletionsAtOffset — value completion at an empty `Key = ` position', () => {
    const linePrefixAt = (src: string, offset: number) => src.slice(src.lastIndexOf('\n', offset - 1) + 1, offset);
    const valuesAt = async (src: string, marker: string) => {
        const doc = parse(src);
        const offset = src.indexOf(marker) + marker.length;
        return (await schemaValueCompletionsAtOffset(doc, offset, linePrefixAt(src, offset), token))!.map((c) =>
            typeof c === 'string' ? c : c.label
        );
    };

    it('completes enum members at `Mode = ` (no value typed yet)', async () => {
        const src = 'Part\n{\n\tComponents\n\t{\n\t\tX\n\t\t{\n\t\t\tType = MultiToggle\n\t\t\tMode = \n\t\t}\n\t}\n}';
        expect((await valuesAt(src, 'Mode = ')).sort()).toEqual(['All', 'Any', 'None', 'One']);
    });

    it('completes Type= discriminators at `Type = ` (no value typed yet)', async () => {
        const src = 'Part\n{\n\tComponents\n\t{\n\t\tExisting { Type = MultiToggle }\n\t\tNew\n\t\t{\n\t\t\tType = \n\t\t}\n\t}\n}';
        const result = await valuesAt(src, '\n\t\t\tType = ');
        expect(result).toContain('TurretWeapon');
        expect(result).toContain('MultiToggle');
    });

    it('completes component ids at an empty `OperationalToggle = ` value position', async () => {
        const src =
            'Part\n{\n\tComponents\n\t{\n\t\tIsOperational { Type = MultiToggle; Mode = All }\n\t\tTurret\n\t\t{\n\t\t\tType = TurretWeapon\n\t\t\tOperationalToggle = \n\t\t}\n\t}\n}';
        const result = await valuesAt(src, 'OperationalToggle = ');
        expect(result).toContain('IsOperational');
        expect(result).not.toContain('Turret'); // self excluded
    });

    it('returns undefined when not at a value position (so field-name completion runs instead)', async () => {
        const src = 'Part\n{\n\tID = test\n\t\n}';
        const offset = src.indexOf('\n\t\n}') + 2;
        expect(await schemaValueCompletionsAtOffset(parse(src), offset, '\t', token)).toBeUndefined();
    });

    it('returns an (empty) array at a value position for a cross-file ref field (not field names)', async () => {
        // `ResourceType = ` is a value position; its sync values are empty (resource ids are cross-file).
        const src = 'Part\n{\n\tComponents\n\t{\n\t\tS\n\t\t{\n\t\t\tType = ResourceStorage\n\t\t\tResourceType = \n\t\t}\n\t}\n}';
        const offset = src.indexOf('ResourceType = ') + 'ResourceType = '.length;
        const result = await schemaValueCompletionsAtOffset(parse(src), offset, '\t\t\tResourceType = ', token);
        expect(result).toEqual([]); // value position → array (caller routes to the id index), not undefined
    });
});

describe('collision disambiguation', () => {
    it('classByDiscriminator picks the hinted registry for a colliding Type (Perlin)', () => {
        const heightMap = classByDiscriminator('Perlin', 'HeightMapLayer');
        const texture = classByDiscriminator('Perlin', 'TextureLayer');
        expect(heightMap).toContain('HeightMapLayer');
        expect(texture).toContain('TextureLayer');
        expect(heightMap).not.toBe(texture);
    });
});

describe('schemaFieldNameCompletions — list-element positions (no outer-group leak)', () => {
    const airlockList =
        'Part\n{\n\tComponents\n\t{\n\t\tDoor\n\t\t{\n\t\t\tType = Airlock\n\t\t\tEnterExitPoint\n\t\t\t[\n\t\t\t\t\n\t\t\t]\n\t\t}\n\t}\n}';

    it('offers no field names inside a group-typed field written in list form', async () => {
        // Before the fix `findEnclosingGroup` skipped the list, so a cursor inside
        // `EnterExitPoint [ ]` offered the Airlock component's own fields, scaffolding members the
        // game never reads (the `Offset [Scale2In = offset]` trap in particle renderers).
        const doc = parse(airlockList);
        const offset = airlockList.indexOf('[\n\t\t\t\t') + '[\n\t\t\t\t'.length;
        expect(await schemaFieldNameCompletions(doc, offset, token)).toEqual([]);
    });

    it('offers a `{ Type = … }` element scaffold inside a list of polymorphic groups', async () => {
        const src =
            'Part\n{\n\tComponents\n\t{\n\t\tRouter\n\t\t{\n\t\t\tType = NetworkRouter\n\t\t\tRouteGenerators\n\t\t\t[\n\t\t\t\t\n\t\t\t]\n\t\t}\n\t}\n}';
        const doc = parse(src);
        const offset = src.indexOf('[\n\t\t\t\t') + '[\n\t\t\t\t'.length;
        const items = (await schemaFieldNameCompletions(doc, offset, token)).filter(
            (c): c is Exclude<typeof c, string> => typeof c !== 'string'
        );
        expect(items).toHaveLength(1);
        expect(items[0].label).toContain('IRouteGenerator');
        expect(items[0].insertText).toBe('{\n\tType = $0\n}');
        expect(items[0].isSnippet).toBe(true);
    });

    it('value completion inside brackets resolves against the list class, not the outer group', async () => {
        // `EntryToggle` is an Airlock reference field; the old outer-group resolution offered its
        // sibling-component ids inside the brackets, where the game never reads the assignment.
        const marker = 'EnterExitPoint [EntryToggle = ';
        const src =
            'Part\n{\n\tComponents\n\t{\n\t\tDoor\n\t\t{\n\t\t\tType = Airlock\n\t\t\t' + marker + '\n\t\t}\n\t}\n}';
        const doc = parse(src);
        const offset = src.indexOf(marker) + marker.length;
        expect(await schemaValueCompletionsAtOffset(doc, offset, '\t\t\t' + marker, token)).toEqual([]);
    });
});

describe('value-form delegation — schema intelligence inside HitEffects-style lists', () => {
    // StatusType.ApplicationEffects is group-typed (MultiHitEffectRules) but its value form
    // delegates to an effect array, so the list spelling carries typed polymorphic elements.
    const status = (body: string) =>
        parseUri(
            `ID = cosmoteer.test\nLayer = Part\nStatusCombineMode = ApplyNewInstance\n${body}\n`,
            'file:///c%3A/mod/statuses/test.rules'
        );

    it('offers a `{ Type = … }` element scaffold inside the list', async () => {
        const body = 'ApplicationEffects\n[\n\t\n]';
        const doc = status(body);
        const src = `ID = cosmoteer.test\nLayer = Part\nStatusCombineMode = ApplyNewInstance\n${body}\n`;
        const offset = src.indexOf('[\n\t') + '[\n\t'.length;
        const items = (await schemaFieldNameCompletions(doc, offset, token)).filter(
            (c): c is Exclude<typeof c, string> => typeof c !== 'string'
        );
        expect(items).toHaveLength(1);
        expect(items[0].label).toContain('HitEffectRules');
        expect(items[0].insertText).toBe('{\n\tType = $0\n}');
    });

    it('completes the element Type= with the hit-effect discriminators', async () => {
        const doc = status('ApplicationEffects\n[\n\t{\n\t\tType = x\n\t}\n]');
        const type = doc.elements.map((n) => findValue(n, 'Type')).find(Boolean);
        const result = await labels(type);
        expect(result).toContain('Damage');
        expect(result).toContain('ExplosiveDamage');
    });
});
