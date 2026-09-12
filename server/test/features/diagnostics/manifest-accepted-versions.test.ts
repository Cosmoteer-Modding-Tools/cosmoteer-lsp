import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken, Connection, WorkDoneProgressReporter } from 'vscode-languageserver';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { gameAssemblyPathFor, readGameVersionInfo } from '../../../src/features/game-version';
import {
    clearGameVersionsCache,
    validateManifestVersion,
} from '../../../src/features/diagnostics/validator.manifest-version';
import { CosmoteerWorkspaceService } from '../../../src/workspace/cosmoteer-workspace.service';

// The game turns a mod off while loading when its `CompatibleGameVersions` names neither the
// installed version nor one of the older ones the build still accepts, and the accepted set exists
// nowhere but the game assembly. So these cases build a throwaway install around a copy of it.
const GAME_DATA = process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const REAL_ASSEMBLY = gameAssemblyPathFor(GAME_DATA);
const HAVE_GAME = existsSync(REAL_ASSEMBLY);

const ROOT = join(tmpdir(), `manifest-accepted-versions-${process.pid}`);
const INSTALL = join(ROOT, 'Cosmoteer');
const DATA_ROOT = join(INSTALL, 'Data').replace(/\\/g, '/');
const MOD_DIR = join(ROOT, 'mod');

const token = CancellationToken.None;

const noProgress: WorkDoneProgressReporter = {
    begin: () => undefined,
    report: () => undefined,
    done: () => undefined,
};

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

/** The findings for a manifest text, written into the throwaway mod folder first. */
const validate = async (name: string, text: string) => {
    const path = join(MOD_DIR, name);
    writeFileSync(path, text);
    return validateManifestVersion(parser(lexer(text), pathToFileURL(path).href).value, token);
};

describe.runIf(HAVE_GAME)('a manifest against the versions the installed build accepts', () => {
    let installed = '';
    let older = '';

    beforeAll(async () => {
        mkdirSync(DATA_ROOT, { recursive: true });
        mkdirSync(join(INSTALL, 'Bin'), { recursive: true });
        mkdirSync(MOD_DIR, { recursive: true });
        writeFileSync(join(DATA_ROOT, 'cosmoteer.rules'), 'Cosmoteer\n{\n}\n');
        copyFileSync(REAL_ASSEMBLY, join(INSTALL, 'Bin', 'Cosmoteer.dll'));
        const service = CosmoteerWorkspaceService.instance;
        service.setConnection({
            languages: { diagnostics: { refresh: () => undefined } },
            window: { showWarningMessage: () => undefined },
        } as unknown as Connection);
        await service.initialize(DATA_ROOT, noProgress);
        clearGameVersionsCache();
        const info = await readGameVersionInfo(DATA_ROOT);
        installed = info.installed;
        // The oldest version the build still accepts: a mod naming it loads, however old it is.
        older = info.accepted[0];
    });

    it('reports a list naming nothing the build accepts', async () => {
        const errors = await validate(
            'mod.rules',
            'ID = test.mod\nName = "Old"\nCompatibleGameVersions = ["0.22.0a"]\n'
        );
        expect(errors).toHaveLength(1);
        expect(errors[0].severity).toBe('warning');
        expect(errors[0].message).toContain(installed);
    });

    it('offers a fix that makes the list name the current version', async () => {
        const text = 'ID = test.mod\nName = "Old"\nCompatibleGameVersions = ["0.22.0a", "0.21.0"]\n';
        const errors = await validate('mod.rules', text);
        const rewrite = (errors[0].data as { rewrite: { edits: { start: number; end: number; newText: string }[] } })
            .rewrite;
        const edit = rewrite.edits[0];
        expect(text.slice(0, edit.start) + edit.newText + text.slice(edit.end)).toBe(
            `ID = test.mod\nName = "Old"\nCompatibleGameVersions = ["${installed}"]\n`
        );
    });

    it('rewrites the bare list spelling as a whole too', async () => {
        const text = 'ID = test.mod\nName = "Old"\nCompatibleGameVersions\n[\n\t"0.22.0a"\n]\n';
        const errors = await validate('mod.rules', text);
        const rewrite = (errors[0].data as { rewrite: { edits: { start: number; end: number; newText: string }[] } })
            .rewrite;
        const edit = rewrite.edits[0];
        expect(text.slice(0, edit.start) + edit.newText + text.slice(edit.end)).toBe(
            `ID = test.mod\nName = "Old"\nCompatibleGameVersions = ["${installed}"]\n`
        );
    });

    it('stays silent on the installed version and on an older accepted one', async () => {
        expect(
            await validate('mod.rules', `ID = test.mod\nName = "N"\nCompatibleGameVersions = ["${installed}"]\n`)
        ).toEqual([]);
        expect(
            await validate('mod.rules', `ID = test.mod\nName = "N"\nCompatibleGameVersions = ["${older}"]\n`)
        ).toEqual([]);
    });

    it('stays silent on a manifest that declares no list', async () => {
        // A missing list is the selectability check's business, and only when the mod has more
        // than one manifest.
        expect(await validate('mod.rules', 'ID = test.mod\nName = "N"\n')).toEqual([]);
    });

    it("keeps the file's own line ending when it adds the missing field", async () => {
        // The added-field fix on a version-split manifest writes a whole line, and a lone `\n` in a
        // CRLF file leaves the manifest with mixed endings.
        writeFileSync(
            join(MOD_DIR, 'mod.rules'),
            `ID = test.mod\r\nName = "N"\r\nCompatibleGameVersions = ["${installed}"]\r\n`
        );
        const text = 'ID = test.mod\r\nName = "Old"\r\n';
        const errors = await validate('mod_old.rules', text);
        expect(errors).toHaveLength(1);
        const rewrite = (errors[0].data as { rewrite: { edits: { newText: string }[] } }).rewrite;
        expect(rewrite.edits[0].newText.endsWith('\r\n')).toBe(true);
        rmSync(join(MOD_DIR, 'mod_old.rules'), { force: true });
    });
});

