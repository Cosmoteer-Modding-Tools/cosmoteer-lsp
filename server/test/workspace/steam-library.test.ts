import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
    defaultSteamInstallPaths,
    findCosmoteerDataPath,
    parseSteamLibraryPaths,
    steamInstallPaths,
} from '../../src/workspace/steam-library';

// winreg answers `(null, null)` when reg.exe exits cleanly with output it cannot parse.
vi.mock('winreg', () => ({
    default: class {
        static HKLM = 'HKLM';
        get(_name: string, callback: (error: Error | null, item: null) => void) {
            callback(null, null);
        }
    },
}));

describe('steamInstallPaths', () => {
    it('settles with the default Steam dir when the registry answers no item', async () => {
        const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
        Object.defineProperty(process, 'platform', { value: 'win32' });
        try {
            const paths = await steamInstallPaths();
            expect(paths).toHaveLength(1);
            expect(paths[0]).toMatch(/Steam$/);
        } finally {
            Object.defineProperty(process, 'platform', platform);
        }
    });
});

const vdfFor = (...libraryRoots: string[]): string => {
    const entries = libraryRoots
        .map(
            (root, index) =>
                `\t"${index}"\n\t{\n\t\t"path"\t\t"${root.replace(/\\/g, '\\\\')}"\n` +
                `\t\t"label"\t\t""\n\t\t"apps"\n\t\t{\n\t\t\t"799600"\t\t"123"\n\t\t}\n\t}\n`
        )
        .join('');
    return `"libraryfolders"\n{\n${entries}}\n`;
};

describe('parseSteamLibraryPaths', () => {
    it('extracts all library roots and unescapes backslashes', () => {
        const paths = parseSteamLibraryPaths(vdfFor('C:\\Program Files (x86)\\Steam', 'F:\\SteamLibrary'));
        expect(paths).toEqual(['C:\\Program Files (x86)\\Steam', 'F:\\SteamLibrary']);
    });

    it('returns an empty list for content without path entries', () => {
        expect(parseSteamLibraryPaths('"libraryfolders"\n{\n}\n')).toEqual([]);
    });
});

describe('defaultSteamInstallPaths', () => {
    it('lists the standard, symlink, flatpak and snap locations on linux', () => {
        const paths = defaultSteamInstallPaths('linux', '/home/mia');
        expect(paths).toEqual([
            join('/home/mia', '.local', 'share', 'Steam'),
            join('/home/mia', '.steam', 'steam'),
            join('/home/mia', '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam'),
            join('/home/mia', 'snap', 'steam', 'common', '.local', 'share', 'Steam'),
        ]);
    });

    it('lists the application support location on macos', () => {
        expect(defaultSteamInstallPaths('darwin', '/Users/mia')).toEqual([
            join('/Users/mia', 'Library', 'Application Support', 'Steam'),
        ]);
    });

    it('lists nothing on windows, where the registry provides the install dir', () => {
        expect(defaultSteamInstallPaths('win32', 'C:\\Users\\mia')).toEqual([]);
    });
});

describe('findCosmoteerDataPath', () => {
    let root: string;
    let steamDir: string;
    let libraryDir: string;

    const gameDataDir = (libraryRoot: string): string => join(libraryRoot, 'steamapps', 'common', 'Cosmoteer', 'Data');

    beforeAll(() => {
        root = mkdtempSync(join(tmpdir(), 'cosmo-steam-lib-'));
        steamDir = join(root, 'Steam');
        libraryDir = join(root, 'OtherDriveLibrary');
        mkdirSync(join(steamDir, 'steamapps'), { recursive: true });
        mkdirSync(gameDataDir(libraryDir), { recursive: true });
    });

    afterAll(() => {
        rmSync(root, { recursive: true, force: true });
    });

    it('finds the game in a secondary library listed in libraryfolders.vdf', async () => {
        writeFileSync(join(steamDir, 'steamapps', 'libraryfolders.vdf'), vdfFor(steamDir, libraryDir));
        expect(await findCosmoteerDataPath(steamDir)).toBe(gameDataDir(libraryDir));
    });

    it('falls back to probing the client dir when no vdf exists', async () => {
        const lonelySteam = join(root, 'LonelySteam');
        mkdirSync(gameDataDir(lonelySteam), { recursive: true });
        expect(await findCosmoteerDataPath(lonelySteam)).toBe(gameDataDir(lonelySteam));
    });

    it('returns undefined when no library contains the game', async () => {
        const emptySteam = join(root, 'EmptySteam');
        mkdirSync(join(emptySteam, 'steamapps'), { recursive: true });
        writeFileSync(join(emptySteam, 'steamapps', 'libraryfolders.vdf'), vdfFor(emptySteam));
        expect(await findCosmoteerDataPath(emptySteam)).toBeUndefined();
    });
});
