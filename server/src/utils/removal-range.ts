import { Range } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';

/**
 * The deletion range for a remove quick fix: the byte-offset span widened to whole lines when the
 * span (plus surrounding whitespace and a trailing `,`/`;`) is all its lines contain, so removing a
 * field takes its line with it instead of leaving a blank one. When other content shares a line, the
 * exact span (plus a trailing separator) is deleted instead. Shared by the code-action handler and
 * the workspace migration, so a migrated file looks exactly like one fixed by hand.
 *
 * @param doc the text document the span belongs to.
 * @param start the span's inclusive start byte offset.
 * @param end the span's exclusive end byte offset.
 * @returns the range to replace with the empty string.
 */
export const removalRange = (doc: TextDocument, start: number, end: number): Range => {
    const text = doc.getText();
    let s = start;
    let e = end;
    // Swallow a trailing separator and the spaces around it, so `X = 1, Y = 2` minus X leaves `Y = 2`.
    while (e < text.length && (text[e] === ' ' || text[e] === '\t')) e++;
    if (text[e] === ',' || text[e] === ';') e++;
    while (s > 0 && (text[s - 1] === ' ' || text[s - 1] === '\t')) s--;
    const atLineStart = s === 0 || text[s - 1] === '\n';
    const restOfLine = text.slice(e, text.indexOf('\n', e) === -1 ? text.length : text.indexOf('\n', e));
    if (atLineStart && /^\s*$/.test(restOfLine)) {
        const nextLine = text.indexOf('\n', e);
        e = nextLine === -1 ? text.length : nextLine + 1;
    }
    return { start: doc.positionAt(s), end: doc.positionAt(e) };
};
