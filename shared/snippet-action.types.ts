/**
 * What the snippet-bearing code actions carry. The server cannot write the text itself, since the
 * protocol's own edits have no way to hold a tab stop, so the action hands the client the span and the
 * snippet body and the client writes it. Read by both sides, so the shape is declared once.
 */

import { TextRange } from './text-range.types';

/** The arguments the snippet action takes, as one object. */
export interface InsertSnippetArgs {
    /** The file the snippet is written into. */
    uri: string;
    /** The span the snippet replaces, empty for a pure insertion. */
    range: TextRange;
    /** The snippet body, in the tab-stop syntax both clients read. */
    snippet: string;
}
