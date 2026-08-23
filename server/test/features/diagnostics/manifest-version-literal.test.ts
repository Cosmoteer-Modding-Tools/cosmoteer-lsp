import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken, Connection, WorkDoneProgressReporter } from 'vscode-languageserver';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { gameAssemblyPathFor, readGameVersionInfo } from '../../../src/features/post-update/game-version';
import {
    clearGameVersionsCache,
    currentGameVersionsLiteral,
    gameVersionsInsertLiteral,
    validateManifestVersion,
} from '../../../src/features/diagnostics/validator.manifest-version';
import { CosmoteerWorkspaceService } from '../../../src/workspace/cosmoteer-workspace.service';

// The version the quick fix inserts comes from the installed game, so these cases build a throwaway
// install: a `Data` root the workspace service is initialized against, the shipped Standard Mods
// beside it, and a copy of the game's own assembly under `Bin`. The assembly is the better source of
// the two, and the manifests are what is left when it cannot be read.
const GAME_DATA = process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const REAL_ASSEMBLY = gameAssemblyPathFor(GAME_DATA);
const HAVE_GAME = existsSync(REAL_ASSEMBLY);

const ROOT = join(tmpdir(), `manifest-version-literal-${process.pid}`);
const INSTALL = join(ROOT, 'Cosmoteer');
const DATA_ROOT = join(INSTALL, 'Data').replace(/\\/g, '/');

/**
 * A shipped Standard Mods manifest whose version list runs over several lines and keeps a
 * commented-out list above it, the two shapes a text match reads wrongly.
 */
const STANDARD_MOD = `ID = cosmoteer.example
Name = "Example"
//CompatibleGameVersions = [ "0.22.0a" ]
CompatibleGameVersions = [
    "9.9.9"
]
`;

const noProgress: WorkDoneProgressReporter = {
    begin: () => undefined,
    report: () => undefined,
    done: () => undefined,
};

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe('the game version the manifest quick fix inserts', () => {
    let installed = '';

    beforeAll(async () => {
        mkdirSync(join(INSTALL, 'Standard Mods', 'example'), { recursive: true });
        mkdirSync(DATA_ROOT, { recursive: true });
        writeFileSync(join(DATA_ROOT, 'cosmoteer.rules'), 'Cosmoteer\n{\n}\n');
        writeFileSync(join(INSTALL, 'Standard Mods', 'example', 'mod.rules'), STANDARD_MOD);
        const service = CosmoteerWorkspaceService.instance;
        service.setConnection({
            languages: { diagnostics: { refresh: () => undefined } },
            window: { showWarningMessage: () => undefined },
        } as unknown as Connection);
        await service.initialize(DATA_ROOT, noProgress);
        expect(service.dataRootPath?.replace(/\\/g, '/')).toBe(DATA_ROOT);
        installed = HAVE_GAME ? (await readGameVersionInfo(GAME_DATA)).installed : '';
    });

    it('reads a shipped manifest through the tree, not as text', async () => {
        // A text match takes the commented line, and one confined to a single line misses the live
        // list altogether.
        clearGameVersionsCache();
        expect(await currentGameVersionsLiteral()).toBe('["9.9.9"]');
    });

    it('falls back to the shipped manifests when there is no assembly to read', async () => {
        clearGameVersionsCache();
        expect(await gameVersionsInsertLiteral()).toBe('["9.9.9"]');
    });

    it.runIf(HAVE_GAME)('prefers the version the installed build states in its own assembly', async () => {
        // The assembly carries the installed version as a constant, so it says what the build is
        // rather than what its shipped mods were last edited to name.
        mkdirSync(join(INSTALL, 'Bin'), { recursive: true });
        copyFileSync(REAL_ASSEMBLY, join(INSTALL, 'Bin', 'Cosmoteer.dll'));
        clearGameVersionsCache();
        expect(await gameVersionsInsertLiteral()).toBe(`["${installed}"]`);
    });

    it.runIf(HAVE_GAME)('puts that version into the quick fix the diagnostic carries', async () => {
        const modDir = join(ROOT, 'mod');
        mkdirSync(modDir, { recursive: true });
        const dead = 'ID = test.mod\nName = "Old"\n';
        writeFileSync(join(modDir, 'mod.rules'), 'ID = test.mod\nName = "New"\nCompatibleGameVersions = ["9.9.9"]\n');
        writeFileSync(join(modDir, 'mod_old.rules'), dead);
        const uri = pathToFileURL(join(modDir, 'mod_old.rules')).href;
        clearGameVersionsCache();
        const errors = await validateManifestVersion(parser(lexer(dead), uri).value, CancellationToken.None);
        expect(errors).toHaveLength(1);
        const rewrite = (errors[0].data as { rewrite: { edits: { newText: string }[] } }).rewrite;
        expect(rewrite.edits[0].newText).toBe(`CompatibleGameVersions = ["${installed}"]\n`);
    });
});
