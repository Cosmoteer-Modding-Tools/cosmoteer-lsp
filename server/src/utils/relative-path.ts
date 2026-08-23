import { resolve } from 'path';
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

/**
 * Whether a path sits inside a directory, folding case the way the filesystem matches it.
 *
 * @param fsPath the path to test.
 * @param root the directory it may sit in.
 * @returns true when the path is the directory or lies below it.
 */
export const isUnder = (fsPath: string, root: string | undefined): boolean => {
    if (!root) return false;
    const key = foldPathCase(resolve(fsPath).replace(/\\/g, '/'));
    const prefix = foldPathCase(resolve(root).replace(/\\/g, '/').replace(/\/+$/, ''));
    return key === prefix || key.startsWith(`${prefix}/`);
};
