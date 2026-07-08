import { join, relative, resolve } from 'path';
import { filePathToDirectoryPath } from '../navigation/navigation-strategy';
import { findModRoot } from '../../mod/mod-root';
import { CosmoteerWorkspaceService } from '../../workspace/cosmoteer-workspace.service';

type RelativeEscape = { lt: number; gt: number; inner: string };

/**
 * Parses the leading `<...>` file portion of a reference value when it is a bare relative escape
 * (`<../...>` or `&<../...>`). Such a path resolves against the declaring file's own directory,
 * so its meaning changes whenever the file moves to a different depth.
 *
 * @param value the raw reference text.
 * @returns the bracket offsets and the slash-normalized inner path, or null when the value is not a bare relative escape.
 */
const parseRelativeEscape = (value: string): RelativeEscape | null => {
    const lt = value.indexOf('<');
    if (lt === -1 || lt > 1) return null;
    const gt = value.indexOf('>', lt);
    if (gt === -1) return null;
    const inner = value.slice(lt + 1, gt).replace(/\\/g, '/');
    if (!inner.startsWith('..')) return null;
    return { lt, gt, inner };
};

/**
 * Builds the reference text with the `<...>` portion swapped for the game-root form.
 *
 * @param value the original reference text.
 * @param esc the parsed escape from {@link parseRelativeEscape}.
 * @param rel the target path relative to the game `Data` folder.
 * @returns the rewritten reference text.
 */
const withDataEscape = (value: string, esc: RelativeEscape, rel: string): string =>
    value.slice(0, esc.lt + 1) + './Data/' + rel + value.slice(esc.gt);

/**
 * The `<./Data/../...>` game-root form of a resolving file-relative reference whose target lies in
 * a Steam workshop tree outside the declaring file's own mod. The game accepts both forms, but the
 * relative one depends on the declaring file's depth inside the mod while the game-root one
 * resolves from any file, so the game-root form is worth recommending.
 *
 * @param value the raw reference text.
 * @param uri the declaring document's uri.
 * @returns the rewritten reference text, or null when the reference is not a workshop escape or the game install is unknown.
 */
export const canonicalWorkshopEscape = (value: string, uri: string): string | null => {
    const esc = parseRelativeEscape(value);
    if (!esc) return null;
    const dataRoot = CosmoteerWorkspaceService.instance.dataRootPath;
    if (!dataRoot) return null;
    // A relative hop inside the declaring file's own mod is the normal way to reference a
    // sibling file, so only an escape that leaves the mod folder qualifies.
    const modRoot = findModRoot(uri);
    if (!modRoot) return null;
    const target = resolve(filePathToDirectoryPath(uri), esc.inner).replace(/\\/g, '/');
    if ((target + '/').toLowerCase().startsWith(modRoot.toLowerCase() + '/')) return null;
    if (!/\/workshop\//i.test(target + '/')) return null;
    const rel = relative(dataRoot, target).replace(/\\/g, '/');
    // A target on another drive yields an absolute path, which the game-root form cannot express.
    if (!rel.startsWith('..')) return null;
    return withDataEscape(value, esc, rel);
};

/**
 * The `<./Data/../...>` rewrite for a relative reference that names a `workshop` folder but does
 * not resolve, i.e. `<../../../workshop/...>` written from the wrong depth. The `..` hops are
 * replaced with the real path from the game `Data` folder to the workshop folder the declaring
 * mod lives in, falling back to the standard Steam layout's `../../../workshop` when the mod is
 * not inside a workshop folder itself. The caller must confirm the rewrite actually resolves
 * before offering it.
 *
 * @param value the raw reference text.
 * @param uri the declaring document's uri.
 * @returns the rewritten reference text, or null when the reference does not target a workshop path.
 */
export const intendedWorkshopEscape = (value: string, uri: string): string | null => {
    const esc = parseRelativeEscape(value);
    if (!esc) return null;
    const segments = esc.inner.split('/');
    const wsIndex = segments.findIndex((segment) => segment.toLowerCase() === 'workshop');
    if (wsIndex < 1 || !segments.slice(0, wsIndex).every((segment) => segment === '..')) return null;
    const dataRoot = CosmoteerWorkspaceService.instance.dataRootPath;
    if (!dataRoot) return null;
    const tail = segments.slice(wsIndex).join('/');
    const fileDir = filePathToDirectoryPath(uri).replace(/\\/g, '/');
    const anchor = /^(.*)\/workshop\//i.exec(fileDir + '/');
    if (anchor) {
        const rel = relative(dataRoot, join(anchor[1], tail)).replace(/\\/g, '/');
        if (rel.startsWith('..')) return withDataEscape(value, esc, rel);
    }
    return withDataEscape(value, esc, '../../../' + tail);
};
