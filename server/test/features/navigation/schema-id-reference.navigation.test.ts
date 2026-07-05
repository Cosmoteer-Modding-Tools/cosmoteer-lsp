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
            : isAssignmentNode(node)
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

describe('resolveSchemaIdReference — cross-file ID<X> go-to-definition', () => {
    let dir: string;
    const token = CancellationToken.None;
    let folders: string[];

    beforeAll(async () => {
        dir = await mkdtemp(join(tmpdir(), 'cosmo-idref-'));
        await mkdir(join(dir, 'resources'), { recursive: true });
        // A resource file IS a ResourceRules (rooted by the /resources/ path), keyed by its `ID`.
        await writeFile(join(dir, 'resources', 'battery.rules'), 'ID = battery\nNameKey = "x"\nBuyPrice = 1\n');
        await writeFile(join(dir, 'resources', 'iron.rules'), 'ID = iron\nNameKey = "y"\nBuyPrice = 2\n');
        await mkdir(join(dir, 'parts'), { recursive: true });
        await writeFile(
            join(dir, 'parts', 'store.rules'),
            'Part\n{\n\tComponents\n\t{\n\t\tStore\n\t\t{\n\t\t\tType = ResourceStorage\n\t\t\tResourceType = battery\n\t\t}\n\t}\n}'
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

    it('find-references on a resource finds the usage AND the declaration across files', async () => {
        // Cursor on `ResourceType = battery` in the on-disk part file.
        const storeUri = pathToFileURL(join(dir, 'parts', 'store.rules')).href;
        const storeSrc = 'Part\n{\n\tComponents\n\t{\n\t\tStore\n\t\t{\n\t\t\tType = ResourceStorage\n\t\t\tResourceType = battery\n\t\t}\n\t}\n}';
        const doc = parser(lexer(storeSrc), storeUri).value;
        const line = 7;
        const character = storeSrc.split('\n')[line].indexOf('= battery') + 3;
        const locs = await ReferenceIndex.instance.findReferences(doc, { line, character }, true, folders, token);
        const uris = locs.map((l) => l.uri.toLowerCase());
        expect(uris.some((u) => u.includes('store.rules'))).toBe(true); // the usage
        expect(uris.some((u) => u.includes('battery.rules'))).toBe(true); // the declaration
        expect(locs).toHaveLength(2);
    });

    it('rename on a resource rewrites the declaration ID and the usage across files', async () => {
        const storeUri = pathToFileURL(join(dir, 'parts', 'store.rules')).href;
        const storeSrc = 'Part\n{\n\tComponents\n\t{\n\t\tStore\n\t\t{\n\t\t\tType = ResourceStorage\n\t\t\tResourceType = battery\n\t\t}\n\t}\n}';
        const doc = parser(lexer(storeSrc), storeUri).value;
        const line = 7;
        const character = storeSrc.split('\n')[line].indexOf('= battery') + 3;
        const edit = await RenameService.instance.rename(doc, { line, character }, 'power_cell', folders, token);
        expect(edit).not.toBeNull();
        const changed = Object.keys(edit!.changes!).map((u) => u.toLowerCase());
        expect(changed.some((u) => u.includes('store.rules'))).toBe(true);
        expect(changed.some((u) => u.includes('battery.rules'))).toBe(true);
        const allEdits = Object.values(edit!.changes!).flat();
        expect(allEdits).toHaveLength(2);
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
