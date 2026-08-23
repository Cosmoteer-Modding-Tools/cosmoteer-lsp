import { globalSettings } from '../../settings';

/**
 * The character codes the scanners dispatch on. Named rather than inlined so the tables and the jump
 * table below read like the grammar they implement.
 */
const enum CHAR {
    TAB = 9,
    NEWLINE = 10,
    VERTICAL_TAB = 11,
    FORM_FEED = 12,
    CARRIAGE_RETURN = 13,
    SPACE = 32,
    BANG = 33,
    QUOTE = 34,
    AMPERSAND = 38,
    LEFT_PAREN = 40,
    RIGHT_PAREN = 41,
    STAR = 42,
    PLUS = 43,
    COMMA = 44,
    MINUS = 45,
    SLASH = 47,
    ZERO = 48,
    NINE = 57,
    COLON = 58,
    SEMICOLON = 59,
    LESS_THAN = 60,
    EQUALS = 61,
    GREATER_THAN = 62,
    AT = 64,
    UPPER_E = 69,
    LEFT_BRACKET = 91,
    BACKSLASH = 92,
    RIGHT_BRACKET = 93,
    CARET = 94,
    LOWER_E = 101,
    LEFT_BRACE = 123,
    RIGHT_BRACE = 125,
}

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
    UNEXPECTED = 'UNEXPECTED',
}

// The hot per-character classifiers, hoisted to module scope and reduced to charcode lookups. The
// lexer runs these for every character of every file in a whole-project walk, and a regex literal
// inside the loop would allocate a fresh RegExp object per character on top of the match cost.

/** What a character means to the value scanner, one entry per ASCII code (see {@link VALUE_CHAR_CLASS}). */
const enum VALUE_CHAR {
    /** Not part of a value: the character ends the value being read. */
    ENDS = 0,
    /** Part of a value wherever it stands, the case the scanner's fast path is for. */
    ORDINARY = 1,
    /** Part of a value, but it can also be an operator or a comment opener, so it is judged in place. */
    CHECKED = 2,
    /** Never starts a value, and only stays inside one under the rules in {@link belongsInValue}. */
    INSIDE_ONLY = 3,
}

/**
 * The value charset by character code. Unquoted values may contain arbitrary text: the game's value
 * is simply every token joined until a delimiter. Localized strings/*.rules carry unquoted accented
 * letters (Fuellen), CJK text and punctuation. Every structural/math character in our grammar is
 * ASCII, so every character from U+0080 up (including lone surrogate halves) counts as
 * {@link VALUE_CHAR.ORDINARY} without a lookup, and only the ASCII range needs this table.
 */
const VALUE_CHAR_CLASS = new Uint8Array(128);
for (const range of [
    [CHAR.ZERO, CHAR.NINE],
    [0x41, 0x5a],
    [0x61, 0x7a],
] as const) {
    for (let code = range[0]; code <= range[1]; code++) VALUE_CHAR_CLASS[code] = VALUE_CHAR.ORDINARY;
}
for (const char of "-^~./&_<>%! '") VALUE_CHAR_CLASS[char.charCodeAt(0)] = VALUE_CHAR.ORDINARY;
// A value character that can also mean something else, so the scanner asks before taking it.
for (const char of '-/^!') VALUE_CHAR_CLASS[char.charCodeAt(0)] = VALUE_CHAR.CHECKED;
// Not value characters at all, yet each has one shape in which it stays inside a value: a time
// literal or a virtual-inheritance path segment (`:`), an exponent sign (`+`), a path separator
// inside `<…>` (`\`).
for (const char of ':+\\') VALUE_CHAR_CLASS[char.charCodeAt(0)] = VALUE_CHAR.INSIDE_ONLY;

/**
 * The token a single character stands for on its own, by character code. `/` and `^` are absent on
 * purpose: what they mean depends on the character after them, so the main loop settles those two
 * before reading this table.
 */
