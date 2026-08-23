import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { AbstractNodeDocument } from '../../core/ast/ast';
import { lexer } from '../../core/lexer/lexer';
import { parser } from '../../core/parser/parser';

// Reading and parsing for the load check. The server does the same work behind its own caches and
// its workspace service, which the CLI cannot stand up without pulling half the server into a
// bundle that is meant to start in well under a second, so the load check reads the handful of
// files it needs itself. It uses the real lexer and the real parser, because the whole check rests
// on seeing the same tree the server saw.

/** One file, read once, with everything the check needs from it. */
export interface ParsedFile {
    /** The absolute path, as it was asked for. */
    file: string;
    text: string;
    document: AbstractNodeDocument;
    /** The offset each line starts at, for turning a reported position back into an offset. */
    lineStarts: number[];
}

/** What went wrong with a file that could not be used. */
interface UnreadableFile {
    file: string;
    reason: string;
}

/**
 * Reads and parses files on demand, keeping each one so a fragment pulled in twice is read once.
 * One instance covers one run.
 */
export class DocumentCache {
    private readonly parsed = new Map<string, ParsedFile>();
    private readonly failed = new Map<string, UnreadableFile>();

    /**
     * Read and parse one file.
     *
     * @param file the path to read, absolute.
     * @returns the parsed file, or undefined when it could not be read or parsed.
     */
    async get(file: string): Promise<ParsedFile | undefined> {
        const key = pathKey(file);
        const known = this.parsed.get(key);
        if (known) return known;
        if (this.failed.has(key)) return undefined;
        let text: string;
        try {
            text = await readFile(file, 'utf8');
        } catch (error) {
            this.failed.set(key, { file, reason: (error as Error).message });
            return undefined;
        }
        try {
            const document = parser(lexer(text), file).value;
            const entry: ParsedFile = { file, text, document, lineStarts: lineStartsOf(text) };
            this.parsed.set(key, entry);
            return entry;
        } catch (error) {
            this.failed.set(key, { file, reason: `it does not parse (${(error as Error).message})` });
            return undefined;
        }
    }

    /**
     * Every file that could not be read or parsed, in the order they were tried.
     *
     * @returns the failures, which the report lists rather than passes over.
     */
    unreadable(): UnreadableFile[] {
        return [...this.failed.values()];
    }
}

/**
 * The offsets the lines of a text start at, split the way the language server protocol's own
 * document splits them, so a position the server reported converts back to the offset it came from.
 *
 * @param text the file's text.
 * @returns the offset of the first character of each line, starting with zero.
 */
const lineStartsOf = (text: string): number[] => {
    const starts = [0];
    for (let index = 0; index < text.length; index++) {
        const character = text.charCodeAt(index);
        // 13 is a carriage return and 10 a line feed. A pair counts as one line end.
        if (character === 13) {
            if (text.charCodeAt(index + 1) === 10) index++;
            starts.push(index + 1);
        } else if (character === 10) {
            starts.push(index + 1);
        }
    }
    return starts;
};

/**
 * The offset a one-based line and column names, which is how a reported finding is put back where
 * it came from.
 *
 * @param lineStarts the line offsets of the file.
 * @param line the one-based line.
 * @param column the one-based column.
 * @returns the offset, clamped into the file.
 */
export const offsetOf = (lineStarts: readonly number[], line: number, column: number): number => {
    const index = Math.min(Math.max(line - 1, 0), lineStarts.length - 1);
    return lineStarts[index] + Math.max(column - 1, 0);
};

/**
 * The one-based line and column an offset sits at, which is how an action is named in the report.
 *
 * @param lineStarts the line offsets of the file.
 * @param offset the offset in the file.
 * @returns the position, one-based on both axes.
 */
export const positionOf = (lineStarts: readonly number[], offset: number): { line: number; column: number } => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (lineStarts[middle] <= offset) low = middle;
        else high = middle - 1;
    }
    return { line: low + 1, column: offset - lineStarts[low] + 1 };
};

/**
 * The form a path is compared in. Separators are made uniform, and case is folded on Windows only,
 * where the filesystem itself folds it and the same file arrives spelled two ways.
 *
 * @param path the path to normalize.
 * @returns the comparable form, which is never shown to a reader.
 */
export const pathKey = (path: string): string => {
    const forward = resolve(path).replace(/\\/g, '/');
    return process.platform === 'win32' ? forward.toLowerCase() : forward;
};

/**
 * Whether a path is inside a folder, or is the folder itself.
 *
 * @param path the path to test.
 * @param folder the folder it may be under.
 * @returns true when the path is inside.
 */
export const isInside = (path: string, folder: string): boolean => {
    const inner = pathKey(path);
    const outer = pathKey(folder);
    return inner === outer || inner.startsWith(`${outer}/`);
};
