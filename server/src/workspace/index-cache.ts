import { createHash } from 'crypto';
import { statSync } from 'fs';
import { mkdir, readdir, readFile, rename, stat, unlink, utimes, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join, relative } from 'path';
import { collectRulesFiles } from '../features/navigation/workspace-files';

// Persistent caches for the project indexes.
//
// Game-tree cache: the vanilla `Data` tree is large (~1000 files) and changes only when the game
// updates, so its converged index state is serialized to disk and reloaded on the next start
// instead of re-parsing the tree. Staleness is caught by three keys, all checked on load: the
// cache format version, the running server build (a changed bundle may index differently), and a
// manifest of every `.rules` file's path, size, and mtime (a game update changes those, and an
// unchanged manifest means the parse inputs are bit-identical).
//
// Project cache: the combined game-plus-workspace index state, plus a per-workspace-file stamp
// (size and mtime) for every file it covers. Unlike the game tree, workspace files change all the
// time, so the whole-state validity keys are joined by a per-file diff on load: the caller
// re-ingests exactly the files whose stamp moved (or that appeared/disappeared) and serves the
// rest from the cache. A file that was indexed from an open editor buffer is saved without a
// stamp, which the diff treats as changed, so possibly-unsaved buffer content can never be served
// as disk state on a later start.

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

/** Cache artifacts unused for this long are deleted (a renamed mod or moved install orphans its
 *  files forever otherwise, since their names hash the old paths). */
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Torn temp files older than this are leftovers of a crashed write, never a write in progress. */
const TEMP_MAX_AGE_MS = 60 * 60 * 1000;

/** Whether this process already pruned the cache directory (once per session is plenty). */
let pruned = false;

/**
 * Deletes stale artifacts from the cache directory: torn `.tmp` files of crashed writes, and
 * cache files no session has loaded or written for {@link CACHE_MAX_AGE_MS}. Loads count because
 * {@link touchBestEffort} refreshes the mtime of every successfully served file. Best-effort and
 * once per process.
 *
 * @returns once the sweep finished or failed silently.
 */
const pruneCacheDirectory = async (): Promise<void> => {
    if (pruned) return;
    pruned = true;
    try {
        const dir = dirname(cacheArtifactPath('', 'x'));
        const now = Date.now();
        for (const entry of await readdir(dir)) {
            const file = join(dir, entry);
            try {
                const age = now - (await stat(file)).mtimeMs;
                const isTemp = entry.includes('.tmp');
                if ((isTemp && age > TEMP_MAX_AGE_MS) || (!isTemp && age > CACHE_MAX_AGE_MS)) await unlink(file);
            } catch {
                /* raced or unreadable, leave it */
            }
        }
    } catch {
        /* no cache directory yet */
    }
};

/**
 * Refreshes a served cache file's mtime, so the prune above sees it as in use. A cache-served
 * start never rewrites the file, so without this an actively used cache would look abandoned.
 *
 * @param file the cache file that was just loaded successfully.
 * @returns once the touch finished or failed silently.
 */
