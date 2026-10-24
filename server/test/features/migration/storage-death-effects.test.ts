import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { CancellationToken } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { parseText } from '../../../src/utils/ast.utils';
import { filePathToUri } from '../../../src/document/reference-path';
import { clearModRootCache } from '../../../src/mod/mod-root';
import { storageDeathEffectNotes } from '../../../src/features/migration/storage-death-effects';
import { initWorkspace } from '../../workspace-helper';

const token = CancellationToken.None;
const NEWLINE = String.fromCharCode(10);

let root: string;

const write = (path: string, body: string): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body, 'utf8');
};

/** The notes for a part whose one storage writes the given members, in a mod declaring `versions`. */
const notes = async (mod: string, versions: string, ...members: string[]): Promise<string[]> => {
    write(
        join(root, mod, 'mod.rules'),
        `ID = test.${mod}${NEWLINE}Name = x${NEWLINE}CompatibleGameVersions = ${versions}${NEWLINE}`
    );
    clearModRootCache();
    const path = join(root, mod, 'parts', 'probe.rules');
    const text = [
        'Part',
        '{',
        '    ID = probe.part',
        '    Components',
        '    {',
        '        Storage',
        '        {',
        '            Type = ResourceStorage',
        ...members.map((member) => `            ${member}`),
        '        }',
        '    }',
        '}',
        '',
    ].join(NEWLINE);
    const uri = filePathToUri(path);
    const doc = TextDocument.create(uri, 'rules', 0, text);
    return (await storageDeathEffectNotes(parseText(text, uri), doc, [join(root, 'Data')], token)).map(
        (note) => `${note.line}: ${note.message}`
    );
};

describe('storageDeathEffectNotes', () => {
    beforeAll(async () => {
        await initWorkspace();
        root = mkdtempSync(join(tmpdir(), 'storage-death-'));
        write(
            join(root, 'Data', 'resources', 'boom', 'boom.rules'),
            `ID = probe_boom${NEWLINE}DeathHitEffects = []${NEWLINE}`
        );
        write(
            join(root, 'Data', 'resources', 'calm', 'calm.rules'),
            `ID = probe_calm${NEWLINE}MaxPerNugget = 10${NEWLINE}`
        );
    });

    afterAll(() => rmSync(root, { recursive: true, force: true }));

    it('points out a storage of a pre-0.30.5 mod holding a resource with death effects', async () => {
        const found = await notes('old', '["0.30.4"]', 'ResourceType = probe_boom');
        expect(found).toHaveLength(1);
        expect(found[0]).toMatch(/^9: Since 0\.30\.5/);
        expect(found[0]).toContain('probe_boom');
    });

    it('stays quiet once the storage decides the flag itself', async () => {
        expect(
            await notes('decided', '["0.30.4"]', 'ResourceType = probe_boom', 'DoResourceDeathEffects = true')
        ).toEqual([]);
    });

    it('stays quiet for a resource without death effects', async () => {
        expect(await notes('calm', '["0.30.4"]', 'ResourceType = probe_calm')).toEqual([]);
    });

    it('stays quiet for a mod that names 0.30.5 or later', async () => {
        expect(await notes('rc', '["0.30.4", "0.30.5_rc5"]', 'ResourceType = probe_boom')).toEqual([]);
        expect(await notes('new', '["0.31.0"]', 'ResourceType = probe_boom')).toEqual([]);
    });
});
