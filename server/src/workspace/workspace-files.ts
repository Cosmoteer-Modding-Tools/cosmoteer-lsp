import { onFsInvalidation } from './fs-cache';
import { collectRulesFiles, readFilesAhead } from './rules-file-walk';
import { CancellationToken } from 'vscode-languageserver';
import { AbstractNodeDocument } from '../core/ast/ast';
import { parseText } from '../utils/ast.utils';
import { CancellationError } from '../utils/cancellation';
import { uriToFsPath } from '../utils/uri-path';
import { ParserResultRegistrar } from '../document/parser-result-registrar';
import { globalSettings } from '../settings';
import { MentionIndex } from './mention.index';
import { noteDocumentSource, normalizeUri } from '../document/reference-location';
import { CosmoteerWorkspaceService } from './cosmoteer-workspace.service';

/** How many candidate parses are kept. Bounded by count, since each holds a tree. */
const MENTION_PARSE_CAP = 512;

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

export { uriToFsPath };

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
 * file's raw text, `acceptText` to rule a disk file out from its text before it is parsed, and
 * `skipFile` to rule one out before it is even read.
 * @returns every parsed `.rules` document in the project, de-duplicated by canonical uri.
 */
export async function* projectDocuments(
    folderPaths: string[],
    cancellationToken: CancellationToken,
    options?: {
        diskOnly?: boolean;
        onDiskText?: (file: string, text: string) => void;
        acceptText?: (file: string, text: string) => boolean;
        skipFile?: (file: string) => boolean;
    }
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
            // A disk file the consumer already knows it would reject is not even read. Only disk
            // files: an open buffer is yielded above whatever the consumer remembers about it.
            else if (!options?.skipFile?.(file)) toRead.push(file);
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
        // A consumer that can rule a file out from its raw text alone never pays for its parse. Only
        // disk files are gated: the open buffers below are few and their consumer's own check reads
        // them anyway.
        if (options?.acceptText && !options.acceptText(file, text)) continue;
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
 * Whether a registered buffer must not stand in for its file in the walks below.
 *
 * The game `Data` tree is content the game ships and loads from disk, and several checks read it
 * to decide what the game itself carries: an id the base game references without declaring, a
 * field name vanilla writes. An editor buffer over a vanilla file is not what the game reads, so
 * letting it stand in let one unsaved vanilla file answer those questions for the whole install,
 * and the answers are memoized per session, so the silence outlived closing the buffer.
 *
 * A session that turned `allowEditingVanillaFiles` on keeps its buffers, since there the unsaved
 * edit is the thing being worked on.
 *
 * @param uri the registered document's uri.
 * @returns true when the file behind it should be read from disk instead.
 */
const isGameTreeBuffer = (uri: string): boolean => {
    if (globalSettings.allowEditingVanillaFiles) return false;
    const dataRoot = CosmoteerWorkspaceService.instance.dataRootPath;
    if (!dataRoot) return false;
    return normalizeUri(uri).startsWith(`${normalizeUri(dataRoot).replace(/\/+$/, '')}/`);
};

/**
 * Like {@link projectDocuments}, but only yields documents whose raw text mentions `name`,
 * a cheap substring pre-filter that lets find-all-references / rename scale to the whole
 * Cosmoteer `Data` tree: the vast majority of files don't mention a given symbol, so they're
 * never parsed or resolved. The per-reference check that follows is the real filter. This
 * just skips the irrelevant bulk. Candidate files come from the {@link MentionIndex} word index
 * when the name is a pure word (no directory re-walk, no whole-tree read), and from a full walk
 * otherwise. Every candidate is still re-read and substring-checked before parsing, so the index
 * only pre-filters and can never change which documents are found. Open editor buffers are always
 * yielded unfiltered (unsaved edits, few of them, and the per-reference check filters). The one
 * exception is a buffer over a game `Data` file, whose file is read from disk instead, for the
 * reason {@link isGameTreeBuffer} gives.
 *
 * @param folderPaths the workspace folders to search.
 * @param name the symbol name the raw text must mention.
 * @param cancellationToken cancels the search.
 * @returns every open buffer, plus each parsed document whose text contains `name`.
 */
export function documentsMentioning(
    folderPaths: string[],
    name: string,
    cancellationToken: CancellationToken
): AsyncGenerator<AbstractNodeDocument> {
    return documentsMentioningWhere(folderPaths, name, cancellationToken, (text) => text.includes(name), parsedMention);
}

/**
 * {@link documentsMentioning} with a stricter text test than "contains the name". A search that
 * knows the shape its sites are written in (a reference position, say) narrows the candidates the
 * index names before any of them is parsed, which is where the cost of a common name sits.
 *
 * @param folderPaths the workspace folders to search.
 * @param name the word the mention index is asked about.
 * @param cancellationToken cancels the search.
 * @param mentions whether a candidate's raw text is worth parsing.
 * @returns every open buffer, plus each parsed candidate whose text passes the test.
 */
export function documentsMatching(
    folderPaths: string[],
    name: string,
    cancellationToken: CancellationToken,
    mentions: (text: string) => boolean
): AsyncGenerator<AbstractNodeDocument> {
    return documentsMentioningWhere(folderPaths, name, cancellationToken, mentions, parsedMention);
}

/**
 * The documents a symbol search has to read: every open buffer first, then each candidate file the
 * mention index names for `needle`, read from disk and parsed only when its text passes the caller's
 * own test.
 *
 * @param folderPaths the workspace folders to search.
 * @param needle the word the mention index is asked about.
 * @param cancellationToken cancels the search.
 * @param mentions whether a candidate's raw text is worth parsing.
 * @param parse parses a candidate, or answers undefined for one that cannot be parsed.
 * @returns every open buffer, plus each parsed candidate whose text passes the test.
 */
export async function* documentsMentioningWhere(
    folderPaths: string[],
    needle: string,
    cancellationToken: CancellationToken,
    mentions: (text: string) => boolean,
    parse: (file: string, text: string) => AbstractNodeDocument | undefined
): AsyncGenerator<AbstractNodeDocument> {
    const seen = new Set<string>();
    for (const document of ParserResultRegistrar.instance.allResults()) {
        // A buffer over a game file is not what the game ships, so it is left out and the file is
        // read from disk with the rest of the tree below.
        if (isGameTreeBuffer(document.uri)) continue;
        const norm = normalizeUri(document.uri);
        if (seen.has(norm)) continue;
        seen.add(norm);
        yield document;
    }
    const candidates = await MentionIndex.instance
        .candidateFiles(needle, folderPaths, cancellationToken)
        .catch(() => undefined);
    let toRead: string[];
    if (candidates) {
        toRead = candidates.filter((file) => !seen.has(normalizeUri(file)));
    } else {
        // Not a pure-word needle (or the index failed): fall back to walking every folder file.
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
        if (text === undefined || !mentions(text)) continue;
        const document = parse(file, text);
        if (document) yield document;
    }
}

/** A candidate's parse, kept with the text it came from so a re-read can vouch for it. */
interface MentionParse {
    text: string;
    document: AbstractNodeDocument;
}

/**
 * The parses of the last candidates, by normalized path. A whole-workspace scan asks about the
 * same handful of files once per id they mention, a part file naming many ids most of all, and
 * parsing was the larger half of what each of those questions cost. The text is what proves an
 * entry current: the caller has just read the file, and a string comparison against the kept text
 * is far cheaper than the parse it saves, so no stamp is needed and no stale tree can be served.
 */
const mentionParses = new Map<string, MentionParse>();

onFsInvalidation((fsPath) => {
    if (fsPath === undefined) mentionParses.clear();
    else mentionParses.delete(normalizeUri(fsPath));
});

/**
 * Parses a candidate file's text, reusing the last parse when the text is unchanged. One bad file
 * must not abort the whole search (the parser still throws on some constructs), so an unparseable
 * candidate answers nothing.
 *
 * @param file the candidate's on-disk path.
 * @param text the text just read from it.
 * @returns the parsed document, or undefined when the text cannot be parsed.
 */
const parsedMention = (file: string, text: string): AbstractNodeDocument | undefined => {
    const key = normalizeUri(file);
    const kept = mentionParses.get(key);
    if (kept && kept.text === text) {
        mentionParses.delete(key);
        mentionParses.set(key, kept);
        return kept.document;
    }
    try {
        const document = parseText(text, file);
        noteDocumentSource(document, text);
        if (mentionParses.size >= MENTION_PARSE_CAP) {
            const oldest = mentionParses.keys().next().value;
            if (oldest !== undefined) mentionParses.delete(oldest);
        }
        mentionParses.set(key, { text, document });
        return document;
    } catch {
        return undefined;
    }
};
