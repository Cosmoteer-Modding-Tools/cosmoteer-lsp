import { AbstractNodeDocument } from '../core/ast/ast';
import { parseFile } from '../utils/ast.utils';
import { FileWithPath } from './cosmoteer-workspace.service';

// Navigation, inheritance resolution, and completion lazily parse game-tree files and pin the AST
// on the file node (`content.parsedDocument`) so the next resolution of the same base is free.
// Before this cache the pins were never released, so a long session over a large tree accumulated
// every visited file's AST. This registry keeps the pinning but bounds it: least-recently-used
// documents are unpinned once the cap is exceeded and simply re-parse on their next use.

/** How many lazily parsed game-tree documents stay pinned at once. */
const MAX_PINNED_DOCUMENTS = 768;

/** Insertion-ordered registry of the files whose AST is currently pinned (oldest first). */
const pinned: Set<FileWithPath> = new Set();

/**
 * Whether a file is exempt from eviction. `cosmoteer.rules` is the root of every `&/…` super-path
 * resolution and some consumers require its pinned document to stay present.
 *
 * @param file the pinned file.
 * @returns true when the file must never be unpinned.
 */
const isEvictionExempt = (file: FileWithPath): boolean => file.path.toLowerCase().endsWith('cosmoteer.rules');

/**
 * Returns a game-tree file's parsed document, parsing and pinning it on first use. Re-pinning an
 * already parsed file refreshes its LRU position. When the pin count exceeds the cap, the least
 * recently used non-exempt documents are unpinned so they can be garbage collected.
 *
 * @param file the game-tree file node to read.
 * @returns the file's parsed document.
 */
export const getParsedFileDocument = async (file: FileWithPath): Promise<AbstractNodeDocument> => {
    const existing = file.content.parsedDocument;
    if (existing) {
        pinned.delete(file);
        pinned.add(file);
        return existing;
    }
    const document = await parseFile(file);
    file.content.parsedDocument = document;
    pinned.delete(file);
    pinned.add(file);
    for (const oldest of pinned) {
        if (pinned.size <= MAX_PINNED_DOCUMENTS) break;
        if (isEvictionExempt(oldest)) continue;
        pinned.delete(oldest);
        oldest.content.parsedDocument = undefined;
    }
    return document;
};
