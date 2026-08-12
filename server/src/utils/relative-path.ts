import { foldPathCase } from '../workspace/fs-cache';

/**
 * A file's path relative to the workspace folder holding it, for a diff header or a report line.
 * Paths are compared the way the platform's filesystem compares them, so a folder spelled with a
 * different case still matches on Windows and macOS.
 *
 * @param fsPath the file's on-disk path.
 * @param folders the workspace folders, as on-disk paths.
 * @returns the relative path with forward slashes, or the whole path when no folder holds it.
 */
export const workspaceRelativePath = (fsPath: string, folders: readonly string[]): string => {
    const normalized = fsPath.replace(/\\/g, '/');
    for (const folder of folders) {
        const prefix = `${folder.replace(/\\/g, '/').replace(/\/+$/, '')}/`;
        if (foldPathCase(normalized).startsWith(foldPathCase(prefix))) return normalized.slice(prefix.length);
    }
    return normalized;
};
