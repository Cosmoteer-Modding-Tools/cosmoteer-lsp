import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken, Connection, WorkDoneProgressReporter } from 'vscode-languageserver';
import { parseText } from '../../../src/utils/ast.utils';
import { filePathToUri } from '../../../src/document/reference-path';
import { buildPartGridEdit } from '../../../src/features/part-editor/grid-edit.service';
import { PartGridEditResult } from '../../../src/features/part-editor/part-grid.types';
import { globalSettings } from '../../../src/settings';
import { CosmoteerWorkspaceService } from '../../../src/workspace/cosmoteer-workspace.service';
import { FIXTURES_DIR } from '../../helpers';

// Which files the grid editor may write. A drag is an edit like any other, so the part's own file
// goes through the same gate as a write that follows a reference into another file.
const token = CancellationToken.None;

let root = '';
let vanillaPart = '';
let installedPart = '';
let modPart = '';
let wasAllowed = false;

/** Drags the part's size handle to 2x2 in one file. */
const resize = async (path: string): Promise<PartGridEditResult> => {
    const text = readFileSync(path, 'utf-8');
    return buildPartGridEdit(
        parseText(text, path),
        text,
        path,
        0,
        { op: 'setSize', size: { width: 2, height: 2 } },
        token
    );
};

/** The text the answered edit leaves in the file it names. */
const editedText = (path: string, result: PartGridEditResult): string => {
    const text = readFileSync(path, 'utf-8');
    const edits = result.edit!.changes![filePathToUri(path)];
    const lines = text.split('\n');
    const edit = edits[0];
    const line = lines[edit.range.start.line];
    lines[edit.range.start.line] =
        line.slice(0, edit.range.start.character) + edit.newText + line.slice(edit.range.end.character);
    return lines.join('\n');
};

beforeAll(async () => {
    const source = join(FIXTURES_DIR, 'part-editor', 'base_part.rules');
    root = mkdtempSync(join(tmpdir(), 'cosmoteer-grid-gate-'));

    const dataRoot = join(root, 'steamapps', 'common', 'Cosmoteer', 'Data');
    mkdirSync(join(dataRoot, 'ships'), { recursive: true });
    vanillaPart = join(dataRoot, 'ships', 'armor.rules');
    copyFileSync(source, vanillaPart);

    const installedRoot = join(root, 'steamapps', 'workshop', 'content', '799600', '1234');
    mkdirSync(installedRoot, { recursive: true });
    installedPart = join(installedRoot, 'armor.rules');
    copyFileSync(source, installedPart);
    writeFileSync(join(installedRoot, 'mod.rules'), 'Mod\n{\n\tID = someones_mod\n}\n');

    const modRoot = join(root, 'work', 'mod');
    mkdirSync(join(modRoot, 'parts'), { recursive: true });
    writeFileSync(join(modRoot, 'mod.rules'), 'Mod\n{\n\tID = my_mod\n}\n');
    modPart = join(modRoot, 'parts', 'armor.rules');
    copyFileSync(source, modPart);

    const noop: WorkDoneProgressReporter = { begin: () => undefined, report: () => undefined, done: () => undefined };
    const service = CosmoteerWorkspaceService.instance;
    service.setConnection({
        languages: { diagnostics: { refresh: () => undefined } },
        window: { showWarningMessage: () => undefined },
    } as unknown as Connection);
    globalSettings.cosmoteerPath = dataRoot;
    await service.initialize(dataRoot, noop);
    wasAllowed = globalSettings.allowEditingVanillaFiles;
    globalSettings.allowEditingVanillaFiles = false;
});

afterAll(() => {
    globalSettings.allowEditingVanillaFiles = wasAllowed;
    rmSync(root, { recursive: true, force: true });
});

describe('which files a grid drag may write', () => {
    it('refuses a part of the game install and says why', async () => {
        const result = await resize(vanillaPart);
        expect(result.status).toBe('error');
        expect(result.message).toContain('armor.rules');
        expect(result.edit).toBeUndefined();
    });

    it('refuses a part of somebody else installed mod', async () => {
        const result = await resize(installedPart);
        expect(result.status).toBe('error');
        expect(result.edit).toBeUndefined();
    });

    it('still resizes a part of the mod being edited', async () => {
        const result = await resize(modPart);
        expect(result.status, result.message).toBe('ok');
        expect(editedText(modPart, result)).toContain('Size = [2, 2]');
    });

    it('resizes a game part once the setting says the game data is being worked on', async () => {
        globalSettings.allowEditingVanillaFiles = true;
        try {
            const result = await resize(vanillaPart);
            expect(result.status, result.message).toBe('ok');
            expect(editedText(vanillaPart, result)).toContain('Size = [2, 2]');
        } finally {
            globalSettings.allowEditingVanillaFiles = false;
        }
    });
});
