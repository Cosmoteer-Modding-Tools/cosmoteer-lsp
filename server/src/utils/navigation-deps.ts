import { AsyncLocalStorage } from 'node:async_hooks';

// The navigation memo (full.navigation-strategy.ts) caches absolute-reference resolutions. An
// open-buffer edit used to wipe the whole memo on every keystroke, because there was no record of
// which entries the edited file could actually affect. This module provides that record: while a
// memoized resolution runs, every file whose parsed content it reads is collected into a
// per-resolution set, carried through awaits by an AsyncLocalStorage so concurrent resolutions
// cannot contaminate each other. The read points (the fs parse cache, the parser-result registrar
// path lookup, the pinned game-tree documents) call {@link recordNavigationDep}, and the memo
// stores the collected set with each entry so an edit invalidates just the entries that read the
// edited file.

const storage = new AsyncLocalStorage<Set<string>>();

/**
 * The canonical dependency key of a file, matching for `file://` URIs and OS paths of the same
 * file regardless of encoding, slash direction, or case.
 *
 * @param uriOrPath the file's uri or OS path.
 * @returns the canonical key.
 */
export const navigationDepKey = (uriOrPath: string): string => {
    let path = uriOrPath.startsWith('file://') ? uriOrPath.slice('file://'.length) : uriOrPath;
    try {
        path = decodeURIComponent(path);
    } catch {
        /* leave as-is on malformed escapes */
    }
    return path.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
};

/**
 * Records that the currently running resolution read the given file. A no-op when no resolution
 * is collecting, which keeps the call safe (and cheap) on hot paths.
 *
 * @param uriOrPath the read file's uri or OS path.
 */
export const recordNavigationDep = (uriOrPath: string): void => {
    const store = storage.getStore();
    if (store) store.add(navigationDepKey(uriOrPath));
};

/**
 * Runs a resolution with `deps` as its dependency collector. Reads recorded by nested async work
 * land in this set until the returned promise settles.
 *
 * @param deps the set the resolution's file reads are collected into.
 * @param run the resolution to execute.
 * @returns the resolution's result.
 */
export const collectNavigationDeps = <T>(deps: Set<string>, run: () => Promise<T>): Promise<T> => storage.run(deps, run);

/**
 * The dependency collector of the resolution currently running, when one is collecting. Used to
 * propagate a memo hit's recorded reads into the enclosing resolution.
 *
 * @returns the active collector set, or undefined outside any collecting resolution.
 */
export const activeNavigationDeps = (): Set<string> | undefined => storage.getStore();
