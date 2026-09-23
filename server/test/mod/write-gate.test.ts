import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Connection, WorkDoneProgressReporter } from 'vscode-languageserver';
import { globalSettings } from '../../src/settings';
import { CosmoteerWorkspaceService } from '../../src/workspace/cosmoteer-workspace.service';
import { migrationWriteScope } from '../../src/features/migration/migrate-workspace';
import { editableModRootOf, writableChanges, writeRefusalFor } from '../../src/mod/write-gate';

// A Steam layout of its own, so the gate is asked about a game install and an installed workshop mod
// without the real one having to be present, and without anything of the user's being written.
let root = '';
let dataRoot = '';
let vanillaFile = '';
let installedFile = '';
let modFile = '';
let looseFile = '';
let wasAllowed = false;

beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'cosmoteer-write-gate-'));
    dataRoot = join(root, 'steamapps', 'common', 'Cosmoteer', 'Data');
    mkdirSync(join(dataRoot, 'ships'), { recursive: true });
    vanillaFile = join(dataRoot, 'ships', 'armor.rules');
    writeFileSync(vanillaFile, 'Part\n{\n\tSize = [1, 1]\n}\n');

    const installedRoot = join(root, 'steamapps', 'workshop', 'content', '799600', '1234');
    mkdirSync(installedRoot, { recursive: true });
    installedFile = join(installedRoot, 'part.rules');
    writeFileSync(installedFile, 'Part\n{\n}\n');
    writeFileSync(join(installedRoot, 'mod.rules'), 'Mod\n{\n\tID = someones_mod\n}\n');

    const modRoot = join(root, 'work', 'mod');
    mkdirSync(join(modRoot, 'parts'), { recursive: true });
    writeFileSync(join(modRoot, 'mod.rules'), 'Mod\n{\n\tID = my_mod\n}\n');
    modFile = join(modRoot, 'parts', 'gun.rules');
    writeFileSync(modFile, 'Part\n{\n}\n');

    const looseRoot = join(root, 'work', 'loose');
    mkdirSync(looseRoot, { recursive: true });
    looseFile = join(looseRoot, 'fragment.rules');
    writeFileSync(looseFile, 'Thing\n{\n}\n');

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

describe('the gate that says which files a command may write', () => {
    it('refuses a file of the game install by default', () => {
        globalSettings.allowEditingVanillaFiles = false;
        expect(writeRefusalFor(vanillaFile)?.reason).toBe('gameInstall');
        expect(writeRefusalFor(vanillaFile)?.message).toContain('armor.rules');
    });

    it('lets the game install be written once the setting says the game data is being worked on', () => {
        globalSettings.allowEditingVanillaFiles = true;
        expect(writeRefusalFor(vanillaFile)).toBeUndefined();
        globalSettings.allowEditingVanillaFiles = false;
    });

    it('refuses somebody else installed workshop mod whatever the setting says', () => {
        for (const allowed of [false, true]) {
            globalSettings.allowEditingVanillaFiles = allowed;
            expect(writeRefusalFor(installedFile)?.reason, `the setting was ${allowed}`).toBe('installedMod');
        }
        globalSettings.allowEditingVanillaFiles = false;
    });

    it('lets a folder that carries no manifest be written, since a mod is often started without one', () => {
        expect(writeRefusalFor(looseFile)).toBeUndefined();
        expect(writeRefusalFor(modFile)).toBeUndefined();
    });

    it('keeps the entries of a change set it allows and drops the ones it refuses', () => {
        const changes = {
            [pathToFileURL(modFile).href]: ['the mod edit'],
            [pathToFileURL(vanillaFile).href]: ['the install edit'],
            [pathToFileURL(installedFile).href]: ['the other mod edit'],
        };
        const { kept, refused } = writableChanges(changes);
        expect(Object.keys(kept)).toEqual([pathToFileURL(modFile).href]);
        expect(refused.map((entry) => entry.reason).sort()).toEqual(['gameInstall', 'installedMod']);
    });

    it('still names a mod root for a file it allows, and none for one it refuses', () => {
        expect(editableModRootOf(modFile)?.toLowerCase()).toBe(join(root, 'work', 'mod').replace(/\\/g, '/').toLowerCase());
        expect(editableModRootOf(vanillaFile)).toBeUndefined();
        expect(editableModRootOf(installedFile)).toBeUndefined();
    });
});

describe('the files a workspace migration may write', () => {
    it('leaves the game install and an installed mod out, and says which tree it left alone', () => {
        globalSettings.allowEditingVanillaFiles = false;
        const scope = migrationWriteScope([modFile, looseFile, vanillaFile, installedFile]);
        expect(scope.files).toEqual([modFile, looseFile]);
        expect(scope.refusedTrees).toHaveLength(2);
        expect(scope.refusedTrees.join(' ')).toContain('armor.rules');
    });

    it('migrates a folder with no manifest, so the run is not reduced to nothing', () => {
        expect(migrationWriteScope([looseFile]).files).toEqual([looseFile]);
        expect(migrationWriteScope([looseFile]).refusedTrees).toEqual([]);
    });
});
