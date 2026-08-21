import { readdir } from 'fs/promises';
import { join } from 'path';
import { isManifestBasename, isRulesFileName } from '../../document/document-kind';

// The file walk the load check runs over one mod folder. It mirrors what the game does when it
// looks for a manifest: `ModInfo.GetModInfoPath` calls `Directory.GetFiles(modFolder, "mod.rules",
// AllDirectories)` and then the same for `mod_*.rules`, so a manifest in a subfolder counts and no
// other filename is ever a manifest.

/** How deep the walk goes. A mod nests a few folders, and a symlink loop must not hang a build. */
const MAX_DEPTH = 24;

/** What one walk of a mod folder found. */
export interface ModFiles {
    /** Every `.rules` and `.txt` file under the folder, absolute, in walk order. */
    rulesFiles: string[];
    /** The subset the game would read as a manifest. */
    manifests: string[];
}

/**
 * Walk a mod folder for the files the load check reads.
 *
 * @param root the mod folder, absolute.
 * @returns every rules file under it and the manifests among them.
 */
export const walkModFiles = async (root: string): Promise<ModFiles> => {
    const rulesFiles: string[] = [];
    const manifests: string[] = [];
    const visit = async (directory: string, depth: number): Promise<void> => {
        if (depth > MAX_DEPTH) return;
        const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            const full = join(directory, entry.name);
            if (entry.isDirectory()) {
                await visit(full, depth + 1);
            } else if (entry.isFile() && isRulesFileName(entry.name)) {
                rulesFiles.push(full);
                if (isManifestBasename(entry.name)) manifests.push(full);
            }
        }
    };
    await visit(root, 0);
    rulesFiles.sort();
    manifests.sort();
    return { rulesFiles, manifests };
};
