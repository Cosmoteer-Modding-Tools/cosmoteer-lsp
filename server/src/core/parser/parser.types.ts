import { DocumentUri } from 'vscode-languageserver';
import { Token } from '../lexer/lexer';
import { AbstractNode, AbstractNodeDocument } from '../ast/ast';

/** One parse error, with the token it was reported on and any follow-up notes for the reader. */
export type ParserError = {
    message: string;
    token: Token;
    additionalInfo?: Pick<ParserError, 'message' | 'token'>[];
};

/** What one parse run produces: the document tree and every error found while building it. */
export interface TokenParserResult {
    value: AbstractNodeDocument;
    parserErrors: ParserError[];
}

/**
 * Everything one parse run reads and writes while it walks the tokens. The parse is a set of
 * mutually recursive functions rather than one closure, so the cursor and the error list travel
 * through this object instead of being captured. `tokens` and `errors` never change identity, only
 * `current` moves, which is why every function reads the cursor back off the state.
 */
export interface ParserState {
    /** The token stream being read, in source order. */
    tokens: Token[];
    /** The index of the next token to read. */
    current: number;
    /** Every parse error found so far, in the order they were reported. */
    errors: ParserError[];
    /** The document the tokens came from. */
    uri: DocumentUri;
    /**
     * The node the document-level loop produced last. The arguments of a function call read and
     * write it too, so a call's first argument sees whatever the document loop last built as the
     * node before it. That is what the parse does today and what the trees in the corpus were
     * built from, so it stays shared rather than becoming a local of the loop.
     */
    lastNode?: AbstractNode;
    /**
     * The line an empty `=` handed its value slot to, when the game would read the whole of that
     * line as the value. Our parse leaves the slot empty there and reads the line as a member of its
     * own, so the dangling-`=` check needs to know that the game never reaches that member.
     */
    swallowedValueLine?: number;
}