const SINGLE_CHAR_TOKEN = new Array<TOKEN_TYPES | undefined>(128);
SINGLE_CHAR_TOKEN[CHAR.LEFT_BRACE] = TOKEN_TYPES.LEFT_BRACE;
SINGLE_CHAR_TOKEN[CHAR.RIGHT_BRACE] = TOKEN_TYPES.RIGHT_BRACE;
SINGLE_CHAR_TOKEN[CHAR.LEFT_BRACKET] = TOKEN_TYPES.LEFT_BRACKET;
SINGLE_CHAR_TOKEN[CHAR.RIGHT_BRACKET] = TOKEN_TYPES.RIGHT_BRACKET;
SINGLE_CHAR_TOKEN[CHAR.LEFT_PAREN] = TOKEN_TYPES.LEFT_PAREN;
SINGLE_CHAR_TOKEN[CHAR.RIGHT_PAREN] = TOKEN_TYPES.RIGHT_PAREN;
SINGLE_CHAR_TOKEN[CHAR.COLON] = TOKEN_TYPES.COLON;
SINGLE_CHAR_TOKEN[CHAR.COMMA] = TOKEN_TYPES.COMMA;
SINGLE_CHAR_TOKEN[CHAR.EQUALS] = TOKEN_TYPES.EQUALS;
SINGLE_CHAR_TOKEN[CHAR.SEMICOLON] = TOKEN_TYPES.SEMICOLON;
SINGLE_CHAR_TOKEN[CHAR.PLUS] = TOKEN_TYPES.EXPRESSION;
SINGLE_CHAR_TOKEN[CHAR.MINUS] = TOKEN_TYPES.EXPRESSION;
SINGLE_CHAR_TOKEN[CHAR.STAR] = TOKEN_TYPES.EXPRESSION;
// `!` is mXparser's postfix factorial operator. It is emitted as an EXPRESSION token but the
// parser/evaluator treat it as a unary suffix on the preceding operand (no right operand).
SINGLE_CHAR_TOKEN[CHAR.BANG] = TOKEN_TYPES.EXPRESSION;

/** Matches the non-ASCII whitespace `\s` recognizes (NBSP, ideographic space, BOM, …). */
const NON_ASCII_WHITESPACE = new RegExp('[\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]');

/** `MM:SS`/`HH:MM:SS` time-literal prefix, evaluated only when a `:` follows a value. */
const TIME_LITERAL_PREFIX = /^\d+(:\d+)*$/;
/** Scientific-notation mantissa+`e`, evaluated only when a `+`/`-` follows a value. */
const EXPONENT_PREFIX = /^[\d.]+[eE]$/;

/**
 * Whether a character can begin or continue an unquoted value wherever it stands.
 *
 * @param code the character's UTF-16 code unit, or NaN past the end of the input.
 * @returns true for the plain value characters and everything from U+0080 up.
 */
const isOrdinaryValueCode = (code: number): boolean =>
    code >= 128 ? true : VALUE_CHAR_CLASS[code] === VALUE_CHAR.ORDINARY;

/**
 * Whether a `true`/`false` keyword ends at the given offset rather than being the first word of a
 * longer value. Whitespace counts as an end even though it is a value character, since a value may
 * hold spaces (`A = one two` is one value): the keyword forms the game reads as booleans are the
 * ones written on their own, and `IsFlippable = false // note` must stay one.
 *
 * @param input the document text.
 * @param at the offset one past the keyword.
 * @returns true when nothing at `at` continues the keyword into a longer word.
 */
const keywordEndsAt = (input: string, at: number): boolean => {
    if (at >= input.length) return true;
    const code = input.charCodeAt(at);
    return isWhitespaceCode(code) || !isOrdinaryValueCode(code);
};

/**
 * Whether a character is whitespace by the same definition as the `\s` regex class.
 *
 * @param code the character's UTF-16 code unit.
 * @returns true for ASCII whitespace and the Unicode spaces `\s` matches.
 */
const isWhitespaceCode = (code: number): boolean => {
    if (code === CHAR.SPACE || (code >= CHAR.TAB && code <= CHAR.CARRIAGE_RETURN)) return true;
    return code >= 128 && NON_ASCII_WHITESPACE.test(String.fromCharCode(code));
};

/** Whether a character is an ASCII digit. */
const isDigitCode = (code: number): boolean => code >= CHAR.ZERO && code <= CHAR.NINE;

