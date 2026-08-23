/**
 * The two encodings every markdown report shares: the destination of a `vscode://file/…` deep link,
 * and inline code that survives a backtick in the text it wraps.
 *
 * The reports are read side by side, so a link that works in one and breaks in another is a bug the
 * reader has to diagnose. One home for the encoding is what keeps them spelling a path the same way.
 */

/**
 * The destination part of a `vscode://file/…` link. A `file:` uri cannot be used at all, since
 * markdown-it's link validator (in VS Code's own preview too) rejects the scheme outright and leaves
 * the raw `[…](…)` text visible. Each path segment is percent-encoded on its own so the separators
 * survive, and parentheses are encoded on top of that: an unencoded `)` in a file name such as
 * `Kopie (2).rules` would close the markdown destination early.
 *
 * @param path the file's path, with either separator.
 * @returns the encoded destination, without the scheme and without any `:line` suffix.
 */
export const linkDestination = (path: string): string =>
    path
        .replace(/\\/g, '/')
        .split('/')
        .map((segment) => encodeURIComponent(segment).replace(/\(/g, '%28').replace(/\)/g, '%29'))
        .join('/');

/**
 * The plain OS path behind a uri. A parsed cross-file document carries a plain path while the open
 * document carries a real uri, so both shapes reach the reports and only the second arrives encoded.
 *
 * @param uri the uri or the path.
 * @returns the decoded path, with the leading slash of a Windows drive letter dropped.
 */
export const plainPathOf = (uri: string): string =>
    uri.startsWith('file://') ? decodeURIComponent(uri.slice('file://'.length)).replace(/^\/(?=[A-Za-z]:)/, '') : uri;

/**
 * Markdown-safe inline code. A backtick cannot appear in an id or a `.rules` path anyway, so the
 * one it could carry is swapped for an apostrophe rather than escaped.
 *
 * @param text the text to wrap.
 * @returns the text as a code span.
 */
export const code = (text: string): string => '`' + text.replace(/`/g, "'") + '`';