// Every manifest of the local corpus the game itself ships or the author keeps current: none of them
// may be reported, since the check is on by default and each finding claims the mod does not load.
const CURRENT_CORPUS = [
    'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Standard Mods',
    'C:/Users/fpabs/Documents/Projekte/Star-Wars-A-Cosmos-Divided',
].filter((root) => existsSync(root));

/**
 * Every manifest under a folder, the way the game's own recursive scan finds them.
 *
 * @param dir the folder to walk.
 * @param depth how deep the walk already is, so a mod tree is not walked to its leaves.
 * @returns the manifest paths.
 */
const manifestsUnder = (dir: string, depth = 0): string[] => {
    if (depth > 3) return [];
    const out: string[] = [];
    for (const name of readdirSync(dir).slice(0, 500)) {
        const full = join(dir, name);
        let stats;
        try {
            stats = statSync(full);
        } catch {
            continue;
        }
        if (stats.isDirectory()) out.push(...manifestsUnder(full, depth + 1));
        else if (/^mod(_.*)?\.rules$/i.test(name)) out.push(full);
    }
    return out;
};

describe.runIf(HAVE_GAME && CURRENT_CORPUS.length > 0)('the version check over the up-to-date corpus', () => {
    beforeAll(async () => {
        const service = CosmoteerWorkspaceService.instance;
        service.setConnection({
            languages: { diagnostics: { refresh: () => undefined } },
            window: { showWarningMessage: () => undefined },
        } as unknown as Connection);
        await service.initialize(GAME_DATA, noProgress);
        clearGameVersionsCache();
    });

    it('reports nothing on the manifests the game ships and on a mod kept current', async () => {
        const files = CURRENT_CORPUS.flatMap((root) => manifestsUnder(root));
        expect(files.length).toBeGreaterThan(0);
        const findings: string[] = [];
        for (const file of files) {
            const text = await readFile(file, 'utf-8').catch(() => null);
            if (text === null) continue;
            const errors = await validateManifestVersion(parser(lexer(text), pathToFileURL(file).href).value, token);
            for (const error of errors) findings.push(`${file}: ${error.message}`);
        }
        expect(findings).toEqual([]);
    }, 120_000);
});
