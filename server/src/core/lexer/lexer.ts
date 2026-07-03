import { globalSettings } from '../../settings';

/**
 * Whether the next non-(space/tab) character at or after `i` is `(`. Used in the value-reading loop
 * to treat a `-`/`/` before a (possibly space-separated) parenthesized group as a binary operator —
 * so `7- (12/64)` lexes as `7`,`-`,`(…)` rather than gluing `7-` into a bogus function name. Only
 * spaces/tabs are skipped (a newline ends the value anyway).
 */
const parenFollowsSpaces = (input: string, i: number): boolean => {
    while (i < input.length && (input[i] === ' ' || input[i] === '\t')) i++;
    return input[i] === '(';
};

// The hot per-character classifiers, hoisted to module scope and reduced to charcode lookups. The
// lexer runs these for every character of every file in a whole-project walk, and a regex literal
// inside the loop would allocate a fresh RegExp object per character on top of the match cost.

/** Lookup for the ASCII part of the unquoted-value charset (see the VALUE loop below). */
const ASCII_VALUE_CHAR = new Uint8Array(128);
for (const range of [
    [0x30, 0x39],
    [0x41, 0x5a],
    [0x61, 0x7a],
] as const) {
    for (let code = range[0]; code <= range[1]; code++) ASCII_VALUE_CHAR[code] = 1;
}
for (const char of "-^~./&_<>%! '") ASCII_VALUE_CHAR[char.charCodeAt(0)] = 1;

/** Matches the non-ASCII whitespace `\s` recognizes (NBSP, ideographic space, BOM, …). */
const NON_ASCII_WHITESPACE = new RegExp('[\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]');

/**
 * Whether a character belongs in an unquoted value. Unquoted values may contain arbitrary text: the
 * game's value is simply every token joined until a delimiter. Localized strings/*.rules carry
 * unquoted accented letters (Fuellen), CJK text and punctuation. Every structural/math character in
 * our grammar is ASCII, so every character from U+0080 up (including lone surrogate halves) plus the
 * listed ASCII set counts as a value character. Numbers stay ASCII so the number checks are unaffected.
 *
 * @param code the character's UTF-16 code unit.
 * @returns true when the character can be part of an unquoted value.
 */
const isValueCharCode = (code: number): boolean => (code < 128 ? ASCII_VALUE_CHAR[code] === 1 : true);

/**
 * Whether a character is whitespace by the same definition as the `\s` regex class.
 *
 * @param char the single character to test.
 * @returns true for ASCII whitespace and the Unicode spaces `\s` matches.
 */
const isWhitespaceChar = (char: string): boolean => {
    const code = char.charCodeAt(0);
    if (code === 32 || (code >= 9 && code <= 13)) return true;
    return code >= 128 && NON_ASCII_WHITESPACE.test(char);
};

/**
 * Whether a character can appear in a numeric literal for the `<number>/` and `!`-factorial
 * splits: digit, space, or decimal point. A dot alone is not a number — callers must also require
 * a digit seen so far, or `../Ref` relative paths would split at their slash.
 */
const isNumberCharCode = (code: number): boolean => (code >= 0x30 && code <= 0x39) || code === 32 || code === 0x2e;

/** `MM:SS`/`HH:MM:SS` time-literal prefix, evaluated only when a `:` follows a value. */
const TIME_LITERAL_PREFIX = /^\d+(:\d+)*$/;
/** Scientific-notation mantissa+`e`, evaluated only when a `+`/`-` follows a value. */
const EXPONENT_PREFIX = /^[\d.]+[eE]$/;

