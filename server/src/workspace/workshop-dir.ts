import { existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { CosmoteerWorkspaceService } from './cosmoteer-workspace.service';

/** Cosmoteer's Steam app id, which names its workshop content folder. */
export const COSMOTEER_APP_ID = '799600';

/**
 * The Steam workshop content folder of the detected install, where every subscribed mod is
 * unpacked. Resolved off the game `Data` root rather than searched for, since Steam always lays the
 * two out relative to each other under the same library.
 *
 * @returns the folder, or undefined when the game was not installed through Steam or the folder
 *          does not exist (no mod has ever been subscribed).
 */
export const workshopContentDir = (): string | undefined => {
    const dataRoot = CosmoteerWorkspaceService.instance.dataRootPath;
    if (!dataRoot) return undefined;
    const dir = join(dataRoot, '..', '..', '..', 'workshop', 'content', COSMOTEER_APP_ID);
    return existsSync(dir) ? dir : undefined;
};

/**
 * The user's local mod folders: `<user data>/<steam id>/Mods`, where the game loads every mod that
 * did not come from the workshop (a hand-installed download, a mod being developed outside the open
 * workspace). Those mods are just as installed as a subscribed one, and a code mod among them
 * supplies types the files being edited legitimately name.
 *
 * Two locations are probed: the user's own home directory, and, for a Proton install where the
 * game writes into the prefix instead, the same path inside the compatibility data of this Steam
 * library, resolved off the `Data` root the way the workshop folder is.
 *
 * @returns every existing `Mods` folder, empty when the game has no user data yet.
 */
export const localModDirs = (): string[] => {
    const userDataRoots = [join(homedir(), 'Saved Games', 'Cosmoteer')];
    const dataRoot = CosmoteerWorkspaceService.instance.dataRootPath;
    if (dataRoot) {
        // …/steamapps/common/Cosmoteer/Data → …/steamapps/compatdata/799600/pfx/drive_c/users/steamuser
        const prefixHome = join(
            dataRoot, '..', '..', '..', 'compatdata', COSMOTEER_APP_ID,
            'pfx', 'drive_c', 'users', 'steamuser'
        );
        userDataRoots.push(join(prefixHome, 'Saved Games', 'Cosmoteer'));
    }
    const dirs: string[] = [];
    for (const root of userDataRoots) {
        let entries;
        try {
            // One folder per Steam account that has played on this machine.
            entries = readdirSync(root, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const mods = join(root, entry.name, 'Mods');
            if (existsSync(mods)) dirs.push(mods);
        }
    }
    return dirs;
};
