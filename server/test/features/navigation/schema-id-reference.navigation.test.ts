import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
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
import { resolveSchemaIdReference } from '../../../src/features/navigation/schema-id-reference.navigation';
import { SchemaIdIndex } from '../../../src/features/completion/schema-id.index';
import { ReferenceIndex } from '../../../src/features/navigation/reference-index';
import { RenameService, dropEditsUnderRoot } from '../../../src/features/navigation/rename.service';
import { TextEdit } from 'vscode-languageserver';
import { HoverService } from '../../../src/features/hover/hover.service';

const parse = (src: string) => parser(lexer(src), 'file:///mod/parts/store.rules').value;
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

// A part component (ResourceStorage) whose `ResourceType` field is an ID<ResourceRules> reference.
const PART = `Part
{
	Components
	{
		Store { Type = ResourceStorage; ResourceType = battery }
	}
}`;

// A part's build cost: `Resources` is a list of `[resource_id, amount]` tuples, so the first tuple
// slot is an ID<ResourceRules> reference and the second a plain int.
const PART_TUPLE = `Part
{
	Resources
	[
		[battery, 20]
	]
}`;

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

describe('resolveSchemaIdReference: cross-file ID<X> go-to-definition', () => {
    let dir: string;
    const token = CancellationToken.None;
    let folders: string[];

    beforeAll(async () => {
        dir = await mkdtemp(join(tmpdir(), 'cosmo-idref-'));
        await mkdir(join(dir, 'resources'), { recursive: true });
        // A resource file is a ResourceRules (rooted by the /resources/ path), keyed by its `ID`.
        await writeFile(join(dir, 'resources', 'battery.rules'), 'ID = battery\nNameKey = "x"\nBuyPrice = 1\n');
        await writeFile(join(dir, 'resources', 'iron.rules'), 'ID = iron\nNameKey = "y"\nBuyPrice = 2\n');
        await mkdir(join(dir, 'parts'), { recursive: true });
        // The part also costs the resource via a `[id, amount]` tuple, so find-references and
        // rename must pick up the tuple usage alongside the `ResourceType` field usage.
        await writeFile(
            join(dir, 'parts', 'store.rules'),
            'Part\n{\n\tResources\n\t[\n\t\t[battery, 20]\n\t]\n\tComponents\n\t{\n\t\tStore\n\t\t{\n\t\t\tType = ResourceStorage\n\t\t\tResourceType = battery\n\t\t}\n\t}\n}'
        );
        // A part declares its identity as `Part { ID = … }`, the target of `EditorParentParts` and
        // part-keyed maps.
        await writeFile(join(dir, 'parts', 'armor.rules'), 'Part\n{\n\tID = test.armor\n\tMaxHealth = 100\n}\n');
        // Mods also write rules content in `.txt` files (the game's loader ignores the extension),
        // so a part declared there must be indexed like any other.
        await writeFile(join(dir, 'parts', 'legacy.txt'), 'Part\n{\n\tID = test.legacy_part\n\tMaxHealth = 50\n}\n');
        // A ship file declares render layers as entry-form keys of the self-keyed `RenderLayers` map.
        await mkdir(join(dir, 'ships'), { recursive: true });
        await writeFile(
            join(dir, 'ships', 'terran.rules'),
            'RenderLayers\n[\n\t{\n\t\tKey = "structure"\n\t\tValue\n\t\t{\n\t\t\tUniqueBucket = true\n\t\t}\n\t}\n]\n'
        );
        // A sysgen file declares spawner tags, the usage-defined ids other spawners reference.
        await mkdir(join(dir, 'modes', 'sectors'), { recursive: true });
        await writeFile(
            join(dir, 'modes', 'sectors', 'sysgen.rules'),
            'Type = None\nTags = [hub_tag]\nSubSpawners\n[\n]\nWeight = 1\n'
        );
        // A faction fragment declares list-element entities, referenced from the career map picker.
        await writeFile(join(dir, 'factions.rules'), 'Factions\n[\n\t{\n\t\tID = monolith\n\t}\n]\n');
        // A hit effect declares its damage type inline, the declaration side of resistance keys.
        await writeFile(
            join(dir, 'effect.rules'),
            'Type = ExplosiveDamage\nDamageType = fire\nDamageAmount = 100\n'
        );
        folders = [pathToFileURL(dir).href];
    });
    afterAll(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it('resolves ResourceType = battery to resources/battery.rules ID line', async () => {
        const node = findValue(parse(PART), 'ResourceType');
        const loc = await resolveSchemaIdReference(node, folders, token);
        expect(loc).not.toBeNull();
        expect(loc!.uri.toLowerCase()).toContain('battery.rules');
        expect(loc!.range.start.line).toBe(0); // the `ID = battery` line
    });

    it('returns null for an id that no resource declares', async () => {
        const node = findValue(parse(PART.replace('= battery', '= nonexistent')), 'ResourceType');
        expect(await resolveSchemaIdReference(node, folders, token)).toBeNull();
    });

    it('returns null for a non-reference field (Type is a discriminator, not an ID<>)', async () => {
        const node = findValue(parse(PART), 'Type');
        expect(await resolveSchemaIdReference(node, folders, token)).toBeNull();
    });

    it('SchemaIdIndex completes a cross-file ID<ResourceRules> field with project resource ids', async () => {
        SchemaIdIndex.instance.reset();
        const node = findValue(parse(PART), 'ResourceType');
        const labels = (await SchemaIdIndex.instance.idCompletions(node!, folders, token)).map((c) =>
            typeof c === 'string' ? c : c.label
        );
        expect(labels.sort()).toEqual(['battery', 'iron']);
    });

    it('SchemaIdIndex returns [] for a non-reference field (no index build)', async () => {
        const node = findValue(parse(PART), 'Type');
        expect(await SchemaIdIndex.instance.idCompletions(node!, folders, token)).toEqual([]);
    });

    it('resolves a Resources tuple entry (`[battery, 20]`) to the declaring resource file', async () => {
        const node = findValueByText(parse(PART_TUPLE), 'battery');
        const loc = await resolveSchemaIdReference(node, folders, token);
        expect(loc).not.toBeNull();
        expect(loc!.uri.toLowerCase()).toContain('battery.rules');
    });

    it('SchemaIdIndex completes a Resources tuple entry with project resource ids', async () => {
        const node = findValueByText(parse(PART_TUPLE), 'battery');
        const labels = (await SchemaIdIndex.instance.idCompletions(node!, folders, token)).map((c) =>
            typeof c === 'string' ? c : c.label
        );
        expect(labels.sort()).toEqual(['battery', 'iron']);
    });

    it('offers nothing at a tuple entry int slot (the `20` in `[battery, 20]`)', async () => {
        const node = findValueByText(parse(PART_TUPLE), '20');
        expect(await SchemaIdIndex.instance.idCompletions(node!, folders, token)).toEqual([]);
    });

    it('completes a part id in the flat EditorParentParts spelling and resolves it', async () => {
        const src = 'Part\n{\n\tEditorParentParts = [ armor_x ]\n}';
        const node = findValueByText(parse(src), 'armor_x');
        const labels = (await SchemaIdIndex.instance.idCompletions(node!, folders, token)).map((c) =>
            typeof c === 'string' ? c : c.label
        );
        expect(labels).toContain('test.armor');
        const written = findValueByText(parse(src.replace('armor_x', 'test.armor')), 'test.armor');
        const loc = await resolveSchemaIdReference(written, folders, token);
        expect(loc).not.toBeNull();
        expect(loc!.uri.toLowerCase()).toContain('armor.rules');
    });

    it('completes an entry-form map key (`RenderLayers [ { Key = … } ]`) and resolves it', async () => {
        const src = 'RenderLayers\n[\n\t{\n\t\tKey = doors\n\t\tValue\n\t\t{\n\t\t}\n\t}\n]\n';
        const node = findValueByText(parse(src), 'doors');
        const labels = (await SchemaIdIndex.instance.idCompletions(node!, folders, token)).map((c) =>
            typeof c === 'string' ? c : c.label
        );
        expect(labels).toContain('structure');
        const written = findValueByText(parse(src.replace('= doors', '= structure')), 'structure');
        const loc = await resolveSchemaIdReference(written, folders, token);
        expect(loc).not.toBeNull();
        expect(loc!.uri.toLowerCase()).toContain('terran.rules');
    });

    it('completes a spawner tag reference and resolves it to the declaring Tags entry', async () => {
        const src = 'Type = None\nRootLocationTag = h\nSubSpawners\n[\n]\nWeight = 1\n';
        const doc = parser(lexer(src), 'file:///c%3A/mod/modes/sectors/probe.rules').value;
        const node = findValueByText(doc, 'h');
        const labels = (await SchemaIdIndex.instance.idCompletions(node!, folders, token)).map((c) =>
            typeof c === 'string' ? c : c.label
        );
        expect(labels).toContain('hub_tag');
        const written = findValueByText(
            parser(lexer(src.replace('= h', '= hub_tag')), 'file:///c%3A/mod/modes/sectors/probe.rules').value,
            'hub_tag'
        );
        const loc = await resolveSchemaIdReference(written, folders, token);
        expect(loc).not.toBeNull();
        expect(loc!.uri.toLowerCase()).toContain('sysgen.rules');
    });

    it('completes a faction id inside a tuple-nested reference list', async () => {
        const src = 'Galaxy\n{\n\tType = StartingNodePicker\n\tCandidatesClosestToFactions = [3, [mono]]\n}';
        const node = findValueByText(parse(src), 'mono');
        const labels = (await SchemaIdIndex.instance.idCompletions(node!, folders, token)).map((c) =>
            typeof c === 'string' ? c : c.label
        );
        expect(labels).toContain('monolith');
    });

    it('completes damage-type keys from hit-effect declarations plus the engine builtins', async () => {
        // `DamageResistances { <key> = … }` keys reference whatever the hit effects deal
        // (`DamageType = fire`) plus the engine's hardcoded three (schema `builtinIds`).
        const labels = (
            await SchemaIdIndex.instance.idCompletionsForClass('Cosmoteer.DamageType', folders, token)
        ).map((c) => (typeof c === 'string' ? c : c.label));
        expect(labels).toContain('fire'); // declared by the fixture hit effect
        expect(labels).toContain('explosive'); // engine builtin
        expect(labels).toContain('default'); // engine builtin
    });

    it('completes and resolves a part declared in a .txt rules file', async () => {
        const src = 'Part\n{\n\tEditorParentParts = [ x ]\n}';
        const node = findValueByText(parse(src), 'x');
        const labels = (await SchemaIdIndex.instance.idCompletions(node!, folders, token)).map((c) =>
            typeof c === 'string' ? c : c.label
        );
        expect(labels).toContain('test.legacy_part');
        const written = findValueByText(parse(src.replace('[ x ]', '[ test.legacy_part ]')), 'test.legacy_part');
        const loc = await resolveSchemaIdReference(written, folders, token);
        expect(loc).not.toBeNull();
        expect(loc!.uri.toLowerCase()).toContain('legacy.txt');
    });

    it('completes a partially typed tuple entry with a dotted mod prefix (`[SW., …]`)', async () => {
        // The mid-typing state of `Resources [ [SW.<cursor>, ceil(…)] ]`. The dotted prefix must
        // still resolve as tuple slot 0 and offer the project ids.
        const src = 'Part\n{\n\tResources\n\t[\n\t\t[SW., ceil((&~/COST)*(&~/MULTIPLIKATOR))]\n\t]\n}';
        const node = findValueByText(parse(src), 'SW.');
        expect(node).toBeDefined();
        const labels = (await SchemaIdIndex.instance.idCompletions(node!, folders, token)).map((c) =>
            typeof c === 'string' ? c : c.label
        );
        expect(labels.sort()).toEqual(['battery', 'iron']);
    });

    // The on-disk store.rules content, mirrored here so the tests can compute cursor positions.
    const STORE_SRC =
        'Part\n{\n\tResources\n\t[\n\t\t[battery, 20]\n\t]\n\tComponents\n\t{\n\t\tStore\n\t\t{\n\t\t\tType = ResourceStorage\n\t\t\tResourceType = battery\n\t\t}\n\t}\n}';

    it('find-references on a resource finds both usages and the declaration across files', async () => {
        // Cursor on `ResourceType = battery` in the on-disk part file.
        const storeUri = pathToFileURL(join(dir, 'parts', 'store.rules')).href;
        const doc = parser(lexer(STORE_SRC), storeUri).value;
        const line = 11;
        const character = STORE_SRC.split('\n')[line].indexOf('= battery') + 3;
        const locs = await ReferenceIndex.instance.findReferences(doc, { line, character }, true, folders, token);
        const uris = locs.map((l) => l.uri.toLowerCase());
        expect(uris.filter((u) => u.includes('store.rules'))).toHaveLength(2); // field + tuple usage
        expect(uris.some((u) => u.includes('battery.rules'))).toBe(true); // the declaration
        expect(locs).toHaveLength(3);
    });

    it('rename on a resource rewrites the declaration ID and both usages across files', async () => {
        const storeUri = pathToFileURL(join(dir, 'parts', 'store.rules')).href;
        const doc = parser(lexer(STORE_SRC), storeUri).value;
        const line = 11;
        const character = STORE_SRC.split('\n')[line].indexOf('= battery') + 3;
        const edit = await RenameService.instance.rename(doc, { line, character }, 'power_cell', folders, token);
        expect(edit).not.toBeNull();
        const changed = Object.keys(edit!.changes!).map((u) => u.toLowerCase());
        expect(changed.some((u) => u.includes('store.rules'))).toBe(true);
        expect(changed.some((u) => u.includes('battery.rules'))).toBe(true);
        const allEdits = Object.values(edit!.changes!).flat();
        expect(allEdits).toHaveLength(3);
        expect(allEdits.every((e) => e.newText === 'power_cell')).toBe(true);
    });

    it('hover on a cross-file ID<> reference shows the declaring file', async () => {
        const storeUri = pathToFileURL(join(dir, 'parts', 'store.rules')).href;
        const storeSrc = 'Part\n{\n\tComponents\n\t{\n\t\tStore\n\t\t{\n\t\t\tType = ResourceStorage\n\t\t\tResourceType = battery\n\t\t}\n\t}\n}';
        const doc = parser(lexer(storeSrc), storeUri).value;
        const line = 7;
        const character = storeSrc.split('\n')[line].indexOf('= battery') + 3;
        const hover = await HoverService.instance.getHover(doc, { line, character }, token, folders);
        const value = typeof hover?.contents === 'object' && 'value' in hover.contents ? hover.contents.value : '';
        expect(value).toContain('battery.rules'); // → defined in `battery.rules`
    });

    it('dropEditsUnderRoot strips edits to the read-only vanilla Data tree (never overwrites vanilla)', () => {
        const te = [TextEdit.replace({ start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, 'x')];
        const edit = {
            changes: {
                'file:///C:/Steam/Cosmoteer/Data/ships/armor.rules': te, // vanilla → must be dropped
                'file:///C:/Mods/MyMod/parts/store.rules': te, // mod → kept
            },
        };
        const guarded = dropEditsUnderRoot(edit, 'C:\\Steam\\Cosmoteer\\Data');
        const uris = Object.keys(guarded.changes!);
        expect(uris).toEqual(['file:///C:/Mods/MyMod/parts/store.rules']);
    });
});