export const lexer = (input: string): Token[] => {
    let current = 0;
    let lineNumber = 0;
    let lineOffset = 0;
    const tokens: Token[] = [];
    // Tracks ObjectText value termination: an unsuppressed newline ends a field value. Mirrors the
    // game's `OTToken.IsUnsuppressedNewLine`, which evaluates the WHOLE insignificant run (whitespace
    // + comments) between two real tokens: the run's newline is suppressed (line continuation) iff a
    // `\` appears BEFORE the first newline in that run. So once a `\` is seen before any newline, the
    // rest of the run — extra blank lines AND `//` comment lines — is suppressed too. `runSuppressed`
    // records that early `\`; `runNewlineSeen` locks the run's fate at its first newline.
    let sawUnsuppressedNewline = false;
    let runSuppressed = false;
    let runNewlineSeen = false;
    // Apply the run rule at a newline (the value-terminating newline of a whitespace run or a `//`
    // comment). Only the FIRST newline in a run decides: it terminates unless an earlier `\` suppressed it.
    const markNewline = (): void => {
        if (runNewlineSeen) return;
        runNewlineSeen = true;
        if (!runSuppressed) sawUnsuppressedNewline = true;
    };
    const pushToken = (token: Token): void => {
        if (sawUnsuppressedNewline) token.precededByNewline = true;
        sawUnsuppressedNewline = false;
        runSuppressed = false;
        runNewlineSeen = false;
        tokens.push(token);
    };
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
            // The newline that ends a `//` comment is part of the insignificant run and follows the
            // same rule — it terminates the value UNLESS an earlier `\` in the run suppressed it
            // (`"a"\ <newline> //comment <newline> "b"` is one continued string, game-verified).
            markNewline();
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
            pushToken(createToken(TOKEN_TYPES.LEFT_BRACE, lineOffset++, lineNumber, current, current + 1));
            current++;
            continue;
        }

        if (char === '}') {
            pushToken(createToken(TOKEN_TYPES.RIGHT_BRACE, lineOffset++, lineNumber, current, current + 1));
            current++;
            continue;
        }

        if (char === '[') {
            pushToken(createToken(TOKEN_TYPES.LEFT_BRACKET, lineOffset++, lineNumber, current, current + 1));
            current++;
            continue;
        }

        if (char === ']') {
            pushToken(createToken(TOKEN_TYPES.RIGHT_BRACKET, lineOffset++, lineNumber, current, current + 1));
            current++;
            continue;
        }

        if (char === ':') {
            pushToken(createToken(TOKEN_TYPES.COLON, lineOffset++, lineNumber, current, current + 1));
            current++;
            continue;
        }

        if (char === ',') {
            pushToken(createToken(TOKEN_TYPES.COMMA, lineOffset++, lineNumber, current, current + 1));
            current++;
            continue;
        }

        if (char === '=') {
            pushToken(createToken(TOKEN_TYPES.EQUALS, lineOffset++, lineNumber, current, current + 1));
            current++;
            continue;
        }

        if (char === ';') {
            pushToken(createToken(TOKEN_TYPES.SEMICOLON, lineOffset++, lineNumber, current, current + 1));
            current++;
            continue;
        }

        if (char === '+' || char === '-' || char === '*' || char === '/') {
            pushToken(createToken(TOKEN_TYPES.EXPRESSION, lineOffset++, lineNumber, current, current + 1, char));
            current++;
            continue;
        }

        // `^` is mXparser exponentiation except when it begins a `^/…` super-path reference
        // (inheritance), which stays inside the VALUE token below. Same disambiguation guards the
        // value-reading loop so `2^8` splits but `^/0/Part` does not.
        if (char === '^' && input[current + 1] !== '/') {
            pushToken(createToken(TOKEN_TYPES.EXPRESSION, lineOffset++, lineNumber, current, current + 1, char));
            current++;
            continue;
        }

        // `!` is mXparser's postfix factorial operator. It is emitted as an EXPRESSION token but the
        // parser/evaluator treat it as a unary suffix on the preceding operand (no right operand).
        if (char === '!') {
            pushToken(createToken(TOKEN_TYPES.EXPRESSION, lineOffset++, lineNumber, current, current + 1, char));
            current++;
            continue;
        }

        if (char === '(') {
            pushToken(createToken(TOKEN_TYPES.LEFT_PAREN, lineOffset++, lineNumber, current, current + 1));
            current++;
            continue;
        }

        if (char === ')') {
            pushToken(createToken(TOKEN_TYPES.RIGHT_PAREN, lineOffset++, lineNumber, current, current + 1));
            current++;
            continue;
        }

        if (isWhitespaceChar(char)) {
            if (char === '\n') {
                // A `\` earlier in this whitespace/comment run (before the run's first newline)
                // suppresses it as an ObjectText line continuation; otherwise it terminates the value.
                markNewline();
                lineNumber++;
                lineOffset = 0;
            } else {
                lineOffset++;
            }
            current++;
            continue;
        }

        // Verbatim string `@"…"` (ObjectText, C#-style): no `\` escapes, a doubled `""` is a
        // literal quote, and it may span newlines. Ends at the first lone `"`.
        if (char === '@' && input[current + 1] === '"') {
            let value = '';
            const start = current;
            const lineOffsetBefore = lineOffset;
            current += 2;
            lineOffset += 2;
            while (current < input.length) {
                if (input[current] === '"') {
                    if (input[current + 1] === '"') {
                        value += '"';
                        current += 2;
                        lineOffset += 2;
                        continue;
                    }
                    current++;
                    lineOffset++;
                    break;
                }
                if (input[current] === '\n') {
                    lineNumber++;
                    lineOffset = 0;
                } else {
                    lineOffset++;
                }
                value += input[current];
                current++;
            }
            pushToken(createToken(TOKEN_TYPES.STRING, lineOffsetBefore, lineNumber, start, current, value));
            continue;
        }

        if (char === '"') {
            let value = '';
            const start = current;
            const lineOffsetBefore = lineOffset;
            current++; // skip the opening quote
            lineOffset++;
            // A `\` escapes the next character (whatever it is), so `\\` is a literal backslash and
            // the quote that follows it closes the string. The old `input[current-1] === '\\'` check
            // mishandled this — a string ending in `\\` (e.g. `"\\"`) ran past its closing quote and
            // swallowed the rest of the file. Track the escape explicitly instead.
            while (current < input.length) {
                const c = input[current];
                if (c === '\\') {
                    value += c;
                    current++;
                    lineOffset++;
                    if (current < input.length) {
                        value += input[current];
                        current++;
                        lineOffset++;
                    }
                    continue;
                }
                if (c === '"') {
                    current++;
                    lineOffset++;
                    break;
                }
                if (c === '\n') {
                    lineNumber++;
                    lineOffset = 0;
                } else {
                    lineOffset++;
                }
                value += c;
                current++;
            }
            pushToken(createToken(TOKEN_TYPES.STRING, lineOffsetBefore, lineNumber, start, current, value));
            continue;
        }

        if (char === 't' && input[current + 1] === 'r' && input[current + 2] === 'u' && input[current + 3] === 'e') {
            pushToken(createToken(TOKEN_TYPES.TRUE, lineOffset, lineNumber, current, current + 4));
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
            pushToken(createToken(TOKEN_TYPES.FALSE, lineOffset, lineNumber, current, current + 5));
            lineOffset += 5;
            current += 5;
            continue;
        }

        if (isValueCharCode(char.charCodeAt(0))) {
            const start = current;
            const lineOffsetBefore = lineOffset;
            // Whether every character consumed so far is a digit, space, or decimal point (the number
            // predicate the `!`-factorial and `<number>/` checks need). Tracked incrementally so the loop
            // does not re-scan the whole accumulated value on each character. The value string itself is
            // not accumulated either \u2014 the loop consumes contiguous input, so it is sliced once at the end.
            let numberSoFar = true;
            // Whether an actual digit was consumed. The `<number>/` division split requires it so that
            // dot-only prefixes stay whole: `../Ref` and `./Data/\u2026` are paths, not division, while
            // `0.065/1.75` and `.5/2` are division and must split.
            let sawDigit = false;
            // Track whether we're inside a `<...>` file-path segment of a reference. There a backslash
            // is a path separator — ObjectText accepts `&<dir\file.rules>` (it's not an invalid path
            // char) and .NET resolves it on Windows — not the whitespace/line-continuation `\` is
            // elsewhere. So keep it in the value instead of ending the token (navigateRules then
            // normalizes `\`→`/`). Without this the reference splits into `&<dir` + `file.rules>` and
            // is wrongly reported "not valid".
            let insideFilePath = false;
            while (
                (((isValueCharCode(char.charCodeAt(0)) || (insideFilePath && char === '\\')) &&
                    // A `^` that is not part of a `^/…` super-path is the power operator, so it
                    // must end the current value (`2^8` → `2`, `^`, `8`) instead of being absorbed.
                    !(char === '^' && input[current + 1] !== '/') &&
                    // `-` and `/` live in the value charset (negative numbers, hyphenated names,
                    // reference paths like `&~/SIZE/0`). But they are binary operators when preceded
                    // by whitespace (`10 - 3`, `&a / 2`) OR followed by `(` — a parenthesized group —
                    // as in `1-(&X)` or `2.625- (12/64)` (otherwise `1-` would be misread as a
                    // function name). The `(` may be separated from the `-`/`/` by spaces/tabs
                    // (`7- (12/64)`), so look past them. End the value there and lex it as an
                    // EXPRESSION. Attached forms (`-7`, `a-b`, `E-38`, `SIZE/0`) stay in the value.
                    !((char === '-' || char === '/') &&
                        ((current > start && isWhitespaceChar(input[current - 1])) ||
                            parenFollowsSpaces(input, current + 1))) &&
                    // `!` is the factorial operator only after a number (`5!`). After letters it is a
                    // literal exclamation that belongs to the value — localized UI text is full of
                    // them (`KÄMPFEN!`, `LOS!`). Keep `!` in non-numeric values, split it off numbers.
                    !(char === '!' && numberSoFar && sawDigit && current > start)) ||
                    // `MM:SS`/`HH:MM:SS` time literal: a `:` between digits stays in the
                    // value (e.g. `TimeLimit = 30:00`) so it is not lexed as an inheritance
                    // colon. `Child : Parent` is unaffected (the value there is not digits).
                    (char === ':' &&
                        TIME_LITERAL_PREFIX.test(input.slice(start, current)) &&
                        /\d/.test(input[current + 1] ?? '')) ||
                    // Scientific-notation exponent sign: a `+`/`-` right after `e`/`E`
                    // (e.g. `3.4028235E+38`) stays in the value rather than being lexed as a
                    // math operator. (`E-38` already works via the `-` in the value charset.)
                    ((char === '+' || char === '-') &&
                        EXPONENT_PREFIX.test(input.slice(start, current)) &&
                        /\d/.test(input[current + 1] ?? ''))) &&
                !isSingleLineComment(char, input, current) &&
                !isStartOfMultiLineComment(char, input, current)
            ) {
                if (char === '<') insideFilePath = true;
                else if (char === '>') insideFilePath = false;
                if (numberSoFar && !isNumberCharCode(char.charCodeAt(0))) numberSoFar = false;
                if (numberSoFar && char >= '0' && char <= '9') sawDigit = true;
                if (numberSoFar && sawDigit && input[current + 1] === '/') {
                    current++;
                    // Keep the column counter in step with `current`. Without this every token
                    // after a `<number>/…` split (e.g. `1/16`) is reported one column too early.
                    lineOffset++;
                    break;
                }
                char = input[++current];
                lineOffset++;
                if (current >= input.length) break;
            }
            const untrimmedValue = input.slice(start, current);
            const value = untrimmedValue.trim();
            pushToken(
                createToken(
                    TOKEN_TYPES.VALUE,
                    lineOffsetBefore,
                    lineNumber,
                    start,
                    current - (untrimmedValue.length - value.length),
                    value
                )
            );
            continue;
        }
        // `\` is whitespace in ObjectText, and a `\` before the run's first newline is a line
        // continuation that suppresses the value-terminating newline for the rest of the run (a `\`
        // AFTER a newline comes too late and does not suppress). Skip the backslash.
        if (char === '\\') {
            if (!runNewlineSeen) runSuppressed = true;
            lineOffset++;
            current++;
            continue;
        }
        // Only under 'verbose' — an UNEXPECTED token is emitted regardless, and parsing the
        // whole game tree (find-all-references) would otherwise spew thousands of these.
        if (globalSettings.trace.server === 'verbose') console.warn('unexcpected', char);
        pushToken(createToken(TOKEN_TYPES.UNEXPECTED, lineOffset, lineNumber, current, current + 1, char));
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
    /**
     * True when an unsuppressed newline separates this token from the previous one (a `\` before a
     * newline suppresses it — ObjectText line continuation). ObjectText terminates a field value at
     * an unsuppressed newline, so the parser uses this to stop value/expression contexts at a line
     * break (e.g. an unclosed `ceil((&A + 3` must not swallow the next line's field). Omitted (falsy)
     * when no newline — or only a suppressed one — precedes the token.
     */
    precededByNewline?: boolean;
}

const isSingleLineComment = (char: string, input: string, current: number) => {
    return char === '/' && input[current + 1] === '/';
};

const isStartOfMultiLineComment = (char: string, input: string, current: number) => {
    return char === '/' && input[current + 1] === '*';
};
