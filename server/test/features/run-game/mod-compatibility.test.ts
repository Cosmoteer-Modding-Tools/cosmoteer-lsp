import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { manifestPathsIn } from '../../../src/mod/mod-dependencies';
import {
    GameVersionInfo,
    gameAssemblyPathFor,
    readGameVersionInfo,
} from '../../../src/features/post-update/game-version';
import { gameAcceptsModVersions } from '../../../src/features/run-game/run-game.command';

// Whether the command warns that the game will turn the mod straight back off is the game's own
// `ModInfo.IsCompatibleWithGameVersion`, and that rule takes a mod naming any of the roughly twenty
// older versions `Cosmoteer.Versions.ModCompatibleGameVersions` still accepts. Those versions exist
// nowhere but the installed assembly, so the cases that need them self-skip without an install, as
// the other corpus-backed tests do.
const DATA_DIR = process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const HAVE_GAME = existsSync(gameAssemblyPathFor(DATA_DIR));

const ROOT = join(tmpdir(), `run-game-compatibility-${process.pid}`);
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

let caseId = 0;

/**
 * Writes a throwaway mod folder, since the check reads manifests off the real filesystem.
 *
 * @param files the manifests to write, by name.
 * @returns the folder's path.
 */
const modFolder = (files: Record<string, string>): string => {
    const dir = join(ROOT, `case${caseId++}`);
    mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    return dir;
};

/** A manifest declaring the given version list, written on one line. */
const manifest = (versions: readonly string[]): string =>
    `ID = test.mod\nName = "Test"\nCompatibleGameVersions = [${versions.map((one) => `"${one}"`).join(', ')}]\n`;

describe("what the run command makes of a mod's declared game versions", () => {
    let info: GameVersionInfo;
    /** An older version this build still accepts, which is not the installed one. */
    let accepted: string;
    /** A version no current build accepts, taken from the era the workshop corpus still names. */
    const dropped = '0.22.0a';

    beforeAll(async () => {
        info = await readGameVersionInfo(HAVE_GAME ? DATA_DIR : undefined);
        accepted = info.accepted[0] ?? '';
    });

    it.runIf(HAVE_GAME)('takes a mod that names an older version the build still accepts', async () => {
        // The game answers true for any member of its accepted set, so warning here would send the
        // author after a problem the game does not have. Every one of the forty-four mods installed
        // on this machine sits in this case.
        const dir = modFolder({ 'mod.rules': manifest([accepted]) });
        expect(await gameAcceptsModVersions(dir, DATA_DIR)).toBe(true);
    });

    it.runIf(HAVE_GAME)('reads the live version list and not a commented-out one above it', async () => {
        const dir = modFolder({
            'mod.rules': `ID = test.mod\nName = "Test"\n//CompatibleGameVersions = ["${dropped}"]\n${manifest([info.installed])}`,
        });
        expect(await gameAcceptsModVersions(dir, DATA_DIR)).toBe(true);
    });

    it.runIf(HAVE_GAME)('reads a version list written across several lines', async () => {
        // Read as text confined to one line the list is invisible, and a mod naming nothing this
        // build takes then passes for one that declares nothing at all.
        const dir = modFolder({
            'mod.rules': `ID = test.mod\nName = "Test"\nCompatibleGameVersions = [\n    "${dropped}",\n    "0.23.0"\n]\n`,
        });
        expect(await gameAcceptsModVersions(dir, DATA_DIR)).toBe(false);
    });

    it.runIf(HAVE_GAME)('still turns down a mod that names only versions the build has dropped', async () => {
        const dir = modFolder({ 'mod.rules': manifest([dropped]) });
        expect(await gameAcceptsModVersions(dir, DATA_DIR)).toBe(false);
    });

    it.runIf(HAVE_GAME)('turns down a manifest that declares no versions at all', async () => {
        // The field is optional and has no initializer, so it reaches the game's rule as null and
        // that rule turns null away before it looks at anything else.
        const dir = modFolder({ 'mod.rules': 'ID = test.mod\nName = "Test"\n' });
        expect(await gameAcceptsModVersions(dir, DATA_DIR)).toBe(false);
    });

    it.runIf(HAVE_GAME)(
        'takes a mod whose version-split manifests name the installed version between them',
        async () => {
            const dir = modFolder({
                'mod.rules': manifest([dropped]),
                'mod_current.rules': manifest([info.installed]),
            });
            expect(await gameAcceptsModVersions(dir, DATA_DIR)).toBe(true);
        }
    );

    it('raises no alarm when the installed version facts cannot be read', async () => {
        // Without the assembly there is no accepted set, so there is no verdict to give, and a
        // verdict the editor cannot reach must not become a warning.
        const dir = modFolder({ 'mod.rules': manifest([dropped]) });
        expect(await gameAcceptsModVersions(dir, '')).toBe(true);
    });

    it.runIf(HAVE_GAME)('raises no alarm when the mod has no manifest to read', async () => {
        expect(await gameAcceptsModVersions(modFolder({}), DATA_DIR)).toBe(true);
    });
});

// The mods installed on this machine are the corpus this is judged on. The check must warn about a
// mod exactly when nothing it really declares is a version the build takes, which is decided here
// from the raw manifest text with the comments cut out, so the corpus is read a second way rather
// than by the code under test.
const WORKSHOP = process.env.COSMOTEER_WORKSHOP_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/workshop/content/799600';
const HAVE_WORKSHOP = HAVE_GAME && existsSync(WORKSHOP);

/**
 * Whether a mod's manifests name a version the build accepts, judged on the text a reader sees.
 *
 * The entries are unquoted before they are compared, since part of the corpus writes the versions
 * bare and the game reads both spellings the same way.
 *
 * @param modRoot the installed mod.
 * @param accepted every version the build takes.
 * @returns true when a line that is not commented out names one of them.
 */
const livingTextNamesAccepted = (modRoot: string, accepted: readonly string[]): boolean =>
    manifestPathsIn(modRoot).some((path) => {
        const living = readFileSync(path, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, ' ')
            .replace(/\/\/[^\n]*/g, ' ');
        const declared = living.match(/CompatibleGameVersions\s*=?\s*\[([\s\S]*?)\]/i)?.[1] ?? '';
        const written = declared.split(',').map((entry) => entry.trim().replace(/^"|"$/g, ''));
        return written.some((version) => accepted.includes(version));
    });

describe.runIf(HAVE_WORKSHOP)('the installed workshop mods', () => {
    it('warns about a mod exactly when it names no version this build takes', async () => {
        const info = await readGameVersionInfo(DATA_DIR);
        const folders = readdirSync(WORKSHOP)
            .map((id) => join(WORKSHOP, id))
            .filter((dir) => statSync(dir).isDirectory());
        const warned: string[] = [];
        const expected: string[] = [];
        for (const dir of folders) {
            if (!(await gameAcceptsModVersions(dir, DATA_DIR))) warned.push(dir);
            if (!livingTextNamesAccepted(dir, info.accepted)) expected.push(dir);
        }
        expect(warned).toEqual(expected);
        // Asking for the installed version alone is what this replaced, and hardly any mod names it,
        // because a mod names the version it was last updated for and the game has moved on since.
        const namingInstalled = folders.filter((dir) => livingTextNamesAccepted(dir, [info.installed]));
        expect(namingInstalled.length).toBeLessThan(folders.length / 4);
        expect(warned.length).toBeLessThan(folders.length / 4);
    });
});
