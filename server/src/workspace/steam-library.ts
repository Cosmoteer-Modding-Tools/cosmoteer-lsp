import { readFile, stat } from 'fs/promises';
import { homedir } from 'os';
import * as path from 'path';

/**
 * The Steam client install locations to probe on platforms without a registry. Covers the
 * standard Linux path, the `~/.steam/steam` symlink older setups rely on, the Flatpak and Snap
 * sandboxed installs, and the single macOS location. Windows returns no candidates because the
 * install dir comes from the registry there.
 *
 * @param platform the platform to list candidates for, defaults to the current process platform.
 * @param home the user home directory, defaults to the current user's.
 * @returns the candidate Steam client dirs in probe order, possibly not existing on disk.
 */
export const defaultSteamInstallPaths = (
    platform: NodeJS.Platform = process.platform,
    home: string = homedir()
): string[] => {
    if (platform === 'linux') {
        return [
            path.join(home, '.local', 'share', 'Steam'),
            path.join(home, '.steam', 'steam'),
            path.join(home, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam'),
            path.join(home, 'snap', 'steam', 'common', '.local', 'share', 'Steam'),
        ];
    }
    if (platform === 'darwin') {
        return [path.join(home, 'Library', 'Application Support', 'Steam')];
    }
    return [];
};

/**
 * Extracts every library root recorded in a Steam `libraryfolders.vdf`. The game may live in any
 * of these libraries (typically one per drive), not just under the Steam client install dir, so
 * auto-detection has to consider all of them. Values use VDF escaping (`\\` for a backslash),
 * which is unescaped here.
 *
 * @param vdfContent the raw text of a `libraryfolders.vdf` file.
 * @returns the library root paths in file order.
 */
export const parseSteamLibraryPaths = (vdfContent: string): string[] => {
    const paths: string[] = [];
    const pathEntry = /"path"\s+"((?:[^"\\]|\\.)*)"/gi;
    let match: RegExpExecArray | null;
    while ((match = pathEntry.exec(vdfContent)) !== null) {
        paths.push(match[1].replace(/\\(.)/g, '$1'));
    }
    return paths;
};

/**
 * Locates the Cosmoteer `Data` directory across all Steam library folders. Reads
 * `libraryfolders.vdf` (both the `config` and `steamapps` copies, whichever exist) to collect
 * the library roots, then probes each for `steamapps/common/Cosmoteer/Data` and returns the
 * first that actually exists on disk. The Steam client dir itself is always probed too, so a
 * missing or unparsable vdf degrades to the old single-library behavior.
 *
 * @param steamInstallPath the Steam client install dir from the registry.
 * @returns the existing Cosmoteer `Data` path, or `undefined` when no library contains the game.
 */
export const findCosmoteerDataPath = async (steamInstallPath: string): Promise<string | undefined> => {
    const libraryRoots = [steamInstallPath];
    const vdfCandidates = [
        path.join(steamInstallPath, 'config', 'libraryfolders.vdf'),
        path.join(steamInstallPath, 'steamapps', 'libraryfolders.vdf'),
    ];
    for (const vdfPath of vdfCandidates) {
        let content: string;
        try {
            content = await readFile(vdfPath, 'utf-8');
        } catch {
            continue;
        }
        for (const libraryRoot of parseSteamLibraryPaths(content)) {
            if (!libraryRoots.some((known) => known.toLowerCase() === libraryRoot.toLowerCase())) {
                libraryRoots.push(libraryRoot);
            }
        }
    }
    for (const libraryRoot of libraryRoots) {
        const candidate = path.join(libraryRoot, 'steamapps', 'common', 'Cosmoteer', 'Data');
        try {
            if ((await stat(candidate)).isDirectory()) return candidate;
        } catch {
            continue;
        }
    }
    return undefined;
};
