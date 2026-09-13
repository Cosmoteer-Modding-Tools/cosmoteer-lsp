import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken, Connection, WorkDoneProgressReporter } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { collectFileMigration } from '../../../src/features/migration/migrate-workspace';
import { clearGameVersionsCache } from '../../../src/features/diagnostics/validator.manifest-version';
import { gameAssemblyPathFor, readGameVersionInfo } from '../../../src/features/game-version';
import { CosmoteerWorkspaceService } from '../../../src/workspace/cosmoteer-workspace.service';

// A migrated mod has to be one the game still loads, so the migration brings the manifest's
// `CompatibleGameVersions` to the installed version. Which version that is comes out of the game
// assembly, so the case builds a throwaway install around a copy of it.
const GAME_DATA = process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const REAL_ASSEMBLY = gameAssemblyPathFor(GAME_DATA);
const HAVE_GAME = existsSync(REAL_ASSEMBLY);

const ROOT = join(tmpdir(), `migrate-manifest-version-${process.pid}`);
const INSTALL = join(ROOT, 'Cosmoteer');
const DATA_ROOT = join(INSTALL, 'Data').replace(/\\/g, '/');
const MANIFEST_URI = pathToFileURL(join(ROOT, 'mod', 'mod.rules')).href;

const token = CancellationToken.None;

const noProgress: WorkDoneProgressReporter = {
    begin: () => undefined,
    report: () => undefined,
    done: () => undefined,
};

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

/** Run the per-file migration over a manifest text. */
const migrate = async (text: string) => {
    const doc = TextDocument.create(MANIFEST_URI, 'rules', 0, text);
    const result = await collectFileMigration(parser(lexer(text), MANIFEST_URI).value, doc, false, token);
    return { result, applied: TextDocument.applyEdits(doc, result.edits) };
};

describe.runIf(HAVE_GAME)('the migration and the manifest version list', () => {
    let installed = '';

    beforeAll(async () => {
        mkdirSync(DATA_ROOT, { recursive: true });
        mkdirSync(join(INSTALL, 'Bin'), { recursive: true });
        mkdirSync(join(ROOT, 'mod'), { recursive: true });
        writeFileSync(join(DATA_ROOT, 'cosmoteer.rules'), 'Cosmoteer\n{\n}\n');
        copyFileSync(REAL_ASSEMBLY, join(INSTALL, 'Bin', 'Cosmoteer.dll'));
        const service = CosmoteerWorkspaceService.instance;
        service.setConnection({
            languages: { diagnostics: { refresh: () => undefined } },
            window: { showWarningMessage: () => undefined },
        } as unknown as Connection);
        await service.initialize(DATA_ROOT, noProgress);
        clearGameVersionsCache();
        installed = (await readGameVersionInfo(DATA_ROOT)).installed;
    });

    it('brings an outdated version list to the installed version and stops there', async () => {
        const text = 'ID = test.mod\nName = "Old"\nCompatibleGameVersions = ["0.22.0a"]\nVersion = "1.0"\n';
        const { result, applied } = await migrate(text);
        expect(applied).toBe(
            `ID = test.mod\nName = "Old"\nCompatibleGameVersions = ["${installed}"]\nVersion = "1.0"\n`
        );
        expect(result.byVersion[installed]).toBe(1);
        // Running the migration again over what it produced changes nothing.
        expect((await migrate(applied)).result.edits).toEqual([]);
    });

    it('rewrites a list the build still accepts but that does not name the installed version', async () => {
        const info = await readGameVersionInfo(DATA_ROOT);
        const older = info.accepted[0];
        const { applied } = await migrate(`ID = test.mod\nName = "Old"\nCompatibleGameVersions = ["${older}"]\n`);
        expect(applied).toContain(`["${installed}"]`);
    });

    it('leaves a manifest that already names the installed version alone', async () => {
        const text = `ID = test.mod\nName = "N"\nCompatibleGameVersions = ["${installed}", "0.30.0"]\n`;
        expect((await migrate(text)).result.edits).toEqual([]);
    });

    it('leaves a manifest that declares no version list alone', async () => {
        expect((await migrate('ID = test.mod\nName = "N"\n')).result.edits).toEqual([]);
    });

    it('rewrites the version list beside the manifest field renames', async () => {
        const text = 'ID = test.mod\nName = "Old"\nCompatibleGameVersions = ["0.22.0a"]\nModifiesMultiplayer = true\n';
        const { applied } = await migrate(text);
        expect(applied).toContain(`["${installed}"]`);
        expect(applied).toContain('ModifiesGameplay = true');
    });
});
