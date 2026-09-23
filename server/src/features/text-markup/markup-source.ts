import { DocumentUri } from 'vscode-languageserver';
import { documents } from '../../lsp/context';

/**
 * Where the markup layer reads a file's own text from, and how it counts positions in it.
 *
 * A value's written form and the text the parser hands on are two different strings. ObjectText
 * reads `"one" \` and the `"two"` below it as a single string, and the quote, the backslash and the
 * indent between them are gone from the text the parser carries. A verbatim `@"…"` loses its `@`,
 * its quotes and every doubled quote inside it the same way. Every offset a markup scan reports
 * points into the file, so the file's text is what a span is cut from and what a line and a
 * character are counted in.
 *
 * The outline reads through here too, for the same reason: a value carried across a continuation
 * ends on a line only the file's own text can name.
 */
export type MarkupSourceReader = (uri: DocumentUri) => string | undefined;

/** The client's open buffers, which hold the current text of every file being edited. */
const openBuffers: MarkupSourceReader = (uri) => documents.get(uri)?.getText();

let readSource: MarkupSourceReader = openBuffers;

/**
 * Points the markup layer at another set of buffers, for a host that keeps its own.
 *
 * @param reader the reader to ask, or undefined to go back to the client's open buffers.
 * @returns nothing.
 */
export const useMarkupSourceReader = (reader: MarkupSourceReader | undefined): void => {
    readSource = reader ?? openBuffers;
};

/**
 * The text of a file, as far as the markup layer can reach it.
 *
 * @param uri the file to read.
 * @returns its text, or undefined when nothing in reach holds it.
 */
export const markupSourceOf = (uri: DocumentUri): string | undefined => {
    try {
        return readSource(uri);
    } catch {
        return undefined;
    }
};

/** The text the line starts below were built for, so one file is indexed once however many tags it carries. */
let indexedText: string | undefined;
let indexedLineStarts: number[] = [];

/**
 * The offset every line of a text starts at.
 *
 * @param text the file's text.
 * @returns the offset of the first character of each line, in order.
 */
const lineStartsOf = (text: string): number[] => {
    if (indexedText === text) return indexedLineStarts;
    const starts = [0];
    for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1)) starts.push(index + 1);
    indexedText = text;
    indexedLineStarts = starts;
    return starts;
};

/**
 * The editor position an offset of a file sits at, counted in the file's own text.
 *
 * @param text the file's text.
 * @param offset the offset to place.
 * @returns the zero-based line and character.
 */
export const positionIn = (text: string, offset: number): { line: number; character: number } => {
    const starts = lineStartsOf(text);
    const bounded = Math.max(0, Math.min(offset, text.length));
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (starts[middle] <= bounded) low = middle;
        else high = middle - 1;
    }
    return { line: low, character: bounded - starts[low] };
};
