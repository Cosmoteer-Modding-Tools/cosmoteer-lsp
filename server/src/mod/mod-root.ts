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
 * or null if the file is not inside a mod. Every directory visited on the walk is
 * cached with the outcome, negatives included, so repeated lookups from deep files
 * cost one map hit instead of a readdir per ancestor.
 */
export const findModRoot = (uri: string): string | null => {
    let dir = filePathToDirectoryPath(uri).replace(/\\/g, '/').replace(/\/+$/, '');
    const visited: string[] = [];
    let result: string | null = null;
    while (dir) {
        const cached = rootCache.get(dir);
        if (cached !== undefined) {
            result = cached;
            break;
        }
        visited.push(dir);
        if (dirHasManifest(dir)) {
            result = dir;
            break;
        }
        const parent = parentDir(dir);
        if (parent === dir) break;
        dir = parent;
    }
    for (const seen of visited) rootCache.set(seen, result);
    return result;
};

/** Drop the memoized roots (call when a manifest file is created or deleted). */
export const clearModRootCache = (): void => rootCache.clear();
