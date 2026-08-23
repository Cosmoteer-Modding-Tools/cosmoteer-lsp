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
