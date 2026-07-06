import { Dirent } from 'fs';
import { readdir, readFile, stat } from 'fs/promises';
import * as path from 'path';
import { CancellationToken } from 'vscode-languageserver';
import { AbstractNodeDocument } from '../core/ast/ast';
import { lexer } from '../core/lexer/lexer';
import { parser } from '../core/parser/parser';
import { ParserResultRegistrar } from '../registrar/parser-result-registrar';
import { CancellationError } from '../utils/cancellation';
import { perfCount } from '../utils/perf-counters';

// Reference resolution and reference completion walk `<…>` file paths segment by segment. Before
// this cache, every resolved reference paid one `readdir` per path segment and re-read + re-parsed
// its target file, per reference, per validation pass, per keystroke. The two caches here reduce
// that to one cheap `stat` per directory/file: listings are served while the directory's mtime is
// unchanged, parsed documents while the file's size and mtime are unchanged. Open editor buffers
// always win over disk through the parser-result registrar, so navigation sees unsaved edits.

/** Upper bound of cached directory listings. */
const READDIR_CAP = 1_024;
/** Upper bound of cached parsed documents (LRU), bounding memory on huge mod/game trees. The
 *  whole-workspace scan's cross-file working set exceeds this on real mods, but raising it to
 *  1024 bought only ~0.6s of a 15s scan for ~130MB of peak heap, so the lower bound wins. */
const PARSE_CAP = 512;

type ReaddirEntry = { mtimeMs: number; entries: Dirent[]; seenGen?: number };
type ParseEntry = { size: number; mtimeMs: number; document: AbstractNodeDocument; seenGen?: number };

// During a whole-workspace scan, re-validating an unchanged cache entry with a stat per hit is the
// dominant remaining syscall cost (one stat per path segment per reference). A scan opens a trust
// window: an entry stat-validated (or created) once inside the window is served without further
// stats until the window closes. Correctness holds because the client file watcher runs during the
// window and a watched change deletes the entry outright ({@link invalidateFsPath}).
let trustDepth = 0;
let trustGen = 0;

/** Opens a trust window (reentrant). Entries validated once inside it skip further stat checks. */
export const beginFsTrustWindow = (): void => {
    if (++trustDepth === 1) trustGen++;
};

/** Closes a trust window opened by {@link beginFsTrustWindow}. */
export const endFsTrustWindow = (): void => {
    trustDepth = Math.max(0, trustDepth - 1);
};

const readdirCache: Map<string, ReaddirEntry> = new Map();
const parseCache: Map<string, ParseEntry> = new Map();

/** Callbacks to run whenever the fs caches are invalidated, so dependent caches (the navigation
 *  memo) stay consistent with what resolution would now read from disk. */
const invalidationListeners: Array<() => void> = [];

/**
 * Registers a callback invoked on every {@link invalidateFsPath} and {@link clearFsCaches}, so a
 * cache derived from resolution results can drop itself when the underlying files may have changed.
 *
 * @param listener the callback to run on each invalidation.
 */
export const onFsInvalidation = (listener: () => void): void => {
    invalidationListeners.push(listener);
};

/** Whether the platform's default filesystem resolves paths case-insensitively. On Linux two
 *  paths differing only in case are distinct files, so folding keys there would let one file's
 *  cache entry answer for the other. */
const CASE_INSENSITIVE_PATHS = process.platform === 'win32' || process.platform === 'darwin';

/**
 * Case-folds a path-derived cache key only where the filesystem is case-insensitive, so derived
 * caches (the navigation and asset memos) share the same collision-safety as the fs caches here.
 *
 * @param pathKey the path or path-derived string to fold.
 * @returns the folded key on Windows/macOS, the unchanged string elsewhere.
 */
export const foldPathCase = (pathKey: string): string =>
    CASE_INSENSITIVE_PATHS ? pathKey.toLowerCase() : pathKey;

// The same paths are canonicalized on every cache lookup (one per stat-validated hit), and
// path.resolve plus two string passes per call showed up in scan profiles. Bounded by wholesale
// reset, mirroring the derived-string memos elsewhere.
const keyMemo = new Map<string, string>();
const KEY_MEMO_CAP = 16384;

/**
 * Canonical cache key for an OS path (case-folded only where the filesystem is case-insensitive).
 *
 * @param fsPath the path to canonicalize.
 * @returns the resolved, forward-slashed key.
 */
const keyOf = (fsPath: string): string => {
    const cached = keyMemo.get(fsPath);
    if (cached !== undefined) return cached;
    const key = foldPathCase(path.resolve(fsPath).replace(/\\/g, '/'));
    if (keyMemo.size >= KEY_MEMO_CAP) keyMemo.clear();
    keyMemo.set(fsPath, key);
    return key;
};

/**
 * Deletes the oldest entries of a cache until it is back under its cap.
 *
 * @param cache the insertion-ordered cache map to shrink.
 * @param cap the maximum entry count to keep.
 */
const enforceCap = (cache: Map<string, unknown>, cap: number): void => {
    while (cache.size > cap) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) return;
        cache.delete(oldest);
    }
};

/**
 * `readdir(dirPath, { withFileTypes: true })` with an mtime-validated cache. Every hit stats the
 * directory and serves the cached listing only while the directory's mtime is unchanged. A file
 * created, deleted, or renamed in the directory updates that mtime, so the cache can never hide a
 * new file, while an unchanged directory answers with one `stat` instead of a full listing.
 *
 * @param dirPath the directory to list.
 * @returns the directory's entries.
 */
