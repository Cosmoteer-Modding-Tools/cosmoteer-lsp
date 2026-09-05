import { sep } from 'path';

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
