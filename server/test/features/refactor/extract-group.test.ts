import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken, TextEdit } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
    extractGroupToFile,
    ExtractGroupResult,
} from '../../../src/features/refactor/extract-group/extract-group.command';
import { filePathToUri } from '../../../src/features/navigation/navigation-strategy';
import { globalSettings, setGlobalSettings } from '../../../src/settings';
import { invalidateFsPath } from '../../../src/workspace/fs-cache';
import { initWorkspace } from '../../workspace-helper';

const token = CancellationToken.None;

const PART = [
    'Part',
    '{',
    '\tID = extract_part',
    '\tShot',
    '\t{',
    '\t\tDamage = 12',
    '\t\tSprite = "shot.png"',
    '\t}',
    '}',
    '',
].join('\n');

let root: string;

/** The command run against a buffer the editor has open, which is what the refactoring does. */
const run = async (
    text: string,
    fileName?: string,
    file = 'part.rules'
): Promise<{ result: ExtractGroupResult; edits: Record<string, TextEdit[]>; path: string }> => {
    const path = join(root, file);
    const uri = filePathToUri(path);
    const open = TextDocument.create(uri, 'rules', 0, text);
    const edits: Record<string, TextEdit[]> = {};
    const changed: string[] = [];
    const result = await extractGroupToFile(
        { uri, offset: text.indexOf('Shot'), fileName },
        {
            openDocuments: () => [open],
            applyEdit: async (changes) => {
                Object.assign(edits, changes);
                return true;
            },
            filesChanged: (paths) => {
                changed.push(...paths);
                for (const written of paths) invalidateFsPath(written);
            },
        },
        token
    );
    return { result, edits, path };
};

// The block a part writes inline is the block another part would inherit, and the way to share one
// is a file. Copying it by hand is where a path written next to the old file stops resolving.
describe('move a block into its own file', () => {
    beforeAll(async () => {
        await initWorkspace();
        root = mkdtempSync(join(tmpdir(), 'cosmoteer-extract-'));
        // A path only moves when it can be proven to still name the same file afterwards, so the
        // sprite the block writes has to be there.
        writeFileSync(join(root, 'shot.png'), '');
        setGlobalSettings({ ...globalSettings, allowEditingVanillaFiles: true });
    });

    afterAll(() => rmSync(root, { recursive: true, force: true }));

    it('reports what would move and what to call the file', async () => {
        const { result } = await run(PART);
        expect(result).toEqual({ offer: { name: 'Shot', fileName: 'shot.rules', members: 2 } });
    });

    it('writes the block at the root of the new file', async () => {
        const { result, path } = await run(PART, 'shots/extracted_shot.rules');
        if (!('written' in result)) throw new Error(JSON.stringify(result));
        const written = readFileSync(join(root, 'shots', 'extracted_shot.rules'), 'utf-8');
        expect(written).toContain('Damage = 12');
        expect(written.startsWith('Damage')).toBe(true);
        expect(path.endsWith('part.rules')).toBe(true);
    });

    it('leaves a whole-file reference where the block was', async () => {
        const { result, edits } = await run(PART, 'shot_two.rules');
        if (!('written' in result)) throw new Error(JSON.stringify(result));
        const edit = Object.values(edits)[0]?.[0];
        expect(edit?.newText).toBe('Shot = &<shot_two.rules>');
    });

    it('re-expresses a path against the folder the new file lands in', async () => {
        const { result } = await run(PART, 'shots/deep/shot_three.rules');
        if (!('written' in result)) throw new Error(JSON.stringify(result));
        const written = readFileSync(join(root, 'shots', 'deep', 'shot_three.rules'), 'utf-8');
        expect(written).toContain('"../../shot.png"');
    });

    it('refuses to move the group the file is about', async () => {
        const alone = ['Shot', '{', '\tDamage = 12', '}', ''].join('\n');
        const path = join(root, 'lone.rules');
        const uri = filePathToUri(path);
        const open = TextDocument.create(uri, 'rules', 0, alone);
        const result = await extractGroupToFile(
            { uri, offset: alone.indexOf('Shot'), fileName: 'moved.rules' },
            { openDocuments: () => [open], applyEdit: async () => true, filesChanged: () => undefined },
            token
        );
        expect(result).toEqual({ failure: 'rootGroup' });
    });

    it('refuses a block that reads outside itself', async () => {
        const scoped = PART.replace('Damage = 12', 'Damage = (&~/DAMAGE)');
        const { result } = await run(scoped, 'scoped.rules');
        expect(result).toEqual({ failure: 'scopeRelativeValue' });
    });

    it('refuses a name that leaves the folder or is not a rules file', async () => {
        expect((await run(PART, '../escape.rules')).result).toEqual({ failure: 'badFileName' });
        expect((await run(PART, 'shot.txt')).result).toEqual({ failure: 'badFileName' });
    });

    it('refuses to write over a file that is already there', async () => {
        await run(PART, 'taken.rules');
        expect((await run(PART, 'taken.rules')).result).toEqual({ failure: 'fileExists' });
    });
});
