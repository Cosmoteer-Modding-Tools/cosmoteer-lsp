/**
 * Watching the assemblies a code mod's schema was extracted from, so the merged schema follows the
 * mods on disk without the user running the rebuild command.
 *
 * The types a code mod adds are what stops its `Type = DroneLaunchController` from being reported as
 * an unknown discriminator. That only holds while the extraction matches the assemblies: a mod
 * installed, updated or rebuilt after startup leaves the merged schema behind, and the diagnostic
 * that comes back is a false positive on content the game accepts.
 *
 * The workspace folders are watched by the client (which already watches them recursively), but the
 * installed workshop tree is outside every workspace folder and no client watcher reaches it, so it
 * is watched here: the directory of each discovered assembly, for a mod being updated in place, and
 * the search roots themselves, for a mod being installed or removed (which arrives as a directory
 * event, not a file one).
 */
import { FSWatcher, watch } from 'fs';
import { dirname } from 'path';

/** How long to wait for a burst of file events to settle before rebuilding. */
const DEBOUNCE_MS = 1000;

/** A file whose change can alter the extraction: the assembly itself, or its XML doc file. */
const WATCHED_EXTENSION = /\.(dll|xml)$/i;

/**
 * The directories to watch for a set of discovered assemblies.
 *
 * @param assemblyPaths every assembly discovery found.
 * @param roots the search roots, watched so an installed or removed mod is noticed even though it
 *              contributes no assembly yet.
 * @returns the directories, deduplicated.
 */
export const watchDirectories = (assemblyPaths: readonly string[], roots: readonly string[]): string[] => [
    ...new Set([...roots, ...assemblyPaths.map((path) => dirname(path))]),
];

/**
 * Watch a set of directories for assembly or doc-file changes.
 *
 * Deliberately non-recursive: a recursive watch of the workshop tree would fire for every file of
 * every installed mod, and the two things that matter (an assembly rewritten in place, a mod folder
 * appearing or disappearing) both show up one level down from a directory we already watch.
 *
 * @param directories what to watch, from {@link watchDirectories}.
 * @param onChange called once per settled burst of relevant events.
 * @returns a disposer that closes every watcher.
 */
export const watchModAssemblies = (directories: readonly string[], onChange: () => void): (() => void) => {
    const watchers: FSWatcher[] = [];
    let timer: NodeJS.Timeout | undefined;
    let closed = false;

    const schedule = (): void => {
        if (closed) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = undefined;
            if (!closed) onChange();
        }, DEBOUNCE_MS);
        // A pending rebuild must never hold the process open on its own.
        timer.unref?.();
    };

    for (const directory of directories) {
        try {
            const watcher = watch(directory, { persistent: false }, (_event, filename) => {
                // A file event names the file, and only an assembly or its doc file matters. A
                // directory event (a mod installed or removed under a search root) names the folder,
                // which carries no extension, and has to re-run discovery to be seen at all.
                const name = typeof filename === 'string' ? filename : '';
                if (name && /\.[a-z0-9]+$/i.test(name) && !WATCHED_EXTENSION.test(name)) return;
                schedule();
            });
            // A watched directory can be deleted (a mod uninstalled) while we hold the handle; that
            // surfaces as an error event, which would be fatal unhandled.
            watcher.on('error', () => undefined);
            watchers.push(watcher);
        } catch {
            // An unreadable or already-gone directory simply is not watched.
        }
    }

    return () => {
        closed = true;
        if (timer) clearTimeout(timer);
        for (const watcher of watchers) {
            try {
                watcher.close();
            } catch {
                /* already closed */
            }
        }
    };
};
