import { join } from 'path';
import { AbstractNode } from '../../core/ast/ast';
import { CosmoteerWorkspaceService } from '../../workspace/cosmoteer-workspace.service';
import { extractSubstrings, filePathToDirectoryPath, NavigationStrategy } from './navigation-strategy';
import { globalSettings } from '../../settings';
import { perfCount } from '../../utils/perf-counters';
import { cachedDirLookup, foldPathCase, onFsInvalidation } from '../../workspace/fs-cache';

// Asset existence is pure disk state, and a whole-workspace scan probes the same sprite/sound
// paths tens of thousands of times (shared bases reference the same assets from every deriving
// part). Resolved paths (and misses) are memoized here. Asset files themselves are not watched,
// but the memo is dropped with the fs caches, so any watched `.rules`/`.shader` change (which is
// also what triggers a revalidation in the first place) re-probes from disk.
/** Upper bound of memoized asset resolutions. */
const ASSET_MEMO_CAP = 32_768;

const assetMemo: Map<string, string | null> = new Map();

onFsInvalidation(() => assetMemo.clear());

export class AssetNavigationStrategy extends NavigationStrategy<boolean> {
    async navigate(path: string, startNode: AbstractNode, currentLocation: string): Promise<boolean> {
        return (await this.resolveAsset(path, startNode, currentLocation)) !== null;
    }

    /**
     * Resolve an asset path to the absolute on-disk file it names, or `null` if it does
     * not exist. The boolean-returning {@link navigate} is just this with the path
     * discarded. Go-to-definition and hover need the resolved path itself.
     */
    async resolveAsset(path: string, _startNode: AbstractNode, currentLocation: string): Promise<string | null> {
        // `./Data/…` is an absolute path from the Cosmoteer install root. The prefix is
        // matched case-insensitively because real assets use `./data/…` too (the file
        // system is case-insensitive on Windows, and mods rely on that).
        if (/^\.\/data\//i.test(path)) {
            return await this.resolveTroughCosmoteerFiles(path);
        }
        return await this.resolveTroughOwnFiles(path, currentLocation);
    }

    private resolveTroughCosmoteerFiles(path: string): Promise<string | null> {
        const pathWithoutData = path.replace(/^\.\/data/i, '');
        // The probe strips the last segment of a non-URI location (callers pass file paths), so
        // anchor the game root itself with a sentinel segment for the strip to consume.
        return this.resolveByCurrentLocation(
            extractSubstrings(pathWithoutData),
            join(CosmoteerWorkspaceService.instance.CosmoteerWorkspacePath ?? '', '_')
        );
    }

    private resolveTroughOwnFiles(path: string, currentLocation: string): Promise<string | null> {
        return this.resolveByCurrentLocation(extractSubstrings(path), currentLocation);
    }

    private resolveByCurrentLocation = async (pathes: string[], currentLocation: string): Promise<string | null> => {
        const memoKey = `${foldPathCase(filePathToDirectoryPath(currentLocation))} ${pathes.join('/').toLowerCase()}`;
        const cached = assetMemo.get(memoKey);
        if (cached !== undefined) {
            perfCount('asset.memoHit');
            return cached;
        }
        const resolved = await this.probeByCurrentLocation(pathes, currentLocation);
        assetMemo.set(memoKey, resolved);
        while (assetMemo.size > ASSET_MEMO_CAP) {
            const oldest = assetMemo.keys().next().value;
            if (oldest === undefined) break;
            assetMemo.delete(oldest);
        }
        return resolved;
    };

    private probeByCurrentLocation = async (pathes: string[], currentLocation: string): Promise<string | null> => {
        if (pathes.length === 0) return null;
        perfCount('asset.fsProbe');
        if (currentLocation.startsWith('file://')) {
            return this.walkFrom(filePathToDirectoryPath(currentLocation), pathes);
        }
        // A plain-path location may be a file (strip its last segment) or a directory a caller
        // anchored with a sentinel segment. The historical probe accepted both readings, and real
        // mods contain references that resolve only under the second (a leading `..` consumed by
        // the sentinel instead of ascending), so a miss on the stripped form retries whole.
        const stripped = await this.walkFrom(join(currentLocation, '..'), pathes);
        if (stripped !== null) return stripped;
        return this.walkFrom(currentLocation, pathes);
    };

    /**
     * Walks the path segment by segment through cached directory lookups, matching each segment
     * case-insensitively (the game resolves asset paths that way, and mods rely on it). Compared
     * to a per-candidate `access`/`realpath` probe this costs one cached listing per directory,
     * which is what makes whole-workspace asset validation cheap.
     */
    private walkFrom = async (startDir: string, pathes: string[]): Promise<string | null> => {
        let current = startDir;
        try {
            for (const segment of pathes) {
                if (segment === '.') continue;
                if (segment === '..') {
                    current = join(current, '..');
                    continue;
                }
                const real = (await cachedDirLookup(current)).get(segment.toLowerCase());
                if (real === undefined) return null;
                current = join(current, real);
            }
            return current;
        } catch (error) {
            // The walk left the tree or crossed a non-directory, so this is not a resolvable
            // asset. Only surface it under 'verbose', else it floods on whole-game-tree passes.
            if (globalSettings.trace.server === 'verbose') {
                console.error(error);
            }
            return null;
        }
    };
}
