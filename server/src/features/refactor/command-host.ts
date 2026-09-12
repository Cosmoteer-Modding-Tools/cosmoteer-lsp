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

/** How many indented lines are read before the indentation style is called, so a huge file is not walked. */
const INDENT_SAMPLE = 200;

/** The leading whitespace of a line that has something on it. */
const LINE_INDENT = /^([ \t]+)(?=[^\s])/gm;

/**
 * The one indentation step a file is written with, read from its own lines: a tab where any line
 * indents with one, else the shallowest run of spaces it uses. A file with nothing indented keeps
 * the tab the game's own files are written with.
 *
 * @param text the file's own text.
 * @returns the string one level of indentation is written as.
 */
export const indentUnitOf = (text: string): string => {
    LINE_INDENT.lastIndex = 0;
    let spaces = 0;
    for (let seen = 0; seen < INDENT_SAMPLE; seen++) {
        const match = LINE_INDENT.exec(text);
        if (!match) break;
        if (match[1].includes('\t')) return '\t';
        if (spaces === 0 || match[1].length < spaces) spaces = match[1].length;
    }
    return spaces > 0 ? ' '.repeat(spaces) : '\t';
};
