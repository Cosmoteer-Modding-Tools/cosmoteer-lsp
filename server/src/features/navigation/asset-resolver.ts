import { CancellationToken } from 'vscode-languageserver';
import { join } from 'path';
import { cachedReaddir } from '../../workspace/fs-cache';
import { AbstractNode, isValueNode, ValueNode } from '../../core/ast/ast';
import { CosmoteerWorkspaceService } from '../../workspace/cosmoteer-workspace.service';
import { AssetNavigationStrategy } from './asset.navigation-strategy';
import { FullNavigationStrategy } from './full.navigation-strategy';
import { assetBaseDirsFromInheritance, normalizeDir } from '../diagnostics/asset-base-path';
import { closestMatch } from '../../utils/did-you-mean';
import { assetExtensionsForType } from '../../utils/constants';

const assetNav = new AssetNavigationStrategy();
const fullNav = new FullNavigationStrategy();

/** True if a value node is an asset (sprite / sound / shader), the kinds with on-disk targets. */
export const isAssetValue = (node: AbstractNode | null | undefined): node is ValueNode =>
    !!node &&
    isValueNode(node) &&
    (node.valueType.type === 'Sprite' || node.valueType.type === 'Sound' || node.valueType.type === 'Shader');

/** The base directories an inherited asset can be relative to (see {@link assetBaseDirsFromInheritance}). */
const inheritanceBaseDirs = (node: ValueNode, uri: string, cancellationToken: CancellationToken): Promise<string[]> =>
    assetBaseDirsFromInheritance(
        node,
        uri,
        CosmoteerWorkspaceService.instance.CosmoteerWorkspacePath,
        fullNav.navigate.bind(fullNav),
        cancellationToken
    ).catch(() => []);

/**
 * Resolve an asset value node to its absolute on-disk path, relative to the containing
 * file first, then to any inherited asset base directory (mirrors how the value validator
 * decides whether the asset exists). Returns `null` when nothing matches.
 */
export const resolveAssetPath = async (
    node: ValueNode,
    uri: string,
    cancellationToken: CancellationToken
): Promise<string | null> => {
    const value = String(node.valueType.value);
    const direct = await assetNav.resolveAsset(value, node, uri).catch(() => null);
    if (direct) return direct;
    for (const dir of await inheritanceBaseDirs(node, uri, cancellationToken)) {
        // `resolveAsset` resolves relative to the directory of `currentLocation`, so point it
        // at a synthetic file inside the candidate base directory.
        const found = await assetNav.resolveAsset(value, node, dir + '/_').catch(() => null);
        if (found) return found;
    }
    return null;
};

/**
 * For a not-found asset, the closest-named existing file of the same kind in the
 * directories the asset could live in, returned as the full corrected value (the typed
 * path with only its filename swapped), or `null` when nothing is close enough.
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

    const targetDirs: string[] = [];
    if (/^\.\/data\//i.test(value)) {
        const dataRel = value.replace(/^\.\/data\//i, '');
        const dataSub = dataRel.includes('/') ? dataRel.slice(0, dataRel.lastIndexOf('/')) : '';
        targetDirs.push(join(CosmoteerWorkspaceService.instance.CosmoteerWorkspacePath, dataSub));
    } else {
        targetDirs.push(join(normalizeDir(uri), subDir));
        for (const base of await inheritanceBaseDirs(node, uri, cancellationToken)) {
            targetDirs.push(join(base, subDir));
        }
    }

    const names = new Set<string>();
    for (const dir of targetDirs) {
        try {
            for (const entry of await cachedReaddir(dir)) {
                if (entry.isFile() && extensions.some((extension) => entry.name.toLowerCase().endsWith(extension))) {
                    names.add(entry.name);
                }
            }
        } catch {
            // Directory does not exist (e.g. a typo'd sub-path), nothing to suggest from here.
        }
    }

    const suggestion = closestMatch(basename, names, true);
    if (!suggestion) return null;
    // Rebuild the full value with only the filename swapped, preserving the leading path.
    return value.slice(0, value.length - basename.length) + suggestion;
};
