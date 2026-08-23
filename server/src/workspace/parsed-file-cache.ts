import { Stats } from 'fs';
import { stat } from 'fs/promises';
import { AbstractNodeDocument } from '../core/ast/ast';
import { ParserResultRegistrar } from '../registrar/parser-result-registrar';
import { parseFile } from '../utils/ast.utils';
import { recordNavigationDep } from '../utils/navigation-deps';
import { perfCount } from '../utils/perf-counters';
import { FileWithPath } from './cosmoteer-workspace.service';
import { currentFsTrustGeneration, invalidateFsPath, onFsInvalidation } from './fs-cache';

// Navigation, inheritance resolution, and completion lazily parse game-tree files and pin the AST
// on the file node (`content.parsedDocument`) so the next resolution of the same base is free.
// Before this cache the pins were never released, so a long session over a large tree accumulated
// every visited file's AST. This registry keeps the pinning but bounds it: least-recently-used
// documents are unpinned once the cap is exceeded and simply re-parse on their next use.
//
// A pin is also checked for freshness, the way `cachedParseFilePath` checks the parse cache in
// fs-cache.ts: the size and mtime the file had when it was parsed are kept beside the pin and
// re-stated on use. Without that check a syntax tree read once was served for the rest of the
// session, so a Cosmoteer update installed while the editor is open, a workshop mod updated by
// Steam, or a vanilla file saved under `allowEditingVanillaFiles` kept resolving against the
// pre-change tree until the server was restarted. The stat is skipped inside a trust window,
// because resolution asks for the same handful of base files once per reference and a whole
// workspace scan would otherwise pay a syscall for every one of them.

/** How many lazily parsed game-tree documents stay pinned at once. */
const MAX_PINNED_DOCUMENTS = 768;

/** Insertion-ordered registry of the files whose AST is currently pinned (oldest first). */
const pinned: Set<FileWithPath> = new Set();

/** What a pinned document was parsed from, and when that was last confirmed against disk. */
type PinStamp = {
    size: number;
    mtimeMs: number;
    seenGen?: number;
    seenEpoch: number;
};

/** Identity of the file behind each pinned document, released with the file node it belongs to. */
const stamps: WeakMap<FileWithPath, PinStamp> = new WeakMap();

// A file the client watcher reports as changed is dropped from the fs caches outright, which the
// pin cannot do by path because it is keyed by file node. Counting invalidations instead is enough:
// a stamp confirmed before the change no longer matches the current count, so the next use stats
// again even inside a trust window.
let invalidationCount = 0;
onFsInvalidation(() => {
    invalidationCount++;
});

/**
 * Whether a file is exempt from eviction. `cosmoteer.rules` is the root of every `&/…` super-path
 * resolution and some consumers require its pinned document to stay present.
 *
 * @param file the pinned file.
 * @returns true when the file must never be unpinned.
 */
const isEvictionExempt = (file: FileWithPath): boolean => file.path.toLowerCase().endsWith('cosmoteer.rules');

/**
 * Moves a file to the most recently used end of the pin registry.
 *
 * @param file the file whose pinned document was just served.
 */
const touch = (file: FileWithPath): void => {
    pinned.delete(file);
    pinned.add(file);
};

/**
 * Stats a file without throwing, so a file that is momentarily gone or unreadable leaves the pin in
 * place instead of turning every resolution into that file into an error.
 *
 * @param fsPath the on-disk path to stat.
 * @returns the file's stats, or undefined when it cannot be read.
 */
const statOrUndefined = async (fsPath: string): Promise<Stats | undefined> => {
    perfCount('fs.stat');
    perfCount('fs.statPin');
    try {
        return await stat(fsPath);
    } catch {
        return undefined;
    }
};

/**
 * Returns a game-tree file's parsed document, parsing and pinning it on first use. A pinned
 * document is served again only while the file on disk still has the size and mtime it was parsed
 * from, so a file that changed mid-session is read again. Re-pinning refreshes the LRU position,
 * and when the pin count exceeds the cap the least recently used non-exempt documents are unpinned
 * so they can be garbage collected.
 *
 * @param file the game-tree file node to read.
 * @returns the file's parsed document.
 */
export const getParsedFileDocument = async (file: FileWithPath): Promise<AbstractNodeDocument> => {
    // A running navigation memoizes its result against the files it read, this read included.
    recordNavigationDep(file.path);
    // The live editor buffer wins over disk here, as it already does in `cachedParseFilePath`, so
    // navigating into a vanilla file the user is editing under `allowEditingVanillaFiles` sees the
    // unsaved text. That buffer document is deliberately not pinned, because it has no on-disk
    // identity to check it against and the next keystroke would leave the pin holding text that is
    // neither what the editor shows nor what the file says.
    const open = ParserResultRegistrar.instance.getResultByPath(file.path);
    if (open) return open;
    const existing = file.content.parsedDocument;
    const stamp = stamps.get(file);
    const trustGeneration = currentFsTrustGeneration();
    if (
        existing &&
        stamp &&
        trustGeneration !== undefined &&
        stamp.seenGen === trustGeneration &&
        stamp.seenEpoch === invalidationCount
    ) {
        perfCount('pin.hit');
        touch(file);
        return existing;
    }
    // The stat comes before the read, so a change landing between the two is stamped with the older
    // mtime and caught by the next check instead of being pinned as current. A pin that carries no
    // stamp at all was put there by someone else (the workspace service parses `cosmoteer.rules`
    // when it hands it out) and is parsed once more here, because there is nothing to tell how old
    // it is.
    const stats = await statOrUndefined(file.path);
    if (existing && (!stats || (stamp && stamp.size === stats.size && stamp.mtimeMs === stats.mtimeMs))) {
        perfCount('pin.hit');
        if (stats && stamp) {
            stamp.seenGen = trustGeneration;
            stamp.seenEpoch = invalidationCount;
        }
        touch(file);
        return existing;
    }
    perfCount('pin.parse');
    const document = await parseFile(file);
    file.content.parsedDocument = document;
    // A pin that really went stale means the file changed with no watcher event behind it, which is
    // what a game update installed mid session looks like. Everything derived from the old tree is
    // now wrong too, and those caches are keyed by path rather than by file node, so they are told
    // the same way a watched change tells them. Announced after the re-parse, so the stamp below
    // carries the invalidation count this announcement produced rather than the one before it.
    if (existing && stats) invalidateFsPath(file.path);
    if (stats)
        stamps.set(file, {
            size: stats.size,
            mtimeMs: stats.mtimeMs,
            seenGen: trustGeneration,
            seenEpoch: invalidationCount,
        });
    else stamps.delete(file);
    touch(file);
    for (const oldest of pinned) {
        if (pinned.size <= MAX_PINNED_DOCUMENTS) break;
        if (isEvictionExempt(oldest)) continue;
        pinned.delete(oldest);
        oldest.content.parsedDocument = undefined;
        stamps.delete(oldest);
    }
    return document;
};
