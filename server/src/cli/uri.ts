import { relative, resolve, sep } from 'path';

// Path conversion for the lint CLI. The server has equivalents, but they sit in modules that pull
// in the parse caches, the registrars and the workspace service, and the CLI is a separate bundle
// that only talks to a spawned server over stdio. Keeping these four lines local is what keeps the
// CLI bundle small enough to start in well under a second.

/**
 * Convert a `file://` URI published by the server back to an on-disk path.
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
        // A malformed escape is not worth failing a whole run over, so the raw form is used.
    }
    // `file:///C:/x` decodes to `/C:/x`, so the slash in front of a drive letter has to go.
    if (/^\/[a-zA-Z]:\//.test(path)) path = path.slice(1);
    return path.replace(/\//g, sep);
};

/**
 * Convert an on-disk path to the `file://` URI form the server and both editors use.
 *
 * @param path the on-disk path.
 * @returns the URI, with every segment percent-encoded.
 */
export const fsPathToUri = (path: string): string => {
    if (path.startsWith('file://')) return path;
    const forward = resolve(path).replace(/\\/g, '/');
    const withLeadingSlash = forward.startsWith('/') ? forward : `/${forward}`;
    return `file://${withLeadingSlash
        .split('/')
        .map((segment) => (segment === '' ? '' : encodeURIComponent(segment)))
        .join('/')}`;
};

/**
 * Express a file inside a workspace folder as the path a report carries: relative to the folder,
 * with forward slashes and no drive letter. A file outside every folder keeps its absolute path,
 * since inventing a `../..` chain for it would point a reader nowhere.
 *
 * @param roots the workspace folder paths the run covered.
 * @param path the absolute on-disk path of the file.
 * @returns the report path.
 */
export const reportPath = (roots: readonly string[], path: string): string => {
    const absolute = resolve(path);
    let best: string | undefined;
    for (const root of roots) {
        const relativePath = relative(resolve(root), absolute);
        if (relativePath === '' || relativePath.startsWith('..') || /^[a-zA-Z]:/.test(relativePath)) continue;
        if (best === undefined || relativePath.length < best.length) best = relativePath;
    }
    return (best ?? absolute).replace(/\\/g, '/');
};
