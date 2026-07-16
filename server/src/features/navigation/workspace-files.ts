import { readFile } from 'fs/promises';
import { join, sep } from 'path';
import { cachedReaddir } from '../../workspace/fs-cache';
import { CancellationToken } from 'vscode-languageserver';
import { AbstractNodeDocument } from '../../core/ast/ast';
import { parseText } from '../../utils/ast.utils';
import { CancellationError } from '../../utils/cancellation';
import { ParserResultRegistrar } from '../../registrar/parser-result-registrar';
import { isRulesFileName } from '../../document/document-kind';
import { globalSettings } from '../../settings';
import { MentionIndex } from './mention.index';
import { normalizeUri } from './reference-location';
import { CosmoteerWorkspaceService } from '../../workspace/cosmoteer-workspace.service';

/**
 * The workspace's mod folders: every project folder except the game `Data` root. The mod-action
 * indexes are scoped to these, since the game tree carries no mod actions and walking it would only
 * cost time. Shared so the indexes and the startup chain that walks them together agree on the set.
 *
 * @param folderPaths the project folders (the mod plus the game `Data` tree).
 * @returns the subset that is not the game `Data` root.
 */
export const modFolderPaths = (folderPaths: string[]): string[] => {
    const dataRoot = CosmoteerWorkspaceService.instance.dataRootPath;
    const dataKey = dataRoot ? normalizeUri(dataRoot) : undefined;
    return folderPaths.filter((folder) => normalizeUri(uriToFsPath(folder)) !== dataKey);
};

/**
 * Convert a workspace-folder `file://` URI to an on-disk path (Windows-aware).
 *
 * @param uri the workspace-folder URI.
 * @returns the on-disk path, or `uri` unchanged when it is not a `file://` URI.
 */
export const uriToFsPath = (uri: string): string => {
    if (!uri.startsWith('file://')) return uri;
    let path = uri.slice('file://'.length);
    try {
        path = decodeURIComponent(path);
    } catch {
        /* leave as-is on malformed escapes */
    }
    // `file:///C:/x` decodes to `/C:/x`, so strip the slash before a drive letter.
    if (/^\/[a-zA-Z]:\//.test(path)) path = path.slice(1);
    return path.replace(/\//g, sep);
};

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
export async function* collectRulesFiles(dir: string): AsyncGenerator<string> {
    const entries = await cachedReaddir(dir).catch(() => []);
    for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) yield* collectRulesFiles(full);
        else if (entry.isFile() && isRulesFileName(entry.name)) yield full;
    }
}


/** How many file reads are kept in flight ahead of the consumer during a project walk. */
const READ_AHEAD = 16;

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

/**
 * Every `.rules` document in the open project: each file under the workspace folders
 * (live editor buffer preferred over disk), plus any open buffer that lives outside
 * them (or a no-folder session). De-duplicated by canonical uri, so a file open in the
 * editor is yielded once regardless of folder/buffer spelling. On-disk files are read
 * through the {@link readFilesAhead} pipeline so disk latency overlaps parsing. With
 * `options.diskOnly` the walk reads purely from disk, with no open-buffer preference and
 * no out-of-folder buffers, which the persistent index cache needs so the state it saves
 * reflects only the files on disk. `options.onDiskText` observes every disk-read file's raw
 * text (parseable or not, open buffers excluded), so a consumer of raw text (the mention
 * index) rides along instead of re-reading the same files.
 *
 * @param folderPaths the workspace folders to walk.
 * @param cancellationToken cancels the walk.
 * @param options `diskOnly` to ignore open buffers, `onDiskText` to observe each disk-read
 * file's raw text.
 * @returns every parsed `.rules` document in the project, de-duplicated by canonical uri.
 */
