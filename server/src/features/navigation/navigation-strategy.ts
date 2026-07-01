import { Dirent } from 'fs';
import { AbstractNode } from '../../core/ast/ast';
import { join } from 'path';
import { CancellationToken } from 'vscode-languageserver';

export abstract class NavigationStrategy<T> {
    abstract navigate(
        path: string,
        startNode: AbstractNode,
        currentLocation: string,
        cancellationToken: CancellationToken
    ): Promise<T>;
}

export const filePathToDirectoryPath = (path: string) => {
    if (path.startsWith('file://')) {
        let cleaned = path.slice('file://'.length);
        try {
            cleaned = decodeURIComponent(cleaned);
        } catch {
            /* malformed escape sequence — fall back to the raw remainder */
        }
        // `file:///C:/x` decodes to `/C:/x`. Drop the slash before a drive letter so it is a real
        // OS path, and upper-case the drive for consistency with the rest of the code base.
        const drive = cleaned.match(/^\/([a-zA-Z]):/);
        if (drive) cleaned = drive[1].toUpperCase() + cleaned.slice(2);
        return cleaned.substring(0, cleaned.lastIndexOf('/') + 1);
    }
    if (path.endsWith('.rules')) {
        return path.substring(0, (path.includes('/') ? path.lastIndexOf('/') : path.lastIndexOf('\\') - 1) + 1);
    }
    return path;
};

/**
 * Convert an on-disk path (e.g., a parsed cross-file document's `uri`, which is a real
 * OS path like `C:\…\b.rules`) into a `file://` URI usable as an LSP `Location.uri`.
 * Already-URI inputs (the open document's uri) are returned unchanged. Inverse of
 * {@link filePathToDirectoryPath}.
 */
export const filePathToUri = (path: string): string => {
    if (path.startsWith('file://')) return path;
    const forward = path.replace(/\\/g, '/');
    const withLeadingSlash = forward.startsWith('/') ? forward : '/' + forward;
    return (
        'file://' +
        withLeadingSlash
            .split('/')
            .map((segment) => (segment === '' ? '' : encodeURIComponent(segment)))
            .join('/')
    );
};

export const extractSubstrings = (input: string): string[] => {
    const regex = /([^/]+)/g;
    const matches = input.matchAll(regex);
    return Array.from(matches, (match) => match[1]);
};

/**
 * Remove whitespace that is in an ObjectText reference path the spaces ObjectText's
 * `PATH_RE` allows after `&`, around `/` and around segments (e.g. `& <file>/X`, `&  ~/Part`,
 * `^ / 0 / Part`). Whitespace inside a `<...>` file path is preserved, since a filename may contain
 * spaces. Used before resolving so `& <file>` resolves identically to `&<file>`.
 */
export const stripReferenceWhitespace = (path: string): string => {
    let out = '';
    let insideFilePath = false;
    for (const ch of path) {
        if (ch === '<') insideFilePath = true;
        else if (ch === '>') insideFilePath = false;
        if (!insideFilePath && (ch === ' ' || ch === '\t')) continue;
        out += ch;
    }
    return out;
};

export const createDirentPath = (dirent: Dirent) => {
    return join(dirent.parentPath, dirent.name);
};
