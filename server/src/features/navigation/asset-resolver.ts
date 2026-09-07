import { CancellationToken } from 'vscode-languageserver';
import { join } from 'path';
import { cachedDirLookup, cachedReaddir } from '../../workspace/fs-cache';
import { AbstractNode, isValueNode, ValueNode } from '../../core/ast/ast';
import { CosmoteerWorkspaceService } from '../../workspace/cosmoteer-workspace.service';
import { AssetNavigationStrategy } from './asset.navigation-strategy';
import { filePathToDirectoryPath } from './navigation-strategy';
import { closestMatch } from '../../utils/did-you-mean';
import { assetExtensionsForType } from '../../utils/constants';

const assetNav = new AssetNavigationStrategy();

/** How many folders below the declaring directory a moved asset is looked for. */
const RELOCATION_DEPTH = 4;

/** How many directories one search for a moved asset lists before it gives up. */
const RELOCATION_DIRECTORY_CAP = 400;

/** Normalize a `file://` URI or OS path to a slash-separated directory, no trailing slash. */
export const normalizeDir = (uriOrPath: string): string =>
    filePathToDirectoryPath(uriOrPath).replace(/\\/g, '/').replace(/\/+$/, '');

/** True if a value node is an asset (sprite / sound / shader), the kinds with on-disk targets. */
export const isAssetValue = (node: AbstractNode | null | undefined): node is ValueNode =>
    !!node &&
    isValueNode(node) &&
    (node.valueType.type === 'Sprite' || node.valueType.type === 'Sound' || node.valueType.type === 'Shader');

/**
 * Resolve an asset value node to its absolute on-disk path, or `null` when the file is not there.
 * The game combines a relative path with the directory of the file the value is written in, and
 * a `./` path with the install root, and looks nowhere else. A group inheriting a base defined
 * in another folder still reads its own asset paths from its own folder, so no inherited
 * directory is tried. The validator, hover and go-to-definition all go through here, which
 * keeps them agreeing with each other and with the game.
 *
 * @param node the asset value node.
 * @param uri the uri of the file the value is written in.
 * @param cancellationToken answers `null` once the caller has moved on.
 * @returns the absolute path of the asset, or `null` when the game would not find it either.
 */
export const resolveAssetPath = async (
    node: ValueNode,
    uri: string,
    cancellationToken: CancellationToken
): Promise<string | null> => {
    if (cancellationToken.isCancellationRequested) return null;
    return (await assetNav.resolveAsset(String(node.valueType.value), node, uri).catch(() => null)) ?? null;
};

/**
 * For a not-found asset, the value to write instead: the closest-named file of the same kind in
 * the directory the path points at, which catches a typo, or failing that the same relative path
 * found under a sub-folder of the declaring directory, which catches a definition copied from
 * another folder whose asset came along into a folder the path does not name. Returned as the
 * full corrected value, or `null` when nothing fits.
 *
 * @param node the asset value node that did not resolve.
 * @param uri the uri of the file the value is written in.
 * @param cancellationToken stops the search for a moved asset.
 * @returns the corrected value, or `null`.
 */
export const suggestAssetFilename = async (
    node: ValueNode,
    uri: string,
    cancellationToken: CancellationToken
): Promise<string | null> => {
    if (!isAssetValue(node)) return null;
    const value = String(node.valueType.value);
    const lastSlash = value.lastIndexOf('/');
    const basename = lastSlash >= 0 ? value.slice(lastSlash + 1) : value;
    const subDir = lastSlash >= 0 ? value.slice(0, lastSlash) : '';
    const extensions = assetExtensionsForType(node.valueType.type as 'Sprite' | 'Sound' | 'Shader');
    const installRooted = /^\.\/data\//i.test(value);

    let targetDir: string;
    if (installRooted) {
        const dataRel = value.replace(/^\.\/data\//i, '');
        const dataSub = dataRel.includes('/') ? dataRel.slice(0, dataRel.lastIndexOf('/')) : '';
        targetDir = join(CosmoteerWorkspaceService.instance.CosmoteerWorkspacePath, dataSub);
    } else {
        targetDir = join(normalizeDir(uri), subDir);
    }

    const names = new Set<string>();
    try {
        for (const entry of await cachedReaddir(targetDir)) {
            if (entry.isFile() && extensions.some((extension) => entry.name.toLowerCase().endsWith(extension))) {
                names.add(entry.name);
            }
        }
    } catch {
        // The directory does not exist (a typo in the sub-path, say), nothing to suggest from here.
    }
    const typo = closestMatch(basename, names, true);
    // Rebuild the full value with only the filename swapped, preserving the leading path.
    if (typo) return value.slice(0, value.length - basename.length) + typo;
    if (installRooted) return null;
    return findRelocatedAsset(normalizeDir(uri), value, cancellationToken);
};

/**
 * Looks for the value's path below the sub-folders of a directory, nearest folder first, and
 * answers the path that reaches it from that directory. Bounded in depth and in directories
 * listed, since it runs once per asset that is not where its path says.
 *
 * @param baseDir the directory the value is resolved against.
 * @param value the asset path as written.
 * @param cancellationToken stops the walk.
 * @returns the value prefixed with the folder it was found under, or `null`.
 */
const findRelocatedAsset = async (
    baseDir: string,
    value: string,
    cancellationToken: CancellationToken
): Promise<string | null> => {
    const segments = value.split('/').filter((segment) => segment.length > 0 && segment !== '.');
    if (segments.length === 0 || segments.includes('..')) return null;
    const queue: { dir: string; rel: string[] }[] = [{ dir: baseDir, rel: [] }];
    let listed = 0;
    while (queue.length > 0) {
        if (cancellationToken.isCancellationRequested || listed >= RELOCATION_DIRECTORY_CAP) return null;
        const { dir, rel } = queue.shift()!;
        let subDirs: string[];
        try {
            subDirs = (await cachedReaddir(dir))
                .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
                .map((entry) => entry.name)
                .sort();
        } catch {
            continue;
        }
        listed++;
        for (const name of subDirs) {
            const child = join(dir, name);
            const childRel = [...rel, name];
            if (await existsBelow(child, segments)) return [...childRel, value].join('/');
            if (childRel.length < RELOCATION_DEPTH) queue.push({ dir: child, rel: childRel });
        }
    }
    return null;
};

/**
 * Whether the segments name an entry below the directory, each matched without regard to case,
 * the way the game's file system matches them.
 *
 * @param dir the directory to start from.
 * @param segments the path segments to follow.
 * @returns true when every segment is found.
 */
const existsBelow = async (dir: string, segments: string[]): Promise<boolean> => {
    let current = dir;
    try {
        for (const segment of segments) {
            const real = (await cachedDirLookup(current)).get(segment.toLowerCase());
            if (real === undefined) return false;
            current = join(current, real);
        }
        return true;
    } catch {
        return false;
    }
};
