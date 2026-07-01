import { CancellationToken } from 'vscode-languageserver';
import { AbstractNode, isListNode, isGroupNode } from '../../core/ast/ast';
import { getStartOfAstNode } from '../../utils/ast.utils';
import { filePathToDirectoryPath } from '../navigation/navigation-strategy';

/** Normalize a `file://` URI or OS path to a slash-separated directory, no trailing slash. */
export const normalizeDir = (uriOrPath: string): string =>
    filePathToDirectoryPath(uriOrPath).replace(/\\/g, '/').replace(/\/+$/, '');

/**
 * Overlay a base-relative directory onto the current directory, merging at their
 * shared boundary.
 *
 * Cosmoteer mods overlay the game's `Data` tree, so a base whose directory is
 * `common_effects/sounds` (relative to the game root) maps onto the SAME relative
 * path under the mod root. Given the current file lives at `<mod>/common_effects`
 * and the base relative dir is `common_effects/sounds`, the shared `common_effects`
 * boundary is merged to yield `<mod>/common_effects/sounds`.
 */
export const overlayMergeDir = (currentDir: string, relDir: string): string => {
    const cur = currentDir.split('/').filter(Boolean);
    const rel = relDir.split('/').filter(Boolean);
    let k = Math.min(cur.length, rel.length);
    for (; k > 0; k--) {
        if (cur.slice(cur.length - k).join('/') === rel.slice(0, k).join('/')) break;
    }
    return [...cur, ...rel.slice(k)].join('/');
};

/** Resolves a reference to the node it points at (e.g. FullNavigationStrategy.navigate). */
export type ResolveReferenceFn = (
    path: string,
    startNode: AbstractNode,
    currentLocation: string,
    cancellationToken: CancellationToken
) => Promise<AbstractNode | null | { readonly type?: string } | undefined>;

/**
 * Candidate base directories for resolving a relative asset path, derived from the
 * inheritance of the asset's enclosing groups.
 *
 * In Cosmoteer, a relative asset path (e.g. `RandomSounds = ["crew_enter/x.wav"]`)
 * inside a group that inherits a base (`CrewEnterEffects : /BASE_SOUNDS/AudioInterior`)
 * is resolved relative to the directory of the file that defines that base, not the
 * file that contains the asset. We return, for every inherited base up the ancestor
 * chain, both the base file's own directory (covers a base in the same tree as the
 * asset) and that directory overlaid onto the current mod tree (covers a game base
 * whose mirrored directory in the mod holds the actual asset).
 *
 */
export const assetBaseDirsFromInheritance = async (
    assetNode: AbstractNode,
    assetUri: string,
    cosmoteerRoot: string,
    resolve: ResolveReferenceFn,
    cancellationToken: CancellationToken
): Promise<string[]> => {
    const dirs = new Set<string>();
    const currentDir = normalizeDir(assetUri);
    const root = cosmoteerRoot ? normalizeDir(cosmoteerRoot) : '';

    let ancestor: AbstractNode | undefined | null = assetNode.parent;
    const seen = new Set<AbstractNode>();
    while (ancestor && !seen.has(ancestor)) {
        seen.add(ancestor);
        if ((isGroupNode(ancestor) || isListNode(ancestor)) && ancestor.inheritance) {
            for (const inheritance of ancestor.inheritance) {
                if (inheritance.valueType.type !== 'Reference') continue;
                const base = await resolve(inheritance.valueType.value, inheritance, assetUri, cancellationToken).catch(
                    () => null
                );
                if (!base || (base as { type?: string }).type === 'File') continue;
                const baseUri = getStartOfAstNode(base as AbstractNode)?.uri;
                if (!baseUri) continue;
                const baseDir = normalizeDir(baseUri);
                dirs.add(baseDir);
                if (root && (baseDir === root || baseDir.startsWith(root + '/'))) {
                    const relDir = baseDir.slice(root.length).replace(/^\/+/, '');
                    if (relDir) dirs.add(overlayMergeDir(currentDir, relDir));
                }
            }
        }
        ancestor = ancestor.parent;
    }
    return [...dirs];
};
