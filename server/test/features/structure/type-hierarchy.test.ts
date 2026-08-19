import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CancellationToken } from 'vscode-languageserver';
import { parseText } from '../../../src/utils/ast.utils';
import { filePathToUri } from '../../../src/features/navigation/navigation-strategy';
import { TemplateBaseIndex } from '../../../src/features/diagnostics/template-base.index';
import { clearFsCaches } from '../../../src/workspace/fs-cache';
import {
    prepareTypeHierarchy,
    subtypesOf,
    supertypesOf,
} from '../../../src/features/structure/type-hierarchy.service';

const token = CancellationToken.None;
const dirs: string[] = [];

/** A throwaway workspace on disk, indexed so findInheritorsOf has a real reverse edge to narrow by. */
const buildWorkspace = async (files: Record<string, string>): Promise<string> => {
    const dir = mkdtempSync(join(tmpdir(), 'type-hierarchy-'));
    dirs.push(dir);
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    TemplateBaseIndex.instance.reset();
    clearFsCaches();
    await TemplateBaseIndex.instance.baseNames([dir], token);
    return dir;
};

afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('prepareTypeHierarchy', () => {
    it('offers the container the caret sits on', () => {
        const source = 'Base\n{\n\tA = 1\n}\nChild : &Base\n{\n}\n';
        const uri = 'file:///t.rules';
        const items = prepareTypeHierarchy(parseText(source, uri), { line: 4, character: 2 }, []);
        expect(items).toHaveLength(1);
        expect(items?.[0].name).toBe('Child');
    });

    it('offers nothing where no container carries a name', () => {
        const items = prepareTypeHierarchy(parseText('A = 1\n', 'file:///t.rules'), { line: 0, character: 4 }, []);
        expect(items ?? []).toEqual([]);
    });
});

describe('supertypesOf', () => {
    it('answers the base a container writes', async () => {
        const dir = await buildWorkspace({
            'base.rules': 'Base\n{\n\tA = 1\n}\n',
            'child.rules': 'Child : &<base.rules>/Base\n{\n}\n',
        });
        const uri = filePathToUri(join(dir, 'child.rules'));
        const [item] = prepareTypeHierarchy(parseText('Child : &<base.rules>/Base\n{\n}\n', uri), { line: 0, character: 2 }, [dir]) ?? [];
        expect(item).toBeDefined();
        const supertypes = await supertypesOf(item, [dir], token);
        expect(supertypes?.map((entry) => entry.name)).toEqual(['Base']);
    });

    it('answers nothing for a container that inherits nothing', async () => {
        const dir = await buildWorkspace({ 'a.rules': 'Lonely\n{\n\tA = 1\n}\n' });
        const uri = filePathToUri(join(dir, 'a.rules'));
        const [item] = prepareTypeHierarchy(parseText('Lonely\n{\n\tA = 1\n}\n', uri), { line: 0, character: 2 }, [dir]) ?? [];
        expect(await supertypesOf(item, [dir], token)).toEqual([]);
    });
});

describe('subtypesOf', () => {
    it('answers every container naming it as a base, and only the direct level', async () => {
        const dir = await buildWorkspace({
            'base.rules': 'Base\n{\n\tA = 1\n}\n',
            'mid.rules': 'Mid : &<base.rules>/Base\n{\n}\n',
            'leaf.rules': 'Leaf : &<mid.rules>/Mid\n{\n}\n',
            'other.rules': 'Other : &<base.rules>/Base\n{\n}\n',
        });
        const uri = filePathToUri(join(dir, 'base.rules'));
        const [item] = prepareTypeHierarchy(parseText('Base\n{\n\tA = 1\n}\n', uri), { line: 0, character: 2 }, [dir]) ?? [];
        expect(item).toBeDefined();
        const subtypes = await subtypesOf(item, [dir], token);
        // Leaf inherits Mid, not Base, so it belongs one expansion deeper rather than in this answer.
        expect((subtypes ?? []).map((entry) => entry.name).sort()).toEqual(['Mid', 'Other']);
    });

    it('answers nothing for a base nothing inherits', async () => {
        const dir = await buildWorkspace({ 'base.rules': 'Base\n{\n\tA = 1\n}\n' });
        const uri = filePathToUri(join(dir, 'base.rules'));
        const [item] = prepareTypeHierarchy(parseText('Base\n{\n\tA = 1\n}\n', uri), { line: 0, character: 2 }, [dir]) ?? [];
        expect(await subtypesOf(item, [dir], token)).toEqual([]);
    });

    it('answers nothing rather than everything when the request is already cancelled', async () => {
        const dir = await buildWorkspace({
            'base.rules': 'Base\n{\n\tA = 1\n}\n',
            'child.rules': 'Child : &<base.rules>/Base\n{\n}\n',
        });
        const uri = filePathToUri(join(dir, 'base.rules'));
        const [item] = prepareTypeHierarchy(parseText('Base\n{\n\tA = 1\n}\n', uri), { line: 0, character: 2 }, [dir]) ?? [];
        const cancelled = { isCancellationRequested: true, onCancellationRequested: () => ({ dispose: () => undefined }) };
        expect(await subtypesOf(item, [dir], cancelled as unknown as CancellationToken)).toEqual([]);
    });
});
