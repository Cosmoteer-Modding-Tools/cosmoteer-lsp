import { globalSettings } from '../server';

export const lexer = (input: string): Token[] => {
    let current = 0;
    let lineNumber = 0;
    let lineOffset = 0;
    const tokens: Token[] = [];
    while (current < input.length) {
        let char = input[current];

        if (isSingleLineComment(char, input, current)) {
            current += 2;
            while (input[current] !== '\n') {
                current++;
                if (current >= input.length) {
                    break;
                }
            }
            lineNumber++;
            lineOffset = 0;
            current++;
            continue;
        }

        if (isStartOfMultiLineComment(char, input, current)) {
            current += 2;
            while (input[current] !== '*' || input[current + 1] !== '/') {
                if (input[current] === '\n') {
                    lineNumber++;
                    lineOffset = 0;
                }
                current++;
                lineOffset++;
                if (current >= input.length) {
                    break;
                }
            }
            current += 2;
            lineOffset += 2;
            continue;
        }

        if (char === '{') {
            tokens.push(createToken(TOKEN_TYPES.LEFT_BRACE, lineOffset++, lineNumber, current, current + 1));
            current++;
            continue;
        }

        if (char === '}') {
            tokens.push(createToken(TOKEN_TYPES.RIGHT_BRACE, lineOffset++, lineNumber, current, current + 1));
            current++;
            continue;
        }

        if (char === '[') {
            tokens.push(createToken(TOKEN_TYPES.LEFT_BRACKET, lineOffset++, lineNumber, current, current + 1));
            current++;
            continue;
        }

        if (char === ']') {
            tokens.push(createToken(TOKEN_TYPES.RIGHT_BRACKET, lineOffset++, lineNumber, current, current + 1));
            current++;
            continue;
        }

        if (char === ':') {
            tokens.push(createToken(TOKEN_TYPES.COLON, lineOffset++, lineNumber, current, current + 1));
            current++;
            continue;
        }

        if (char === ',') {
            tokens.push(createToken(TOKEN_TYPES.COMMA, lineOffset++, lineNumber, current, current + 1));
            current++;
            continue;
        }

        if (char === '=') {
            tokens.push(createToken(TOKEN_TYPES.EQUALS, lineOffset++, lineNumber, current, current + 1));
            current++;
            continue;
        }

        if (char === ';') {
            tokens.push(createToken(TOKEN_TYPES.SEMICOLON, lineOffset++, lineNumber, current, current + 1));
            current++;
            continue;
        }

        if (char === '+' || char === '-' || char === '*' || char === '/') {
            tokens.push(createToken(TOKEN_TYPES.EXPRESSION, lineOffset++, lineNumber, current, current + 1, char));
            current++;
            continue;
        }

        if (char === '(') {
            tokens.push(createToken(TOKEN_TYPES.LEFT_PAREN, lineOffset++, lineNumber, current, current + 1));
            current++;
            continue;
        }

        if (char === ')') {
            tokens.push(createToken(TOKEN_TYPES.RIGHT_PAREN, lineOffset++, lineNumber, current, current + 1));
            current++;
            continue;
        }

        const WHITESPACE = /\s/;

        if (WHITESPACE.test(char)) {
            if (char === '\n') {
                lineNumber++;
                lineOffset = 0;
            } else {
                lineOffset++;
            }
            current++;
            continue;
        }

        if (char === '"') {
            let value = '';
            const start = current;
            const lineOffsetBefore = lineOffset;
            char = input[++current];
            lineOffset++;
            while (char !== '"' || input[current - 1] === '\\') {
                value += char;
                char = input[++current];
                lineOffset++;
                if (current >= input.length) break;
            }
            char = input[++current];
            lineOffset++;
            tokens.push(createToken(TOKEN_TYPES.STRING, lineOffsetBefore, lineNumber, start, current, value));
            continue;
        }

        if (char === 't' && input[current + 1] === 'r' && input[current + 2] === 'u' && input[current + 3] === 'e') {
            tokens.push(createToken(TOKEN_TYPES.TRUE, lineOffset, lineNumber, current, current + 4));
            lineOffset += 4;
            current += 4;
            continue;
        }

        if (
            char === 'f' &&
            input[current + 1] === 'a' &&
            input[current + 2] === 'l' &&
            input[current + 3] === 's' &&
            input[current + 4] === 'e'
        ) {
            tokens.push(createToken(TOKEN_TYPES.FALSE, lineOffset, lineNumber, current, current + 4));
            lineOffset += 5;
            current += 5;
            continue;
        }

        const VALUE = /[a-zA-Z0-9-^~./&_<>% ]/;
        const IS_NUMBER = /^[0-9 ]+$/;

        if (VALUE.test(char)) {
            let value = '';
            const start = current;
            const lineOffsetBefore = lineOffset;
            while (
                VALUE.test(char) &&
                !isSingleLineComment(char, input, current) &&
                !isStartOfMultiLineComment(char, input, current)
            ) {
                value += char;
                if (IS_NUMBER.test(value) && input[current + 1] === '/') {
                    current++;
                    break;
                }
                char = input[++current];
                lineOffset++;
                if (current >= input.length) break;
            }
            value = value.trim();
            tokens.push(createToken(TOKEN_TYPES.VALUE, lineOffsetBefore, lineNumber, start, current, value));
            continue;
        }
        if (char === '\\') {
            tokens.push(createToken(TOKEN_TYPES.STRING_DELIMITER, lineOffset, lineNumber, current, current + 1, char));
            current++;
            continue;
        }
        if (globalSettings.trace.server !== 'off') console.warn('unexcpected', char);
        tokens.push(createToken(TOKEN_TYPES.UNEXPECTED, lineOffset, lineNumber, current, current + 1, char));
        current++;
    }

    return tokens;
};

export const createToken = (
    type: TOKEN_TYPES,
    lineOffset: number,
    lineNumber: number,
    start: number,
    end?: number,
    value?: string
): Token => {
    if (typeof value !== 'undefined') {
        return {
            lineOffset,
            type,
            lineNumber,
            value,
            start,
            end,
        };
    }
    return {
        lineOffset,
        type,
        lineNumber,
        start,
        end,
    };
};

export enum TOKEN_TYPES {
    LEFT_BRACE = 'LEFT_BRACE',
    RIGHT_BRACE = 'RIGHT_BRACE',
    LEFT_BRACKET = 'LEFT_BRACKET',
    RIGHT_BRACKET = 'RIGHT_BRACKET',
    LEFT_PAREN = 'LEFT_PAREN',
    RIGHT_PAREN = 'RIGHT_PAREN',
    VALUE = 'VALUE',
    SEMICOLON = 'SEMICOLON',
    COLON = 'COLON',
    EQUALS = 'EQUALS',
    COMMA = 'COMMA',
    STRING = 'STRING',
    TRUE = 'TRUE',
    FALSE = 'FALSE',
    EXPRESSION = 'EXPRESSION',
    SINGLE_COMMENT = 'SINGLE_COMMENT',
    MULTI_COMMENT = 'MULTI_COMMENT',
    STRING_DELIMITER = 'STRING_DELIMITER',
    UNEXPECTED = 'UNEXPECTED',
}

export interface Token {
    type: TOKEN_TYPES;
    start: number;
    /**
     * Optional end position of the token
     */
    end?: number;
    lineOffset: number;
    value?: string;
    lineNumber: number;
}

const isSingleLineComment = (char: string, input: string, current: number) => {
    return char === '/' && input[current + 1] === '/';
};

const isStartOfMultiLineComment = (char: string, input: string, current: number) => {
    return char === '/' && input[current + 1] === '*';
};