export async function* projectDocuments(
    folderPaths: string[],
    cancellationToken: CancellationToken,
    options?: { diskOnly?: boolean; onDiskText?: (file: string, text: string) => void }
): AsyncGenerator<AbstractNodeDocument> {
    const seen = new Set<string>();
    const toRead: string[] = [];
    for (const folder of folderPaths) {
        for await (const file of collectRulesFiles(uriToFsPath(folder))) {
            if (cancellationToken.isCancellationRequested) throw new CancellationError();
            const norm = normalizeUri(file);
            if (seen.has(norm)) continue;
            seen.add(norm);
            const open = options?.diskOnly ? undefined : ParserResultRegistrar.instance.getResultByPath(file);
            if (open) yield open;
            else toRead.push(file);
        }
    }
    // A single unparseable file must not abort the whole project walk. Otherwise one bad file
    // silently kills find-all-references / rename / workspace symbols for the entire project. Skip
    // it (the parser still throws on some constructs, e.g. inferValueType), but let cancellation
    // through. Parsing stays on the main thread deliberately: a worker-thread pool was measured
    // slower here, because structured-cloning the parsed AST back costs more than the parse itself.
    for await (const { file, text } of readFilesAhead(toRead)) {
        if (cancellationToken.isCancellationRequested) throw new CancellationError();
        if (text === undefined) continue;
        options?.onDiskText?.(file, text);
        try {
            yield parseText(text, file);
        } catch (e) {
            if (e instanceof CancellationError) throw e;
            if (globalSettings.trace.server === 'messages') console.error(`Skipping unparseable ${file}:`, e);
        }
    }
    if (options?.diskOnly) return;
    for (const document of ParserResultRegistrar.instance.allResults()) {
        const norm = normalizeUri(document.uri);
        if (seen.has(norm)) continue;
        seen.add(norm);
        yield document;
    }
}

/**
 * Like {@link projectDocuments}, but only yields documents whose raw text mentions `name`,
 * a cheap substring pre-filter that lets find-all-references / rename scale to the whole
 * Cosmoteer `Data` tree: the vast majority of files don't mention a given symbol, so they're
 * never parsed or resolved. The per-reference check that follows is the real filter. This
 * just skips the irrelevant bulk. Candidate files come from the {@link MentionIndex} word index
 * when the name is a pure word (no directory re-walk, no whole-tree read), and from a full walk
 * otherwise. Every candidate is still re-read and substring-checked before parsing, so the index
 * only pre-filters and can never change which documents are found. Open editor buffers are always
 * yielded unfiltered (unsaved edits, few of them, and the per-reference check filters).
 *
 * @param folderPaths the workspace folders to search.
 * @param name the symbol name the raw text must mention.
 * @param cancellationToken cancels the search.
 * @returns every open buffer, plus each parsed document whose text contains `name`.
 */
export async function* documentsMentioning(
    folderPaths: string[],
    name: string,
    cancellationToken: CancellationToken
): AsyncGenerator<AbstractNodeDocument> {
    const seen = new Set<string>();
    for (const document of ParserResultRegistrar.instance.allResults()) {
        const norm = normalizeUri(document.uri);
        if (seen.has(norm)) continue;
        seen.add(norm);
        yield document;
    }
    const candidates = await MentionIndex.instance
        .candidateFiles(name, folderPaths, cancellationToken)
        .catch(() => undefined);
    let toRead: string[];
    if (candidates) {
        toRead = candidates.filter((file) => !seen.has(normalizeUri(file)));
    } else {
        // Not a pure-word name (or the index failed): fall back to walking every folder file.
        toRead = [];
        for (const folder of folderPaths) {
            for await (const file of collectRulesFiles(uriToFsPath(folder))) {
                if (cancellationToken.isCancellationRequested) throw new CancellationError();
                const norm = normalizeUri(file);
                if (seen.has(norm)) continue;
                seen.add(norm);
                toRead.push(file);
            }
        }
    }
    for await (const { file, text } of readFilesAhead(toRead)) {
        if (cancellationToken.isCancellationRequested) throw new CancellationError();
        if (text === undefined || !text.includes(name)) continue;
        // One bad file must not abort the whole search (the parser still throws on some
        // constructs). Skip it.
        try {
            yield parseText(text, file);
        } catch {
            /* unparseable, skip */
        }
    }
}
