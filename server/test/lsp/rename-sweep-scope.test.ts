import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, relative } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken, Connection, WorkDoneProgressReporter } from 'vscode-languageserver';
import { readClientCapabilities } from '../../src/capabilities';
import { initServerContext } from '../../src/lsp/context';
import { handleWillRenameFiles } from '../../src/lsp/handlers/lifecycle.handlers';
import { invalidateWorkspaceFoldersCache } from '../../src/lsp/workspace-folders';
import { globalSettings } from '../../src/settings';
import { CosmoteerWorkspaceService } from '../../src/workspace/cosmoteer-workspace.service';

// The repair runs inside `willRenameFiles`, which the editor blocks the rename on, and it sweeps
// once per moved file. Sweeping the game install as well costs the whole vanilla tree per rename and
// can only ever produce edits the write gate then drops, since an install file is not the author's
// to rewrite. The setting that lifts that gate is on here, so what keeps the install out of the
// answer is the folder list the handler searches and nothing else.
const token = CancellationToken.None;
let root = '';
let modRoot = '';
let vanillaFile = '';
let wasAllowed = false;

beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'cosmoteer-rename-scope-'));
    modRoot = join(root, 'Mod');
    mkdirSync(join(modRoot, 'shared'), { recursive: true });
    writeFileSync(join(modRoot, 'shared', 'base.rules'), 'Base\n{\n\tA = 1\n}\n');
    writeFileSync(join(modRoot, 'reader.rules'), 'Thing\n{\n\tValue = &<shared/base.rules>/Base/A\n}\n');

    const dataRoot = join(root, 'steamapps', 'common', 'Cosmoteer', 'Data');
    mkdirSync(join(dataRoot, 'ships'), { recursive: true });
    vanillaFile = join(dataRoot, 'ships', 'vanilla_reader.rules');
    const toBase = relative(dirname(vanillaFile), join(modRoot, 'shared', 'base.rules')).replace(/\\/g, '/');
    writeFileSync(vanillaFile, `Thing\n{\n\tValue = &<${toBase}>/Base/A\n}\n`);

    const noop: WorkDoneProgressReporter = { begin: () => undefined, report: () => undefined, done: () => undefined };
    const service = CosmoteerWorkspaceService.instance;
    service.setConnection({
        languages: { diagnostics: { refresh: () => undefined } },
        window: { showWarningMessage: () => undefined },
    } as unknown as Connection);
    globalSettings.cosmoteerPath = dataRoot;
    await service.initialize(dataRoot, noop);
    wasAllowed = globalSettings.allowEditingVanillaFiles;
    globalSettings.allowEditingVanillaFiles = true;

    // A client that opened the mod alone, which is the shape every one of them has: the game
    // install is detected from the settings, never opened as a folder.
    readClientCapabilities({ workspace: { workspaceFolders: true } });
    initServerContext({
        workspace: { getWorkspaceFolders: async () => [{ uri: pathToFileURL(modRoot).href, name: 'Mod' }] },
    } as unknown as Connection);
    invalidateWorkspaceFoldersCache();
}, 120_000);

afterAll(() => {
    globalSettings.allowEditingVanillaFiles = wasAllowed;
    invalidateWorkspaceFoldersCache();
    rmSync(root, { recursive: true, force: true });
});

/** The file names the repair proposes an edit in, for a move inside the mod. */
const repairedNames = async (oldPath: string, newPath: string): Promise<string[]> => {
    const edit = await handleWillRenameFiles(
        { files: [{ oldUri: pathToFileURL(oldPath).href, newUri: pathToFileURL(newPath).href }] },
        token
    );
    return Object.keys(edit?.changes ?? {}).map((uri) => fileURLToPath(uri).split(/[\\/]/).pop()!);
};

describe('the folders the rename repair sweeps', () => {
    it('repairs the open workspace', async () => {
        const names = await repairedNames(join(modRoot, 'shared', 'base.rules'), join(modRoot, 'lib', 'base.rules'));
        expect(names).toContain('reader.rules');
    });

    it('proposes nothing in the game install, which it never searched', async () => {
        const before = readFileSync(vanillaFile, 'utf8');
        const names = await repairedNames(join(modRoot, 'shared', 'base.rules'), join(modRoot, 'lib', 'base.rules'));
        expect(names).not.toContain('vanilla_reader.rules');
        expect(readFileSync(vanillaFile, 'utf8')).toBe(before);
    });
});