/**
 * Whether a character can appear in a numeric literal for the `<number>/` and `!`-factorial
 * splits: digit, space, or decimal point. A dot alone is not a number. Callers must also require
 * a digit seen so far, or `../Ref` relative paths would split at their slash.
 */
const isNumberCode = (code: number): boolean => isDigitCode(code) || code === CHAR.SPACE || code === 0x2e;

/**
 * Whether the next non-(space/tab) character at or after `i` is `(`. Used in the value-reading loop
 * to treat a `-`/`/` before a (possibly space-separated) parenthesized group as a binary operator,
 * so `7- (12/64)` lexes as `7`,`-`,`(…)` rather than gluing `7-` into a bogus function name. Only
 * spaces/tabs are skipped (a newline ends the value anyway).
 *
 * @param input the document text.
 * @param i the offset to start looking from.
 * @returns true when a `(` follows, with only spaces and tabs in between.
 */
const parenFollowsSpaces = (input: string, i: number): boolean => {
    while (i < input.length) {
        const code = input.charCodeAt(i);
        if (code !== CHAR.SPACE && code !== CHAR.TAB) break;
        i++;
    }
    return input.charCodeAt(i) === CHAR.LEFT_PAREN;
};

/**
 * Whether a `-` or `/` inside a value is really the binary operator. They live in the value charset
 * (negative numbers, hyphenated names, reference paths like `&~/SIZE/0`), but they are operators
 * when preceded by whitespace (`10 - 3`, `&a / 2`) or followed by `(`, a parenthesized group, as in
 * `1-(&X)` or `2.625- (12/64)`. Otherwise `1-` would be misread as a function name. The `(` may be
 * separated from the `-`/`/` by spaces/tabs (`7- (12/64)`), so the look-ahead reads past them.
 * Attached forms (`-7`, `a-b`, `E-38`, `SIZE/0`) stay in the value.
 *
 * @param input the document text.
 * @param at the offset of the `-` or `/`.
 * @param start the offset the value being read began at.
 * @returns true when the character ends the value and is lexed as an operator.
 */
const splitsAsOperator = (input: string, at: number, start: number): boolean =>
    (at > start && isWhitespaceCode(input.charCodeAt(at - 1))) || parenFollowsSpaces(input, at + 1);

/**
 * Whether a `+`/`-` is the sign of a scientific-notation exponent (`3.4028235E+38`) rather than a
 * math operator. (`E-38` already works through the `-` in the value charset.) The previous-character
 * guard skips the slice and the regex unless an `e`/`E` precedes.
 *
 * @param input the document text.
 * @param at the offset of the sign.
 * @param start the offset the value being read began at.
 * @returns true when the sign belongs to the number.
 */
const isExponentSign = (input: string, at: number, start: number): boolean => {
    const previous = input.charCodeAt(at - 1);
    if (previous !== CHAR.LOWER_E && previous !== CHAR.UPPER_E) return false;
    return EXPONENT_PREFIX.test(input.slice(start, at)) && isDigitCode(input.charCodeAt(at + 1));
};

/**
 * Whether a `:` is part of an `MM:SS`/`HH:MM:SS` time literal, which stays in the value (e.g.
 * `TimeLimit = 30:00`) instead of being lexed as an inheritance colon. `Child : Parent` is
 * unaffected, since the value there is not digits. The `sawDigit` guard skips the slice and the
 * regex for the common non-time colon.
 *
 * @param input the document text.
 * @param at the offset of the `:`.
 * @param start the offset the value being read began at.
 * @param sawDigit whether the value read so far holds a digit.
 * @returns true when the colon belongs to the time literal.
 */
const isTimeLiteralColon = (input: string, at: number, start: number, sawDigit: boolean): boolean =>
    sawDigit && TIME_LITERAL_PREFIX.test(input.slice(start, at)) && isDigitCode(input.charCodeAt(at + 1));

