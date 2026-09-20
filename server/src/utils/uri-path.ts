import { sep } from 'path';

/** Whether the platform's default filesystem resolves paths case-insensitively. On Linux two
 *  paths differing only in case are distinct files, so folding keys there would let one file's
 *  cache entry answer for the other.
 *
 *  The game draws the same line, in `Halfling.IO.FilePath`: it compares every path through a
 *  comparer chosen as `IsCaseSensitive ? Ordinal : OrdinalIgnoreCase`, which is what decides
 *  whether it reads two spellings of a mod folder as one. It answers `IsCaseSensitive` by
 *  probing the filesystem rather than by naming the operating system. */
const CASE_INSENSITIVE_PATHS = process.platform === 'win32' || process.platform === 'darwin';

// The same uri strings are normalized over and over during a workspace scan (every diagnostic,
// index entry, and reference resolution keys by the canonical form), so the pure computation is
// memoized. Bounded by wholesale reset: uri variety is low, an LRU is not worth the bookkeeping.
const normalizeUriMemo = new Map<string, string>();
const NORMALIZE_URI_MEMO_CAP = 16384;

/**
 * Convert a `file://` URI to an on-disk path (Windows-aware). Kept free of every other server module
 * on purpose: the lint CLI is a separate bundle that only talks to a spawned server over stdio, and
 * pulling the parse caches or the workspace service into it would cost the sub-second start it has.
 *
 * @param uri the URI as it arrived on the wire.
 * @returns the on-disk path, or `uri` unchanged when it is not a `file://` URI.
 */
export const uriToFsPath = (uri: string): string => {
    if (!uri.startsWith('file://')) return uri;
    let path = uri.slice('file://'.length);
    try {
        path = decodeURIComponent(path);
    } catch {
        // A malformed escape is not worth failing over, so the raw form is used.
    }
    // `file:///C:/x` decodes to `/C:/x`, so the slash in front of a drive letter has to go.
    if (/^\/[a-zA-Z]:\//.test(path)) path = path.slice(1);
    return path.replace(/\//g, sep);
};

/**
 * Canonicalize a `file://` URI or OS path for identity comparison (decode, slashes, case).
 *
 * Every identity comparison in the server passes through here, including the keys read back out of
 * the caches written to disk, so a missing key answers the empty string rather than throwing. A key
 * that is not there matches nothing, which is what the callers want, and taking the whole server
 * down over one is a far worse answer than looking the wrong entry up.
 *
 * @param uriOrPath the file's uri or OS path.
 * @returns the canonical form, or the empty string when there is nothing to canonicalize.
 */
export const normalizeUri = (uriOrPath: string): string => {
    if (!uriOrPath) return '';
    const cached = normalizeUriMemo.get(uriOrPath);
    if (cached !== undefined) return cached;
    let path = uriOrPath.startsWith('file://') ? uriOrPath.slice('file://'.length) : uriOrPath;
    try {
        path = decodeURIComponent(path);
    } catch {
        /* leave as-is on malformed escapes */
    }
    const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
    if (normalizeUriMemo.size >= NORMALIZE_URI_MEMO_CAP) normalizeUriMemo.clear();
    normalizeUriMemo.set(uriOrPath, normalized);
    return normalized;
};

/**
 * Case-folds a path-derived cache key only where the filesystem is case-insensitive, so derived
 * caches (the navigation and asset memos) share the same collision-safety as the fs caches.
 *
 * @param pathKey the path or path-derived string to fold.
 * @returns the folded key on Windows/macOS, the unchanged string elsewhere.
 */
export const foldPathCase = (pathKey: string): string => (CASE_INSENSITIVE_PATHS ? pathKey.toLowerCase() : pathKey);
