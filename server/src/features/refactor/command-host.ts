import { readFile } from 'fs/promises';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { filePathToUri } from '../navigation/navigation-strategy';
import { normalizeUri } from '../navigation/reference-location';

/** The facilities every refactor command reads the editor's buffers through. */
interface OpenDocumentHost {
    /** The editor's open buffers, whose unsaved text wins over disk. */
    openDocuments(): readonly TextDocument[];
}

/**
 * The open buffers keyed by normalized uri, so a file open in the editor is read and edited live.
 *
 * @param host the server facilities.
 * @returns the buffers, keyed by normalized uri.
 */
export const openBuffers = (host: OpenDocumentHost): Map<string, TextDocument> => {
    const map = new Map<string, TextDocument>();
    for (const document of host.openDocuments()) map.set(normalizeUri(document.uri), document);
    return map;
};

/**
 * The open buffer for a path, or a document built from its disk content.
 *
 * @param fsPath the file to read.
 * @param open the editor's buffers, keyed by normalized uri.
 * @returns the document, or undefined when the file cannot be read.
 */
export const documentFor = async (
    fsPath: string,
    open: ReadonlyMap<string, TextDocument>
): Promise<TextDocument | undefined> => {
    const canonical = filePathToUri(fsPath);
    const buffer = open.get(normalizeUri(canonical));
    if (buffer) return buffer;
    try {
        return TextDocument.create(canonical, 'rules', 0, await readFile(fsPath, { encoding: 'utf-8' }));
    } catch {
        return undefined;
    }
};

/**
 * The line ending a file already uses, so anything written into it or beside it keeps it.
 *
 * @param text the file's own text.
 * @returns the ending the file is written with.
 */
export const lineEndingOf = (text: string): '\n' | '\r\n' => (text.includes('\r\n') ? '\r\n' : '\n');
