// The source spelling of a token, which every parse error message reads. It lives apart from the
// dispatcher so a branch module can describe a token without importing parser.ts, which would put
// it in a cycle with the dispatcher it is called from.

import { Token, TOKEN_TYPES } from '../lexer/lexer';

/** The source spelling of punctuation tokens, for error messages. */
const TOKEN_DISPLAY: Partial<Record<TOKEN_TYPES, string>> = {
    [TOKEN_TYPES.LEFT_BRACE]: '{',
    [TOKEN_TYPES.RIGHT_BRACE]: '}',
    [TOKEN_TYPES.LEFT_BRACKET]: '[',
    [TOKEN_TYPES.RIGHT_BRACKET]: ']',
    [TOKEN_TYPES.LEFT_PAREN]: '(',
    [TOKEN_TYPES.RIGHT_PAREN]: ')',
    [TOKEN_TYPES.SEMICOLON]: ';',
    [TOKEN_TYPES.COLON]: ':',
    [TOKEN_TYPES.EQUALS]: '=',
    [TOKEN_TYPES.COMMA]: ',',
    [TOKEN_TYPES.TRUE]: 'true',
    [TOKEN_TYPES.FALSE]: 'false',
};

/**
 * The text a token reads as in an error message, preferring its literal value.
 *
 * @param token the token to describe.
 * @returns the token's source text, punctuation spelling, or type name.
 */
export const tokenDisplayText = (token: Token): string => token.value ?? TOKEN_DISPLAY[token.type] ?? token.type;