/**
 * Whether a `:` is a segment of a virtual-inheritance reference path (`&:/v_A`, `&../:/v_Foo`),
 * which stays in the value. It is recognizable by its neighbors, followed by `/` and directly
 * preceded by `&` or `/`, which an inheritance colon never is: there the `:` follows the inherited
 * name or whitespace, as in `Child : Parent` or `X : /BASE/Y`.
 *
 * @param input the document text.
 * @param at the offset of the `:`.
 * @returns true when the colon is a path segment.
 */
const isVirtualPathColon = (input: string, at: number): boolean => {
    if (input.charCodeAt(at + 1) !== CHAR.SLASH) return false;
    const previous = input.charCodeAt(at - 1);
    return previous === CHAR.AMPERSAND || previous === CHAR.SLASH;
};

/**
 * Whether a character that is not a plain value character still belongs to the value being read.
 * Every character reaching here is one the value scanner cannot take on sight, so this is where the
 * ObjectText disambiguations live, one case per rule.
 *
 * The state rides in as parameters rather than in a captured object, since this is called for every
 * such character of every file a project walk reads.
 *
 * @param input the document text.
 * @param at the offset of the character.
 * @param start the offset the value being read began at.
 * @param code the character's UTF-16 code unit.
 * @param numberSoFar whether every character of the value so far is a digit, space or decimal point.
 * @param sawDigit whether the value read so far holds a digit.
 * @param insideFilePath whether the value is inside a `<…>` file-path segment of a reference.
 * @returns true when the character stays in the value, false when it ends it.
 */
const belongsInValue = (
    input: string,
    at: number,
    start: number,
    code: number,
    numberSoFar: boolean,
    sawDigit: boolean,
    insideFilePath: boolean
): boolean => {
    switch (code) {
        case CHAR.CARET:
            // A `^` that is not part of a `^/…` super-path is the power operator, so it must end the
            // current value (`2^8` → `2`, `^`, `8`) instead of being absorbed.
            return input.charCodeAt(at + 1) === CHAR.SLASH;
        case CHAR.SLASH: {
            // A comment opener ends the value wherever it stands.
            const next = input.charCodeAt(at + 1);
            if (next === CHAR.SLASH || next === CHAR.STAR) return false;
            return !splitsAsOperator(input, at, start);
        }
        case CHAR.MINUS:
            return !splitsAsOperator(input, at, start) || isExponentSign(input, at, start);
        case CHAR.PLUS:
            return isExponentSign(input, at, start);
        case CHAR.BANG:
            // `!` is the factorial operator only after a number (`5!`). After letters it is a literal
            // exclamation that belongs to the value. Localized UI text is full of them (`KÄMPFEN!`,
            // `LOS!`). Keep `!` in non-numeric values, split it off numbers.
            return !(numberSoFar && sawDigit && at > start);
        case CHAR.COLON:
            return isTimeLiteralColon(input, at, start, sawDigit) || isVirtualPathColon(input, at);
        case CHAR.BACKSLASH:
            // Inside a `<…>` file path a backslash is a path separator (ObjectText accepts
            // `&<dir\file.rules>`, it is not an invalid path character, and .NET resolves it on
            // Windows), not the whitespace/line-continuation `\` it is elsewhere. So it stays in the
            // value (navigateRules then normalizes `\`→`/`). Without this the reference splits into
            // `&<dir` + `file.rules>` and is wrongly reported as not valid.
            return insideFilePath;
        default:
            return false;
    }
};

/**
 * The span of one `/* … *\/` block comment the lexer skipped. Comments produce no tokens, so a check
 * that needs to look at them (the closing-run check in validator.comment) gets them through the
 * optional out-parameter of {@link lexer} instead of re-scanning the text, which would have to redo
 * the string and line-comment handling to know which `/*` is really a comment.
 */
export interface BlockCommentSpan {
    /** Offset of the comment's opening `/`. */
    start: number;
    /** Offset one past the comment's closing `/`, or the end of the input when it never closed. */
    end: number;
    /** False when the comment ran to the end of the file without a closing `*\/`. */
    closed: boolean;
}

/**
 * Turns rules source into the token stream the parser consumes.
 *
 * @param input the document text.
 * @param blockComments when given, every block comment the lexer skips is appended to it in source
 * order. Omitted, comment spans are not collected.
 * @returns the tokens, comments and whitespace excluded.
 */