const touchBestEffort = async (file: string): Promise<void> => {
    try {
        const now = new Date();
        await utimes(file, now, now);
    } catch {
        /* best-effort */
    }
};

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
    void pruneCacheDirectory();
    try {
        const file = cacheFileFor(dataRoot);
        const raw = await readFile(file, { encoding: 'utf-8' });
        const cache = JSON.parse(raw) as CacheFile;
        if (cache.formatVersion !== CACHE_FORMAT_VERSION) return undefined;
        if (cache.serverBuildId !== buildId) return undefined;
        if (cache.dataRoot !== dataRoot) return undefined;
        if (cache.manifestHash !== (await manifestHashOf(dataRoot))) return undefined;
        void touchBestEffort(file);
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

/** One workspace file's identity stamp: the path as walked, plus size and mtime. */
export type ProjectFileStamp = [path: string, size: number, mtimeMs: number];

/** The on-disk shape of one saved project cache file. */
interface ProjectCacheFile {
    formatVersion: number;
    serverBuildId: string;
    dataRoot: string;
    manifestHash: string;
    stamps: ProjectFileStamp[];
    states: Record<string, unknown>;
}

/** A loaded project cache: the per-index states and the saved workspace-file stamps. */
export interface LoadedProjectCache {
    readonly states: Record<string, unknown>;
    readonly stamps: ProjectFileStamp[];
}

/**
 * The project cache file path for a game Data root and workspace folder set. Keyed by both, so
 * switching mods (or multi-root layouts) keeps separate caches instead of thrashing one file.
 *
 * @param dataRoot the game `Data` root.
 * @param folderPaths the workspace folder fs paths.
 * @returns the absolute cache file path.
 */
const projectCacheFileFor = (dataRoot: string, folderPaths: string[]): string => {
    const folderKey = createHash('sha1')
        .update([...folderPaths].map((folder) => folder.replace(/\\/g, '/').toLowerCase()).sort().join('\n'))
        .digest('hex')
        .slice(0, 16);
    return cacheArtifactPath(dataRoot, `project-index-cache-${folderKey}`);
};

/**
 * Stats every `.rules` file under the given folders, concurrently.
 *
 * @param folderPaths the workspace folder fs paths to walk.
 * @returns one stamp per readable file, in walk order.
 */
export const statProjectFiles = async (folderPaths: string[]): Promise<ProjectFileStamp[]> => {
    const files: string[] = [];
    for (const folder of folderPaths) {
        for await (const file of collectRulesFiles(folder)) files.push(file);
    }
    const stamps: (ProjectFileStamp | undefined)[] = new Array(files.length);
    let next = 0;
    const worker = async (): Promise<void> => {
        while (next < files.length) {
            const index = next++;
            try {
                const info = await stat(files[index]);
                stamps[index] = [files[index], info.size, Math.round(info.mtimeMs)];
            } catch {
                stamps[index] = undefined;
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(STAT_CONCURRENCY, files.length || 1) }, worker));
    return stamps.filter((stamp): stamp is ProjectFileStamp => stamp !== undefined);
};

/**
 * Loads the cached combined project index states when every whole-cache validity key (format
 * version, server build, game-tree manifest) still matches. Per-workspace-file staleness is NOT
 * checked here: the caller diffs the returned stamps against the current files and re-ingests
 * the difference.
 *
 * @param dataRoot the game `Data` root being built.
 * @param folderPaths the workspace folder fs paths being built.
 * @returns the states and saved stamps, or undefined on any whole-cache mismatch.
 */
export const tryLoadProjectCache = async (
    dataRoot: string,
    folderPaths: string[]
): Promise<LoadedProjectCache | undefined> => {
    const buildId = serverBuildId();
    if (!buildId) return undefined;
    void pruneCacheDirectory();
    try {
        const file = projectCacheFileFor(dataRoot, folderPaths);
        const raw = await readFile(file, { encoding: 'utf-8' });
        const cache = JSON.parse(raw) as ProjectCacheFile;
        if (cache.formatVersion !== CACHE_FORMAT_VERSION) return undefined;
        if (cache.serverBuildId !== buildId) return undefined;
        if (cache.dataRoot !== dataRoot) return undefined;
        if (!Array.isArray(cache.stamps) || typeof cache.states !== 'object' || cache.states === null) return undefined;
        if (cache.manifestHash !== (await manifestHashOf(dataRoot))) return undefined;
        void touchBestEffort(file);
        return { states: cache.states, stamps: cache.stamps };
    } catch {
        return undefined;
    }
};

/**
 * Saves the combined project index states with the given workspace-file stamps. Best-effort,
 * like {@link saveIndexCache}.
 *
 * @param dataRoot the game `Data` root the states were built from.
 * @param folderPaths the workspace folder fs paths the states cover.
 * @param stamps the identity stamps of the covered workspace files.
 * @param states the per-index states keyed by cache id.
 * @returns once the write finished or failed silently.
 */
export const saveProjectCache = async (
    dataRoot: string,
    folderPaths: string[],
    stamps: ProjectFileStamp[],
    states: Record<string, unknown>
): Promise<void> => {
    const buildId = serverBuildId();
    if (!buildId) return;
    try {
        const file = projectCacheFileFor(dataRoot, folderPaths);
        await mkdir(dirname(file), { recursive: true });
        const cache: ProjectCacheFile = {
            formatVersion: CACHE_FORMAT_VERSION,
            serverBuildId: buildId,
            dataRoot,
            manifestHash: await manifestHashOf(dataRoot),
            stamps,
            states,
        };
        const temp = `${file}.${process.pid}.tmp`;
        await writeFile(temp, JSON.stringify(cache), { encoding: 'utf-8' });
        await rename(temp, file);
    } catch {
        /* best-effort cache, never fail the build over it */
    }
};
