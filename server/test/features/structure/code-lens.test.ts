import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CancellationToken } from 'vscode-languageserver';
import { pathToFileURL } from 'url';
import {
    codeLensesFor,
    invalidateCodeLensCache,
    resolveCodeLens,
} from '../../../src/features/structure/code-lens.service';
import { clearFsCaches } from '../../../src/workspace/fs-cache';

const token = CancellationToken.None;
const dirs: string[] = [];

/** A mod on disk whose manifest wires in one file and leaves the other where the game cannot see it. */
const buildMod = (files: Record<string, string>): string => {
    const dir = mkdtempSync(join(tmpdir(), 'code-lens-'));
    dirs.push(dir);
    for (const [name, content] of Object.entries(files)) {
        const path = join(dir, name);
        mkdirSync(join(path, '..'), { recursive: true });
        writeFileSync(path, content);
    }
    invalidateCodeLensCache();
    clearFsCaches();
    return dir;
};

const titleFor = async (dir: string, name: string): Promise<string | undefined> => {
    const uri = pathToFileURL(join(dir, name)).href;
    const [lens] = await codeLensesFor(uri, token);
    if (!lens) return undefined;
    return (await resolveCodeLens(lens, token)).command?.title;
};

afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Nothing in a file says whether the game ever reads it, and a file outside the manifest's closure
// is edited, saved and never loaded. The lens is the one place that can say so.
describe('the lens saying whether the mod loads a file', () => {
    it('says so for a file the manifest wires in', async () => {
        const dir = buildMod({
            'mod.rules':
                'ID = test.mod\nName = "t"\nActions\n[\n\t{\n\t\tAction = Add\n\t\tAddTo = "<parts.rules>"\n\t\tName = Mine\n\t\tToAdd = &<parts/live.rules>/Part\n\t}\n]\n',
            'parts/live.rules': 'Part\n{\n\tID = test.live\n}\n',
        });
        expect(await titleFor(dir, 'parts/live.rules')).toContain('loads this file');
    });

    it('says the mod does not load a file nothing reaches', async () => {
        const dir = buildMod({
            'mod.rules':
                'ID = test.mod\nName = "t"\nActions\n[\n\t{\n\t\tAction = Add\n\t\tAddTo = "<parts.rules>"\n\t\tName = Mine\n\t\tToAdd = &<parts/live.rules>/Part\n\t}\n]\n',
            'parts/live.rules': 'Part\n{\n\tID = test.live\n}\n',
            'parts/parked.rules': 'Part\n{\n\tID = test.parked\n}\n',
        });
        expect(await titleFor(dir, 'parts/parked.rules')).toContain('does not load this file');
    });

    it('names the file that mentions an unreached one, which is where the chain was cut', async () => {
        const dir = buildMod({
            'mod.rules':
                'ID = test.mod\nName = "t"\nActions\n[\n\t{\n\t\tAction = Add\n\t\tAddTo = "<parts.rules>"\n\t\tName = Mine\n\t\tToAdd = &<parts/live.rules>/Part\n\t}\n]\n',
            'parts/live.rules': 'Part\n{\n\tID = test.live\n}\n',
            'parts/parked.rules': 'Part\n{\n\tID = test.parked\n}\n',
            'parts/orphan.rules': 'Copy : <./parked.rules>/Part\n{\n\tID = test.orphan\n}\n',
        });
        expect(await titleFor(dir, 'parts/parked.rules')).toContain('orphan.rules');
    });

    it('offers no lens on the manifest, which is what the closure starts from', async () => {
        const dir = buildMod({ 'mod.rules': 'ID = test.mod\nName = "t"\nActions [ ]\n' });
        expect(await codeLensesFor(pathToFileURL(join(dir, 'mod.rules')).href, token)).toEqual([]);
    });

    it('offers no lens outside a mod, where there is no manifest to be loaded by', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'code-lens-vanilla-'));
        dirs.push(dir);
        writeFileSync(join(dir, 'armor.rules'), 'Part\n{\n\tID = cosmoteer.armor\n}\n');
        expect(await codeLensesFor(pathToFileURL(join(dir, 'armor.rules')).href, token)).toEqual([]);
    });
});
