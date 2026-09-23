import { Dirent } from 'fs';
import { join } from 'path';
import { isRulesFileName } from './document-kind';
import { uriToFsPath } from '../utils/uri-path';

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
        // `uriToFsPath` already decodes the escapes and drops the slash in front of a drive letter.
        // What the reference resolver keys by on top of that is forward slashes, an upper-cased
        // drive for consistency with the rest of the code base, and a trailing separator.
        const cleaned = uriToFsPath(path)
            .replace(/\\/g, '/')
            .replace(/^([a-z]):/, (_match, drive: string) => `${drive.toUpperCase()}:`);
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
    const encoded = withLeadingSlash
        .split('/')
        .map((segment) => (segment === '' ? '' : encodeURIComponent(segment)))
        .join('/');
    // A network share, `\\server\share\x`, carries its host in the uri's authority, so the two
    // leading slashes are the `file://` marker itself rather than part of the path. Kept as
    // `file:////server/…` the host would read as an empty authority plus a rooted path, which is a
    // second spelling of the same file and matches nothing the uri form of that path is keyed by.
    return 'file://' + (forward.startsWith('//') ? encoded.slice(2) : encoded);
};

/**
 * Split a reference or asset path into its non-empty `/`-separated segments.
 *
 * @param input the raw path text.
 * @returns the segments, in the order they are written.
 */
export const extractSubstrings = (input: string): string[] => input.split('/').filter(Boolean);

/** A `/`-delimited path segment of a reference value, and where it sits inside that value. */
export interface SegmentSpan {
    readonly text: string;
    readonly start: number;
    readonly end: number;
}

/**
 * Split a reference value into the same segments {@link extractSubstrings} returns, each carrying the
 * offsets it occupies inside the value. Navigation features that decorate or rewrite one segment of a
 * path need those offsets to turn a segment back into a range on the line.
 *
 * @param value the raw reference text, such as `&<file.rules>/Part/ID`.
 * @returns one span per segment, in the order the segments are written.
 */
export const segmentSpans = (value: string): SegmentSpan[] => {
    const spans: SegmentSpan[] = [];
    const regex = /[^/]+/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(value)) !== null) {
        spans.push({ text: match[0], start: match.index, end: match.index + match[0].length });
    }
    return spans;
};

/**
 * The bare member name a segment spells, so it can be compared against a declared name.
 *
 * @param span the segment to name.
 * @returns the segment text with its leading relative `&` sigil stripped.
 */
export const segmentName = (span: SegmentSpan): string => span.text.replace(/^&/, '');

/**
 * Remove whitespace that is in an ObjectText reference path the spaces ObjectText's
 * `PATH_RE` allows after `&`, around `/` and around segments (e.g. `& <file>/X`, `&  ~/Part`,
 * `^ / 0 / Part`). Whitespace inside a `<...>` file path is preserved, since a filename may contain
 * spaces. Used before resolving so `& <file>` resolves identically to `&<file>`.
 */
export const stripReferenceWhitespace = (path: string): string => {
    // Most paths carry no insignificant whitespace, and this runs once per reference resolution
    // before the navigation memo can even be consulted, so such a path is returned as it came.
    if (!path.includes(' ') && !path.includes('\t')) return path;
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
