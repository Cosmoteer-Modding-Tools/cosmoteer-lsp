import { createHash } from 'crypto';
import { statSync } from 'fs';
import { mkdir, readFile, rename, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join, relative } from 'path';
import { collectRulesFiles } from '../features/navigation/workspace-files';

// Persistent cache for the project indexes' game-tree contributions. The vanilla `Data` tree is
// large (~1000 files) and changes only when the game updates, so its converged index state is
// serialized to disk and reloaded on the next start instead of re-parsing the tree. Only the game
// tree is ever cached — mod/workspace files are re-scanned on every build, so an edited mod can
// never be served stale from here. Staleness of the game tree itself is caught by three keys, all
// checked on load: the cache format version, the running server build (a changed bundle may index
// differently), and a manifest of every `.rules` file's path, size, and mtime (a game update
// changes those, and an unchanged manifest means the parse inputs are bit-identical).

/** Bump when an index's serialized shape changes, so an old cache is discarded, not misread. */
const CACHE_FORMAT_VERSION = 1;

/** How many `stat` calls run concurrently while building the manifest. */
const STAT_CONCURRENCY = 64;

/** The on-disk shape of one saved cache file. */
interface CacheFile {
    formatVersion: number;
    serverBuildId: string;
    dataRoot: string;
    manifestHash: string;
    states: Record<string, unknown>;
}

/**
 * An identity for the running server build. The index contents depend on the schema and rooting
 * logic compiled into the bundle, so a rebuilt server must invalidate the cache. The bundled
 * file's size and mtime change on every rebuild, which covers releases and dev builds alike.
 *
 * @returns the build identity string, or '' when it can't be determined (cache then disabled).
 */
const serverBuildId = (): string => {
    try {
        const own = statSync(__filename);
        return `${own.size}:${Math.round(own.mtimeMs)}`;
    } catch {
        return '';
    }
};

/**
 * The absolute path of a named cache artifact for a given game Data root, under the OS-local
 * application data directory. Shared by the index cache and the mention cache so both key their
 * files by the same root identity.
 *
 * @param dataRoot the game `Data` root the cache belongs to.
 * @param name the artifact name (e.g. 'index-cache').
 * @returns the absolute cache file path.
 */
export const cacheArtifactPath = (dataRoot: string, name: string): string => {
    const key = createHash('sha1').update(dataRoot.replace(/\\/g, '/').toLowerCase()).digest('hex').slice(0, 16);
    const base = process.env.LOCALAPPDATA ?? tmpdir();
    return join(base, 'cosmoteer-lsp', `${name}-${key}.json`);
};

/** The running server build's identity, for cache invalidation across rebuilds. */
export const currentServerBuildId = (): string => serverBuildId();

/**
 * The cache file path for a given game Data root, under the OS-local application data directory.
 *
 * @param dataRoot the game `Data` root the cache belongs to.
 * @returns the absolute cache file path.
 */
const cacheFileFor = (dataRoot: string): string => cacheArtifactPath(dataRoot, 'index-cache');

/**
 * A hash over every `.rules` file's relative path, size, and mtime under the Data root. Equal
 * hashes mean the parse inputs are identical, so cached index state derived from them is valid.
 * Costs one directory walk plus a stat per file, a small fraction of parsing the tree.
 *
 * @param dataRoot the game `Data` root to fingerprint.
 * @returns the manifest hash.
 */
const manifestHashOf = async (dataRoot: string): Promise<string> => {
    const files: string[] = [];
    for await (const file of collectRulesFiles(dataRoot)) files.push(file);
    files.sort();
    const lines = new Array<string>(files.length);
    let next = 0;
    const worker = async (): Promise<void> => {
        while (next < files.length) {
            const index = next++;
            const file = files[index];
            try {
                const info = await stat(file);
                lines[index] = `${relative(dataRoot, file)}|${info.size}|${Math.round(info.mtimeMs)}`;
            } catch {
                lines[index] = `${relative(dataRoot, file)}|missing`;
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(STAT_CONCURRENCY, files.length || 1) }, worker));
    return createHash('sha1').update(lines.join('\n')).digest('hex');
};

/**
 * Loads the cached index states for a game Data root, when the cache exists and every validity key
 * (format version, server build, file manifest) still matches.
 *
 * @param dataRoot the game `Data` root being built.
 * @returns the per-index states keyed by cache id, or undefined on any miss or mismatch.
 */
export const tryLoadIndexCache = async (dataRoot: string): Promise<Record<string, unknown> | undefined> => {
    const buildId = serverBuildId();
    if (!buildId) return undefined;
    try {
        const raw = await readFile(cacheFileFor(dataRoot), { encoding: 'utf-8' });
        const cache = JSON.parse(raw) as CacheFile;
        if (cache.formatVersion !== CACHE_FORMAT_VERSION) return undefined;
        if (cache.serverBuildId !== buildId) return undefined;
        if (cache.dataRoot !== dataRoot) return undefined;
        if (cache.manifestHash !== (await manifestHashOf(dataRoot))) return undefined;
        return cache.states;
    } catch {
        return undefined;
    }
};

/**
 * Saves the per-index states for a game Data root. Best-effort: written to a temp file and renamed
 * into place so a crash can't leave a torn cache, and any failure is swallowed (the cache is an
 * optimization, never a requirement).
 *
 * @param dataRoot the game `Data` root the states were built from.
 * @param states the per-index states keyed by cache id.
 * @returns once the write finished or failed silently.
 */
export const saveIndexCache = async (dataRoot: string, states: Record<string, unknown>): Promise<void> => {
    const buildId = serverBuildId();
    if (!buildId) return;
    try {
        const file = cacheFileFor(dataRoot);
        await mkdir(dirname(file), { recursive: true });
        const cache: CacheFile = {
            formatVersion: CACHE_FORMAT_VERSION,
            serverBuildId: buildId,
            dataRoot,
            manifestHash: await manifestHashOf(dataRoot),
            states,
        };
        const temp = `${file}.${process.pid}.tmp`;
        await writeFile(temp, JSON.stringify(cache), { encoding: 'utf-8' });
        await rename(temp, file);
    } catch {
        /* best-effort cache, never fail the build over it */
    }
};