export const cachedReaddir = async (dirPath: string): Promise<Dirent[]> => {
    const key = keyOf(dirPath);
    const trusted = trustDepth > 0 ? readdirCache.get(key) : undefined;
    if (trusted && trusted.seenGen === trustGen) {
        perfCount('fs.readdirHit');
        return trusted.entries;
    }
    perfCount('fs.stat');
    const stats = await stat(dirPath);
    const cached = readdirCache.get(key);
    if (cached && cached.mtimeMs === stats.mtimeMs) {
        perfCount('fs.readdirHit');
        if (trustDepth > 0) cached.seenGen = trustGen;
        return cached.entries;
    }
    perfCount('fs.readdir');
    const entries = await readdir(dirPath, { withFileTypes: true });
    readdirCache.set(key, { mtimeMs: stats.mtimeMs, entries, seenGen: trustDepth > 0 ? trustGen : undefined });
    enforceCap(readdirCache, READDIR_CAP);
    return entries;
};

// Case-insensitive name lookup per directory listing, memoized on the listing array's identity so
// invalidation is inherited from the readdir cache: a refreshed listing is a new array, and the
// map for the old one becomes unreachable with it.
const dirLookupMemo = new WeakMap<Dirent[], Map<string, string>>();

/**
 * The case-insensitive membership map of a directory: lowercased entry name → real entry name
 * (first occurrence wins, matching a linear scan of the listing). Backed by {@link cachedReaddir},
 * so probing many candidate names in one directory costs one listing instead of a stat each.
 *
 * @param dirPath the directory to index.
 * @returns the lookup map for the directory's current listing.
 */
export const cachedDirLookup = async (dirPath: string): Promise<Map<string, string>> => {
    const entries = await cachedReaddir(dirPath);
    let lookup = dirLookupMemo.get(entries);
    if (!lookup) {
        lookup = new Map();
        for (const entry of entries) {
            const lower = entry.name.toLowerCase();
            if (!lookup.has(lower)) lookup.set(lower, entry.name);
        }
        dirLookupMemo.set(entries, lookup);
    }
    return lookup;
};

/**
 * Reads and parses a `.rules` file with caching. The live editor buffer (parser-result registrar)
 * wins over disk, so navigation into a file with unsaved edits resolves against what the user
 * sees. Disk results are validated by size+mtime, so an external change re-reads while repeated
 * resolutions of the same target (the common case: many references into one base file) parse once.
 *
 * @param fsPath the on-disk path of the file.
 * @param cancellationToken cancels between the IO steps.
 * @returns the parsed document.
 */
export const cachedParseFilePath = async (
    fsPath: string,
    cancellationToken?: CancellationToken
): Promise<AbstractNodeDocument> => {
    const open = ParserResultRegistrar.instance.getResultByPath(fsPath);
    if (open) return open;
    const key = keyOf(fsPath);
    const trusted = trustDepth > 0 ? parseCache.get(key) : undefined;
    if (trusted && trusted.seenGen === trustGen) {
        perfCount('fs.parseHit');
        // Refresh LRU position.
        parseCache.delete(key);
        parseCache.set(key, trusted);
        return trusted.document;
    }
    perfCount('fs.stat');
    const stats = await stat(fsPath);
    if (cancellationToken?.isCancellationRequested) throw new CancellationError();
    const cached = parseCache.get(key);
    if (cached && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs) {
        perfCount('fs.parseHit');
        if (trustDepth > 0) cached.seenGen = trustGen;
        // Refresh LRU position.
        parseCache.delete(key);
        parseCache.set(key, cached);
        return cached.document;
    }
    perfCount('fs.parse');
    const text = await readFile(fsPath, { encoding: 'utf-8' });
    if (cancellationToken?.isCancellationRequested) throw new CancellationError();
    const document = parser(lexer(text), fsPath).value;
    parseCache.set(key, {
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        document,
        seenGen: trustDepth > 0 ? trustGen : undefined,
    });
    enforceCap(parseCache, PARSE_CAP);
    return document;
};

/**
 * Seeds the parse cache with a document the caller just parsed anyway, so cross-file resolutions
 * into the same file reuse it instead of re-reading and re-parsing from disk. The whole-workspace
 * scan primes every file it validates this way, which is what makes references between mod files
 * cache hits within the same pass.
 *
 * @param fsPath the on-disk path of the parsed file.
 * @param document the parsed document to cache.
 */
export const primeParsedFile = async (fsPath: string, document: AbstractNodeDocument): Promise<void> => {
    try {
        const stats = await stat(fsPath);
        parseCache.set(keyOf(fsPath), {
            size: stats.size,
            mtimeMs: stats.mtimeMs,
            document,
            seenGen: trustDepth > 0 ? trustGen : undefined,
        });
        enforceCap(parseCache, PARSE_CAP);
    } catch {
        // A vanished file simply stays uncached.
    }
};

/**
 * Drops the cache entries a changed/created/deleted file invalidates: its own parsed document and
 * its parent directory's listing (a create/delete changes what the parent lists).
 *
 * @param fsPath the on-disk path of the changed file.
 */
export const invalidateFsPath = (fsPath: string): void => {
    parseCache.delete(keyOf(fsPath));
    readdirCache.delete(keyOf(path.dirname(fsPath)));
    for (const listener of invalidationListeners) listener();
};

/** Empties both caches. For workspace-root changes and tests. */
export const clearFsCaches = (): void => {
    readdirCache.clear();
    parseCache.clear();
    for (const listener of invalidationListeners) listener();
};
