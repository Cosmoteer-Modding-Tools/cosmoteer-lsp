import { filePathToDirectoryPath } from '../features/navigation/navigation-strategy';
import { isManifestBasename } from '../document/document-kind';
import { safeReaddir } from '../utils/fs.utils';

const rootCache = new Map<string, string | null>();

const dirHasManifest = (dir: string): boolean => safeReaddir(dir).some(isManifestBasename);

const parentDir = (dir: string): string => {
    const trimmed = dir.replace(/[\\/]+$/, '');
    const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
    return idx <= 0 ? '' : trimmed.substring(0, idx);
};

/**
 * Find the mod root for a document: the nearest ancestor directory containing a
 * `mod.rules`/`mod_*.rules` manifest. Returns the directory path (slash-normalized),
 * or null if the file is not inside a mod. Cached per directory.
 */
export const findModRoot = (uri: string): string | null => {
    let dir = filePathToDirectoryPath(uri).replace(/\\/g, '/').replace(/\/+$/, '');
    while (dir) {
        const cached = rootCache.get(dir);
        if (cached !== undefined) return cached;
        if (dirHasManifest(dir)) {
            rootCache.set(dir, dir);
            return dir;
        }
        const parent = parentDir(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
};

/** Test-only: clear the memoized roots. */
export const clearModRootCache = (): void => rootCache.clear();
