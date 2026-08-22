import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Connection, WorkDoneProgressReporter } from 'vscode-languageserver';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { gameAssemblyPathFor, readGameVersionInfo } from '../../../src/features/post-update/game-version';
import { loadedModKeyOf } from '../../../src/features/run-game/mod-identity';
import { CosmoteerWorkspaceService } from '../../../src/workspace/cosmoteer-workspace.service';

// Which manifest the game reads a mod's key from is `ModInfo.GetModInfoPath`, and its middle tier is
// a file naming one of the older versions the build still accepts. That list lives in the game
// assembly alone, so the case builds a throwaway install around a copy of it and self-skips without
// an install to copy.
const GAME_DATA = process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const REAL_ASSEMBLY = gameAssemblyPathFor(GAME_DATA);
const HAVE_GAME = existsSync(REAL_ASSEMBLY);

const ROOT = join(tmpdir(), `manifest-priority-${process.pid}`);
const INSTALL = join(ROOT, 'Cosmoteer');
const DATA_ROOT = join(INSTALL, 'Data').replace(/\\/g, '/');

const noProgress: WorkDoneProgressReporter = {
    begin: () => undefined,
    report: () => undefined,
    done: () => undefined,
};

/** A manifest body, with whatever extra members the case needs. */
const manifest = (version: string, extra = ''): string =>
    `ID = "me.mod"\nName = "A Mod"\nVersion = "${version}"\n${extra}`;

/**
 * Writes a mod folder with the given manifest files.
 *
 * @param name the folder to write it in.
 * @param manifests the manifests, by file name.
 * @returns the folder's path.
 */
const modFolder = (name: string, manifests: Record<string, string>): string => {
    const folder = join(ROOT, name);
    mkdirSync(folder, { recursive: true });
    for (const [file, text] of Object.entries(manifests)) writeFileSync(join(folder, file), text, 'utf8');
    return folder;
};

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe.runIf(HAVE_GAME)("choosing between a mod's manifests", () => {
    let installed = '';
    let accepted = '';

    beforeAll(async () => {
        mkdirSync(join(INSTALL, 'Bin'), { recursive: true });
        mkdirSync(DATA_ROOT, { recursive: true });
        writeFileSync(join(DATA_ROOT, 'cosmoteer.rules'), 'Cosmoteer\n{\n}\n');
        copyFileSync(REAL_ASSEMBLY, join(INSTALL, 'Bin', 'Cosmoteer.dll'));
        const service = CosmoteerWorkspaceService.instance;
        service.setConnection({
            languages: { diagnostics: { refresh: () => undefined } },
            window: { showWarningMessage: () => undefined },
        } as unknown as Connection);
        await service.initialize(DATA_ROOT, noProgress);
        const info = await readGameVersionInfo(DATA_ROOT);
        installed = info.installed;
        accepted = info.accepted[0] ?? '';
    });

    it('takes the variant naming an older version the build still accepts over the plain manifest', async () => {
        // The game scores that file above a `mod.rules` that names no version at all, so reading the
        // plain file means judging the mod by an id and version the game never loads it under.
        const folder = modFolder('accepted-variant', {
            'mod.rules': manifest('plain'),
            'mod_old.rules': manifest('accepted', `CompatibleGameVersions = ["${accepted}"]\n`),
        });
        expect(await loadedModKeyOf(folder)).toEqual({ id: 'me.mod', version: 'accepted' });
    });

    it('still takes the variant naming the installed version over one naming an older accepted version', async () => {
        const folder = modFolder('installed-variant', {
            'mod.rules': manifest('plain'),
            'mod_old.rules': manifest('accepted', `CompatibleGameVersions = ["${accepted}"]\n`),
            'mod_now.rules': manifest('current', `CompatibleGameVersions = ["${installed}"]\n`),
        });
        expect(await loadedModKeyOf(folder)).toEqual({ id: 'me.mod', version: 'current' });
    });

    it('still passes over a variant for a version the build has dropped', async () => {
        const folder = modFolder('dropped-variant', {
            'mod.rules': manifest('plain'),
            'mod_old.rules': manifest('stale', 'CompatibleGameVersions = ["0.22.0a"]\n'),
        });
        expect(await loadedModKeyOf(folder)).toEqual({ id: 'me.mod', version: 'plain' });
    });
});
