import { Dirent } from 'fs';
import { AbstractNode } from '../../core/ast/ast';
import { isRulesFileName } from '../../document/document-kind';
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

// The same file uris and paths are converted over and over (every reference resolution and memo
// key derivation goes through here), so the pure computation is memoized. Bounded by wholesale
// reset, matching the normalizeUri memo.
const directoryPathMemo = new Map<string, string>();
const DIRECTORY_PATH_MEMO_CAP = 16384;

export const filePathToDirectoryPath = (path: string) => {
    const cached = directoryPathMemo.get(path);
    if (cached !== undefined) return cached;
    let result: string;
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
        result = cleaned.substring(0, cleaned.lastIndexOf('/') + 1);
    } else if (isRulesFileName(path)) {
        result = path.substring(0, (path.includes('/') ? path.lastIndexOf('/') : path.lastIndexOf('\\') - 1) + 1);
    } else {
        result = path;
    }
    if (directoryPathMemo.size >= DIRECTORY_PATH_MEMO_CAP) directoryPathMemo.clear();
    directoryPathMemo.set(path, result);
    return result;
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
    // A manual scan of the slash-separated segments. The previous matchAll form allocated a
    // regex iterator and match arrays per call, and this runs for every reference and asset
    // path a scan resolves.
    const out: string[] = [];
    let start = -1;
    for (let i = 0; i < input.length; i++) {
        if (input.charCodeAt(i) === 47) {
            if (start !== -1) {
                out.push(input.slice(start, i));
                start = -1;
            }
        } else if (start === -1) {
            start = i;
        }
    }
    if (start !== -1) out.push(input.slice(start));
    return out;
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
