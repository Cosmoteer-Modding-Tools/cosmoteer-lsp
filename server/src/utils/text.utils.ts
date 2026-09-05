/**
 * The LSP position a byte offset points at inside a source text, counted by walking the text once.
 *
 * @param text the source the offset is measured in.
 * @param offset the byte offset to convert.
 * @returns the zero-based line and character of that offset.
 */
export const offsetToPosition = (text: string, offset: number): { line: number; character: number } => {
    let line = 0;
    let lineStart = 0;
    for (let i = 0; i < offset && i < text.length; i++) {
        if (text[i] === '\n') {
            line++;
            lineStart = i + 1;
        }
    }
    return { line, character: offset - lineStart };
};

/**
 * The whitespace the line holding an offset begins with, so text inserted beside a member lines up
 * with it.
 *
 * @param text the source the offset is measured in.
 * @param offset any offset on the line.
 * @returns the line's leading spaces and tabs, empty when it has none.
 */
/**
 * The offset just past the string literal starting at an offset, by the lexer's own rules: a
 * quoted `"…"` string where `\` escapes the next character, or a verbatim `@"…"` string where a
 * doubled `""` is a literal quote. An unterminated literal runs to the end of the text.
 *
 * @param text the source.
 * @param start the offset of the opening quote or of the `@` sigil.
 * @returns the offset after the closing quote, or undefined when no literal starts there.
 */
export const stringLiteralEnd = (text: string, start: number): number | undefined => {
    let i = start;
    if (text[i] === '@' && text[i + 1] === '"') {
        i += 2;
        while (i < text.length) {
            if (text[i] === '"') {
                if (text[i + 1] === '"') {
                    i += 2;
                    continue;
                }
                return i + 1;
            }
            i++;
        }
        return i;
    }
    if (text[i] === '"') {
        i++;
        while (i < text.length) {
            if (text[i] === '\\') {
                i += 2;
                continue;
            }
            if (text[i] === '"') return i + 1;
            i++;
        }
        return i;
    }
    return undefined;
};

export const indentOfLineAt = (text: string, offset: number): string => {
    let start = offset;
    while (start > 0 && text[start - 1] !== '\n') start--;
    let end = start;
    while (end < text.length && (text[end] === ' ' || text[end] === '\t')) end++;
    return text.slice(start, end);
};
