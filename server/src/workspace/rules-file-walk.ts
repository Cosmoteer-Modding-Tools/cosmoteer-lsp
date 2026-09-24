import { Dirent } from 'fs';
import { readFile } from 'fs/promises';
import { resolve, sep } from 'path';
import { isRulesFileName, isShaderDocument } from '../document/document-kind';
import { cachedReaddir } from './fs-cache';

// Walking the project tree for its rules files is a filesystem concern, not a navigation one: the
// index cache, the whole-workspace scan, the migration command and the mention index all need the
// same walk, and each of them sits below or beside the navigation feature that used to own it.

/** How many file reads are kept in flight ahead of the consumer during a project walk. */
const READ_AHEAD = 16;

/**
 * Yield every rules file path under `dir`, recursively. Unreadable dirs are skipped. Listings come
 * from the shared readdir cache. The watcher invalidates a directory whose contents change, so
 * repeated walks (every scan pass, plus the index builds between them) stop re-listing disk. `.txt`
 * files count too: the game's loader ignores the extension and mods declare whole parts in them. A
 * non-rules `.txt` (a readme) parses to noise that contributes nothing to any index.
 *
 * @param dir the directory to walk.
 * @returns each rules file path under `dir`.
 */
export const collectRulesFiles = (dir: string): AsyncGenerator<string> => walkFiles(dir, isRulesFileName);

/**
 * Yield every file the diagnostics pass validates under `dir`: the rules files plus the `.shader`
 * files, which carry their own HLSL checks. Only the pass walks this set. Every other walk (the
 * mention index, the index cache, the migration command, the `.txt` reference scan) indexes Object
 * Text and would push HLSL through the OT lexer if it saw a shader.
 *
 * @param dir the directory to walk.
 * @returns each rules or shader file path under `dir`.
 */
export const collectScannedFiles = (dir: string): AsyncGenerator<string> =>
    walkFiles(dir, (name) => isRulesFileName(name) || isShaderDocument(name));

/**
 * The walk both collectors share: every file under `dir` whose name `accept` claims.
 *
 * @param dir the directory to walk.
 * @param accept decides by bare filename whether a file is yielded.
 * @returns each accepted file path under `dir`.
 */
async function* walkFiles(dir: string, accept: (basename: string) => boolean): AsyncGenerator<string> {
    // One generator frame walking an explicit stack, rather than a generator per directory
    // delegating to the next: a project walk descends thousands of directories, and the delegation
    // chain costs a promise hop per level per file. The root is resolved once so the children can
    // be built by concatenation, which is what `join` would return for an already-normal path.
    const root = resolve(dir);
    const frames: Array<{ dir: string; entries: Dirent[]; index: number }> = [
        { dir: root, entries: await cachedReaddir(root).catch(() => []), index: 0 },
    ];
    while (frames.length > 0) {
        const frame = frames[frames.length - 1];
        if (frame.index >= frame.entries.length) {
            frames.pop();
            continue;
        }
        const entry = frame.entries[frame.index++];
        const full = frame.dir.endsWith(sep) ? frame.dir + entry.name : frame.dir + sep + entry.name;
        if (entry.isDirectory()) {
            frames.push({ dir: full, entries: await cachedReaddir(full).catch(() => []), index: 0 });
        } else if (entry.isFile() && accept(entry.name)) {
            yield full;
        }
    }
}

/**
 * Reads many files with a bounded number of reads in flight, yielding each file's text in input
 * order. Overlapping the disk reads with the consumer's parse work is what makes a whole-project
 * walk fast, since neither the disk nor the CPU sits idle waiting on the other.
 *
 * @param files the file paths to read.
 * @returns each file with its text, in the order of `files`, with `undefined` text when unreadable.
 */
export async function* readFilesAhead(files: string[]): AsyncGenerator<{ file: string; text: string | undefined }> {
    const inFlight: Promise<{ file: string; text: string | undefined }>[] = [];
    let next = 0;
    const start = (): void => {
        if (next >= files.length) return;
        const file = files[next++];
        inFlight.push(
            readFile(file, { encoding: 'utf-8' }).then(
                (text) => ({ file, text }),
                () => ({ file, text: undefined as string | undefined })
            )
        );
    };
    while (inFlight.length < READ_AHEAD && next < files.length) start();
    while (inFlight.length > 0) {
        const result = await inFlight.shift()!;
        start();
        yield result;
    }
}