export const lexer = (input: string, blockComments?: BlockCommentSpan[]): Token[] => {
    let current = 0;
    let lineNumber = 0;
    let lineOffset = 0;
    const tokens: Token[] = [];
    // Tracks ObjectText value termination: an unsuppressed newline ends a field value. Mirrors the
    // game's `OTToken.IsUnsuppressedNewLine`, which evaluates the whole insignificant run (whitespace
    // + comments) between two real tokens: the run's newline is suppressed (line continuation) iff a
    // `\` appears before the first newline in that run. So once a `\` is seen before any newline, the
    // rest of the run (extra blank lines and `//` comment lines) is suppressed too. `runSuppressed`
    // records that early `\`. `runNewlineSeen` locks the run's fate at its first newline.
    let sawUnsuppressedNewline = false;
    let runSuppressed = false;
    let runNewlineSeen = false;
    // Apply the run rule at a newline (the value-terminating newline of a whitespace run or a `//`
    // comment). Only the first newline in a run decides: it terminates unless an earlier `\` suppressed it.
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
    /**
     * Emits the token one character stands for and steps over it. An operator keeps its own text,
     * which the parser reads back off the token, while a structural token is known by its type alone.
     *
     * @param type the token type the character stands for.
     */
    const pushSingleChar = (type: TOKEN_TYPES): void => {
        const value = type === TOKEN_TYPES.EXPRESSION ? input[current] : undefined;
        pushToken(createToken(type, lineOffset++, lineNumber, current, current + 1, value));
        current++;
    };
    while (current < input.length) {
        const code = input.charCodeAt(current);

        // The two characters whose meaning depends on what follows them, settled before the table
        // below, together with whitespace, which produces no token at all.
        switch (code) {
            case CHAR.SLASH:
                if (input.charCodeAt(current + 1) === CHAR.SLASH) {
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
                    // The newline that ends a `//` comment is part of the insignificant run and
                    // follows the same rule: it terminates the value unless an earlier `\` in the run
                    // suppressed it (`"a"\ <newline> //comment <newline> "b"` is one continued string).
                    markNewline();
                    continue;
                }
                if (input.charCodeAt(current + 1) === CHAR.STAR) {
                    const commentStart = current;
                    let closed = true;
                    // The opening `/*` is two columns like any other text. Counting the comment's
                    // characters but not its opener reported every token after it two columns early.
                    current += 2;
                    lineOffset += 2;
                    while (input[current] !== '*' || input[current + 1] !== '/') {
                        if (input[current] === '\n') {
                            lineNumber++;
                            lineOffset = 0;
                        } else {
                            // The newline itself starts the next line rather than sitting on it, so
                            // only a character that is not one advances the column.
                            lineOffset++;
                        }
                        current++;
                        if (current >= input.length) {
                            closed = false;
                            break;
                        }
                    }
                    current += 2;
                    lineOffset += 2;
                    blockComments?.push({ start: commentStart, end: Math.min(current, input.length), closed });
                    continue;
                }
                // A `/` that opens no comment is the division operator.
                pushSingleChar(TOKEN_TYPES.EXPRESSION);
                continue;
            case CHAR.CARET:
                // `^` is mXparser exponentiation except when it begins a `^/…` super-path reference
                // (inheritance), which stays inside the VALUE token below. The value scanner guards
                // the same disambiguation, so `2^8` splits but `^/0/Part` does not.
                if (input.charCodeAt(current + 1) !== CHAR.SLASH) {
                    pushSingleChar(TOKEN_TYPES.EXPRESSION);
                    continue;
                }
                break;
            case CHAR.NEWLINE:
                // A `\` earlier in this whitespace/comment run (before the run's first newline)
                // suppresses it as an ObjectText line continuation; otherwise it terminates the value.
                markNewline();
                lineNumber++;
                lineOffset = 0;
                current++;
                continue;
            case CHAR.SPACE:
            case CHAR.TAB:
            case CHAR.CARRIAGE_RETURN:
            case CHAR.VERTICAL_TAB:
            case CHAR.FORM_FEED:
                lineOffset++;
                current++;
                continue;
        }

        // Every character whose code alone fixes what it means: the structural tokens and the
        // operators. One table read replaces the chain of comparisons this used to be, which the
        // lexer ran for every character of every file a project walk parses.
        const single = code < 128 ? SINGLE_CHAR_TOKEN[code] : undefined;
        if (single !== undefined) {
            pushSingleChar(single);
            continue;
        }

        // The whitespace `\s` recognizes beyond ASCII (NBSP, ideographic space, BOM, …). Checked
        // before the value scanner, which takes every character from U+0080 up.
        if (code >= 128 && NON_ASCII_WHITESPACE.test(input[current])) {
            lineOffset++;
            current++;
            continue;
        }

        // Verbatim string `@"…"` (ObjectText, C#-style): no `\` escapes, a doubled `""` is a
        // literal quote, and it may span newlines. Ends at the first lone `"`. The loop only
        // counts lines and finds boundaries; the value is assembled from whole slices between
        // `""` pairs instead of one string concatenation per character.
        if (code === CHAR.AT && input.charCodeAt(current + 1) === CHAR.QUOTE) {
            let value = '';
            const start = current;
            const lineOffsetBefore = lineOffset;
            current += 2;
            lineOffset += 2;
            let segmentStart = current;
            let closed = false;
            while (current < input.length) {
                if (input[current] === '"') {
                    if (input[current + 1] === '"') {
                        value += input.slice(segmentStart, current + 1);
                        current += 2;
                        lineOffset += 2;
                        segmentStart = current;
                        continue;
                    }
                    value += input.slice(segmentStart, current);
                    current++;
                    lineOffset++;
                    closed = true;
                    break;
                }
                if (input[current] === '\n') {
                    lineNumber++;
                    lineOffset = 0;
                } else {
                    lineOffset++;
                }
                current++;
            }
            if (!closed) value += input.slice(segmentStart, current);
            pushToken(createToken(TOKEN_TYPES.STRING, lineOffsetBefore, lineNumber, start, current, value));
            continue;
        }

        if (code === CHAR.QUOTE) {
            const start = current;
            const lineOffsetBefore = lineOffset;
            current++; // skip the opening quote
            lineOffset++;
            // A `\` escapes the next character (whatever it is), so `\\` is a literal backslash and
            // the quote that follows it closes the string. Tracking the escape explicitly is what
            // keeps a string ending in `\\` (e.g. `"\\"`) from running past its closing quote and
            // swallowing the rest of the file.
            // The value keeps escape sequences raw, so it is exactly the input between the quotes:
            // the loop only counts lines and finds the closing quote, and the value is sliced once.
            let contentEnd = input.length;
            while (current < input.length) {
                const c = input.charCodeAt(current);
                if (c === CHAR.BACKSLASH) {
                    current++;
                    lineOffset++;
                    if (current < input.length) {
                        current++;
                        lineOffset++;
                    }
                    continue;
                }
                if (c === CHAR.QUOTE) {
                    contentEnd = current;
                    current++;
                    lineOffset++;
                    break;
                }
                if (c === CHAR.NEWLINE) {
                    lineNumber++;
                    lineOffset = 0;
                } else {
                    lineOffset++;
                }
                current++;
            }
            const value = input.slice(start + 1, Math.min(contentEnd, current));
            pushToken(createToken(TOKEN_TYPES.STRING, lineOffsetBefore, lineNumber, start, current, value));
            continue;
        }

        // `true` and `false` are keywords only as whole words. A value that merely begins with one
        // (`truest`, and localized prose such as `falsely`) is a single value to the game, so the
        // character after the keyword has to be one no value could continue with.
        if (input.startsWith('true', current) && keywordEndsAt(input, current + 4)) {
            pushToken(createToken(TOKEN_TYPES.TRUE, lineOffset, lineNumber, current, current + 4));
            lineOffset += 4;
            current += 4;
            continue;
        }

        if (input.startsWith('false', current) && keywordEndsAt(input, current + 5)) {
            pushToken(createToken(TOKEN_TYPES.FALSE, lineOffset, lineNumber, current, current + 5));
            lineOffset += 5;
            current += 5;
            continue;
        }

        const valueClass = code < 128 ? VALUE_CHAR_CLASS[code] : VALUE_CHAR.ORDINARY;
        if (valueClass === VALUE_CHAR.ORDINARY || valueClass === VALUE_CHAR.CHECKED) {
            const start = current;
            const lineOffsetBefore = lineOffset;
            // Whether every character consumed so far is a digit, space, or decimal point (the number
            // predicate the `!`-factorial and `<number>/` checks need). Tracked incrementally so the loop
            // does not re-scan the whole accumulated value on each character. The value string itself is
            // not accumulated either. The loop consumes contiguous input, so it is sliced once at the end.
            let numberSoFar = true;
            // Whether an actual digit was consumed. The `<number>/` division split requires it so that
            // dot-only prefixes stay whole: `../Ref` and `./Data/…` are paths, not division, while
            // `0.065/1.75` and `.5/2` are division and must split.
            let sawDigit = false;
            // Whether the scanner stands inside a `<…>` file-path segment of a reference, where a
            // backslash is a path separator rather than whitespace.
            let insideFilePath = false;
            for (;;) {
                const valueCode = input.charCodeAt(current);
                const kind = valueCode < 128 ? VALUE_CHAR_CLASS[valueCode] : VALUE_CHAR.ORDINARY;
                if (kind === VALUE_CHAR.ENDS) break;
                if (
                    kind !== VALUE_CHAR.ORDINARY &&
                    !belongsInValue(input, current, start, valueCode, numberSoFar, sawDigit, insideFilePath)
                ) {
                    break;
                }
                if (valueCode === CHAR.LESS_THAN) insideFilePath = true;
                else if (valueCode === CHAR.GREATER_THAN) insideFilePath = false;
                if (numberSoFar && !isNumberCode(valueCode)) numberSoFar = false;
                if (numberSoFar && isDigitCode(valueCode)) sawDigit = true;
                if (numberSoFar && sawDigit && input.charCodeAt(current + 1) === CHAR.SLASH) {
                    current++;
                    // Keep the column counter in step with `current`. Without this every token
                    // after a `<number>/…` split (e.g. `1/16`) is reported one column too early.
                    lineOffset++;
                    break;
                }
                current++;
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
        // after a newline comes too late and does not suppress). Skip the backslash.
        if (code === CHAR.BACKSLASH) {
            if (!runNewlineSeen) runSuppressed = true;
            lineOffset++;
            current++;
            continue;
        }
        // Only under 'verbose'. An UNEXPECTED token is emitted regardless, and parsing the
        // whole game tree (find-all-references) would otherwise spew thousands of these.
        if (globalSettings.trace.server === 'verbose') console.warn('unexcpected', input[current]);
        pushToken(createToken(TOKEN_TYPES.UNEXPECTED, lineOffset, lineNumber, current, current + 1, input[current]));
        // Advance the column too: without this every UNEXPECTED char shifted all following tokens
        // on the line one column left, misplacing their diagnostics and breaking the parser's
        // source-adjacency check for assembled operators such as `@&` or `||`.
        lineOffset++;
        current++;
    }

    return tokens;
};

/**
 * Builds one token, omitting the `value` field entirely for the types that are known by their type
 * alone, so a token carries only what its consumers read.
 *
 * @param type the token's type.
 * @param lineOffset the zero-based column the token starts at.
 * @param lineNumber the zero-based line the token starts on.
 * @param start the token's start offset.
 * @param end the offset one past the token's last character.
 * @param value the token's text, for the types that carry one.
 * @returns the token.
 */
const createToken = (
    type: TOKEN_TYPES,
    lineOffset: number,
    lineNumber: number,
    start: number,
    end: number,
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
     * newline suppresses it: ObjectText line continuation). ObjectText terminates a field value at
     * an unsuppressed newline, so the parser uses this to stop value/expression contexts at a line
     * break (e.g. an unclosed `ceil((&A + 3` must not swallow the next line's field). Omitted (falsy)
     * when no newline, or only a suppressed one, precedes the token.
     */
    precededByNewline?: boolean;
}
