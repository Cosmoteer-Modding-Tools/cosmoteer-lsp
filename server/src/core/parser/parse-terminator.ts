import { Token, TOKEN_TYPES } from '../lexer/lexer';
import * as l10n from '@vscode/l10n';
import { ParserError, ParserState } from './parser.types';

/**
 * Whether a `,`/`;` at the given index ends nothing, which makes the game refuse the whole file.
 *
 * ObjectText reads one insignificant token and then accepts a separator as the terminator of the
 * node it just finished (`OTGroupedGroupNode.Parse`). Running the shipped HalflingCore parser over
 * the shapes settles what that means in practice:
 *
 * - after a field, a reference or a void name the separator is valid only before that node's
 *   terminating line break, so `A = 1 ;` loads and `A = 1` with a `;` on the next line does not,
 *   whether a comment or a blank line sits between them or not,
 * - after a group's `}` or a list's `]` one separator is valid across line breaks, blank lines and
 *   comments alike, while a second one is not,
 * - right after an `=` the separator is the field's value rather than a terminator, so `A = ;;`
 *   loads with `A` holding `";"`,
 * - anywhere else, including the start of the file, the game stops on it.
 *
 * @param tokens the document's tokens.
 * @param index the position of the separator.
 * @returns true when the game refuses the file on this separator.
 */
export const isOrphanTerminator = (tokens: Token[], index: number): boolean => {
    const token = tokens[index];
    if (token?.type !== TOKEN_TYPES.SEMICOLON && token?.type !== TOKEN_TYPES.COMMA) return false;
    const previous = tokens[index - 1];
    // Nothing at all stands in front of it, so it is the first thing in the file.
    if (!previous) return true;
    // The value slot of the member is still open, so the separator fills it instead of ending it.
    if (previous.type === TOKEN_TYPES.EQUALS || previous.type === TOKEN_TYPES.COLON) return false;
    if (previous.type === TOKEN_TYPES.SEMICOLON || previous.type === TOKEN_TYPES.COMMA) {
        // The one legal pair: the first separator became the value of an empty `=`, so the second
        // one is the member's terminator.
        return tokens[index - 2]?.type !== TOKEN_TYPES.EQUALS;
    }
    // A container that has just closed takes its terminator wherever it stands.
    if (previous.type === TOKEN_TYPES.RIGHT_BRACE || previous.type === TOKEN_TYPES.RIGHT_BRACKET) return false;
    // Everything else ends at its own line break, which has already ended the node.
    return !!token.precededByNewline;
};

/**
 * Reports a `,`/`;` that ends nothing, on the separator itself.
 *
 * @param state the parse state the error is recorded in.
 * @param index the position of the separator.
 */
export const reportOrphanTerminator = (state: ParserState, index: number): void => {
    if (!isOrphanTerminator(state.tokens, index)) return;
    const token = state.tokens[index];
    const separator = token.type === TOKEN_TYPES.SEMICOLON ? ';' : ',';
    state.errors.push({
        message: l10n.t('This "{0}" has no entry in front of it to end', separator),
        token,
        additionalInfo: [
            {
                message: l10n.t(
                    'A "," or ";" ends the entry written in front of it on the same line. The game stops where one stands on its own and fails to load the whole file. Delete the separator.'
                ),
            },
        ],
    } as ParserError);
};
