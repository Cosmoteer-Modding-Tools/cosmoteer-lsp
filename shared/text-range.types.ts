/**
 * A position and a span in a text document, in the protocol's own numbering: zero-based lines, and
 * characters counted in UTF-16 code units. The shapes are those of the language protocol's `Position`
 * and `Range`, written out here so a payload both sides read can carry a span without either side
 * pulling the protocol's own packages into the files they share.
 */

/** A caret position in a text document. */
export interface TextPosition {
    /** Zero-based line. */
    line: number;
    /** Zero-based character on that line. */
    character: number;
}

/** A span of a text document, empty when both ends are the same position. */
export interface TextRange {
    start: TextPosition;
    end: TextPosition;
}
