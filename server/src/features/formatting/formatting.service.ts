import { Range, TextEdit } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';

/**
 * Turn a formatter's full output into a single minimal replacement edit by trimming the common
 * prefix and suffix, so the editor keeps the cursor and view stable for the untouched parts.
 *
 * @param document the open document the formatter ran on.
 * @param formatted the formatter's full output text.
 * @returns the edits to apply, empty when the text is already formatted.
 */
export const minimalReplacementEdits = (document: TextDocument, formatted: string): TextEdit[] => {
    const original = document.getText();
    if (original === formatted) return [];
    const shorter = Math.min(original.length, formatted.length);
    let prefix = 0;
    while (prefix < shorter && original[prefix] === formatted[prefix]) prefix++;
    let suffix = 0;
    while (
        suffix < shorter - prefix &&
        original[original.length - 1 - suffix] === formatted[formatted.length - 1 - suffix]
    ) {
        suffix++;
    }
    const range = Range.create(document.positionAt(prefix), document.positionAt(original.length - suffix));
    return [TextEdit.replace(range, formatted.slice(prefix, formatted.length - suffix))];
};
