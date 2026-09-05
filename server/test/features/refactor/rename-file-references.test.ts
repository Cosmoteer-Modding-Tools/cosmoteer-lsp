import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { referenceRepairEdit } from '../../../src/features/refactor/rename-file-references';
import { initWorkspace } from '../../workspace-helper';

const token = CancellationToken.None;

let root = '';
let folders: string[] = [];

/** The edits the repair produces for one move, keyed by the file name they land in. */
const repairFor = async (oldPath: string, newPath: string): Promise<Record<string, string[]>> => {
    const edit = await referenceRepairEdit([{ oldPath, newPath }], folders, token);
    const out: Record<string, string[]> = {};
    for (const [uri, edits] of Object.entries(edit?.changes ?? {})) {
        out[decodeURIComponent(uri).split('/').pop()!] = edits.map((textEdit) => textEdit.newText);
    }
    return out;
};

describe('repairing references when a file moves', () => {
    beforeAll(async () => {
        await initWorkspace();
        root = mkdtempSync(join(tmpdir(), 'cosmoteer-rename-'));
        mkdirSync(join(root, 'parts'));
        mkdirSync(join(root, 'shared'));
        writeFileSync(join(root, 'shared', 'base.rules'), 'Base\n{\n\tA = 1\n}\n');
        writeFileSync(join(root, 'parts', 'gun.rules'), 'Part : &<../shared/base.rules>/Base\n{\n\tB = 2\n}\n');
        writeFileSync(join(root, 'reader.rules'), 'Thing\n{\n\tValue = &<shared/base.rules>/Base/A\n}\n');
        folders = [pathToFileURL(root).href];
    });

    afterAll(() => rmSync(root, { recursive: true, force: true }));

    it('rewrites a reference to the file that moved', async () => {
        const repaired = await repairFor(join(root, 'shared', 'base.rules'), join(root, 'lib', 'base.rules'));
        expect(repaired['reader.rules']).toEqual(['&<lib/base.rules>/Base/A']);
    });

    it('rewrites a reference written with a folder step of its own', async () => {
        const repaired = await repairFor(join(root, 'shared', 'base.rules'), join(root, 'lib', 'base.rules'));
        expect(repaired['gun.rules']).toEqual(['&<../lib/base.rules>/Base']);
    });

    it('rewrites what the moved file itself points at', async () => {
        // `gun.rules` reaches its base with `../shared`, which says something else from a new folder.
        const repaired = await repairFor(join(root, 'parts', 'gun.rules'), join(root, 'gun.rules'));
        expect(repaired['gun.rules']).toEqual(['&<shared/base.rules>/Base']);
    });

    it('answers nothing for a file nothing points at', async () => {
        const repaired = await repairFor(join(root, 'reader.rules'), join(root, 'moved.rules'));
        expect(repaired).toEqual({});
    });

    it('answers nothing for a file that is not a rules file', async () => {
        expect(await referenceRepairEdit([{ oldPath: join(root, 'a.png'), newPath: join(root, 'b.png') }], folders, token))
            .toBeUndefined();
    });
});
