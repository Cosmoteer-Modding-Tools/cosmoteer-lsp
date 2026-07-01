import { readdir, readFile } from 'fs/promises';
import { join, sep } from 'path';
import { CancellationToken } from 'vscode-languageserver';
import { AbstractNodeDocument } from '../../core/ast/ast';
import { parseFilePath, parseText } from '../../utils/ast.utils';
import { CancellationError } from '../../utils/cancellation';
import { ParserResultRegistrar } from '../../registrar/parser-result-registrar';
import { globalSettings } from '../../settings';
import { normalizeUri } from './reference-location';

/** Convert a workspace-folder `file://` URI to an on-disk path (Windows-aware). */
export const uriToFsPath = (uri: string): string => {
    if (!uri.startsWith('file://')) return uri;
    let path = uri.slice('file://'.length);
    try {
        path = decodeURIComponent(path);
    } catch {
        /* leave as-is on malformed escapes */
    }
    // `file:///C:/x` decodes to `/C:/x` — strip the slash before a drive letter.
    if (/^\/[a-zA-Z]:\//.test(path)) path = path.slice(1);
    return path.replace(/\//g, sep);
};

/** Yield every `.rules` file path under `dir`, recursively. Unreadable dirs are skipped. */
export async function* collectRulesFiles(dir: string): AsyncGenerator<string> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) yield* collectRulesFiles(full);
        else if (entry.isFile() && entry.name.endsWith('.rules')) yield full;
    }
}

/**
 * Every `.rules` document in the open project: each file under the workspace folders
 * (live editor buffer preferred over disk), plus any open buffer that lives outside
 * them (or a no-folder session). De-duplicated by canonical uri, so a file open in the
 * editor is yielded once regardless of folder/buffer spelling.
 */
export async function* projectDocuments(
    folderPaths: string[],
    cancellationToken: CancellationToken
): AsyncGenerator<AbstractNodeDocument> {
    const seen = new Set<string>();
    for (const folder of folderPaths) {
        for await (const file of collectRulesFiles(uriToFsPath(folder))) {
            if (cancellationToken.isCancellationRequested) throw new CancellationError();
            // A single unparseable file must not abort the whole project walk — otherwise
            // one bad file silently kills find-all-references / rename / workspace symbols
            // for the entire project. Skip it (the parser still throws on some constructs,
            // e.g. inferValueType), but let cancellation through.
            let document: AbstractNodeDocument;
            try {
                document = ParserResultRegistrar.instance.getResultByPath(file) ?? (await parseFilePath(file));
            } catch (e) {
                if (e instanceof CancellationError) throw e;
                if (globalSettings.trace.server === 'messages') console.error(`Skipping unparseable ${file}:`, e);
                continue;
            }
            const norm = normalizeUri(document.uri);
            if (seen.has(norm)) continue;
            seen.add(norm);
            yield document;
        }
    }
    for (const document of ParserResultRegistrar.instance.allResults()) {
        const norm = normalizeUri(document.uri);
        if (seen.has(norm)) continue;
        seen.add(norm);
        yield document;
    }
}

/**
 * Like {@link projectDocuments}, but only yields documents whose raw text mentions `name`
 * — a cheap substring pre-filter that lets find-all-references / rename scale to the whole
 * Cosmoteer `Data` tree: the vast majority of files don't mention a given symbol, so they're
 * never parsed or resolved. The per-reference check that follows is the real filter. This
 * just skips the irrelevant bulk. Reads each file's text once and parses that same text.
 */
export async function* documentsMentioning(
    folderPaths: string[],
    name: string,
    cancellationToken: CancellationToken
): AsyncGenerator<AbstractNodeDocument> {
    const seen = new Set<string>();
    for (const folder of folderPaths) {
        for await (const file of collectRulesFiles(uriToFsPath(folder))) {
            if (cancellationToken.isCancellationRequested) throw new CancellationError();
            const norm = normalizeUri(file);
            if (seen.has(norm)) continue;
            seen.add(norm);
            // A live buffer is preferred (unsaved edits) and yielded without a text pre-filter
            // — there are few open buffers, and the per-reference check filters them.
            const open = ParserResultRegistrar.instance.getResultByPath(file);
            if (open) {
                yield open;
                continue;
            }
            let text: string;
            try {
                text = await readFile(file, { encoding: 'utf-8' });
            } catch {
                continue;
            }
            if (!text.includes(name)) continue;
            // One bad file must not abort the whole search (the parser still throws on some
            // constructs). Skip it.
            try {
                yield parseText(text, file);
            } catch {
                /* unparseable — skip */
            }
        }
    }
    for (const document of ParserResultRegistrar.instance.allResults()) {
        const norm = normalizeUri(document.uri);
        if (seen.has(norm)) continue;
        seen.add(norm);
        yield document;
    }
}
