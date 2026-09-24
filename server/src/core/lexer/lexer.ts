import { globalSettings } from '../../settings';

/**
 * The character codes the scanners dispatch on. Named rather than inlined so the tables and the jump
 * table below read like the grammar they implement.
 */
const enum CHAR {
    NUL = 0,
    TAB = 9,
    NEWLINE = 10,
    VERTICAL_TAB = 11,
    FORM_FEED = 12,
    CARRIAGE_RETURN = 13,
    SPACE = 32,
    BANG = 33,
    QUOTE = 34,
    HASH = 35,
    DOLLAR = 36,
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
    QUESTION = 63,
    AT = 64,
    UPPER_E = 69,
    LEFT_BRACKET = 91,
    BACKSLASH = 92,
    RIGHT_BRACKET = 93,
    CARET = 94,
    LOWER_E = 101,
    LEFT_BRACE = 123,
    PIPE = 124,
    RIGHT_BRACE = 125,
    DELETE = 127,
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
 * Whether a character is a control character the ObjectText grammar gives no meaning to. That is
 * every C0 code and the delete character, minus the tab, the line feed and the carriage return,
 * which are the three the game reads as spacing and which this lexer reads as spacing too.
 *
 * @param code the character's UTF-16 code unit.
 * @returns true for a control character that carries no grammar.
 */
const isControlCode = (code: number): boolean =>
    (code < CHAR.SPACE && code !== CHAR.TAB && code !== CHAR.NEWLINE && code !== CHAR.CARRIAGE_RETURN) ||
    code === CHAR.DELETE;

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
// The game's file tokenizer emits any character it has no grammar for as a token of its own, and
// the value is every token of the line joined, so these read as ordinary text on the right of an
// `=` (`A = Gun #2`, `A = a?b`, `A = Guns | Roses` all load). They are refused where a member name
// belongs, which the parser reports off the token that carries them.
for (const char of '$?`') VALUE_CHAR_CLASS[char.charCodeAt(0)] = VALUE_CHAR.ORDINARY;
// A control character is not spacing to the game either, so it stays inside the value the way any
// other stray character does: the shipped HalflingCore parser reads `A = 1␀` as the value `1␀` and
// `S = [1,␀ 2]` as the two elements `1` and `␀ 2`, and it answers the same for every other control
// character, the delete character included. Where one stands in front of a member name the parser
// reports it instead. These are what a file really picks up from a tool that wrote it wrong.
for (let code = 0; code <= CHAR.DELETE; code++) {
    if (isControlCode(code)) VALUE_CHAR_CLASS[code] = VALUE_CHAR.ORDINARY;
}
// A value character that can also mean something else, so the scanner asks before taking it. `#`
// and `|` are mXparser operators in one spelling and ordinary text in every other, and `@` opens a
// verbatim string only when a quote follows it.
for (const char of '-/^!#|@') VALUE_CHAR_CLASS[char.charCodeAt(0)] = VALUE_CHAR.CHECKED;
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

/**
 * The ASCII whitespace that produces no token and stays on its line, by character code. The newline
 * is absent on purpose: it ends a value, so the main loop settles it before reading this table.
 */
const INLINE_WHITESPACE = new Uint8Array(128);
// The game's tokenizer counts only tab, line feed, carriage return, space and backslash as
// spacing, so a vertical tab and a form feed are ordinary characters to it and belong in the
// value charset rather than here. The carriage return is absent for the same reason as the line
// feed: it ends a value, so the main loop settles it before this table is read.
for (const code of [CHAR.SPACE, CHAR.TAB]) {
    INLINE_WHITESPACE[code] = 1;
}

/** Matches the non-ASCII whitespace `\s` recognizes (NBSP, ideographic space, BOM, …). */
const NON_ASCII_WHITESPACE = new RegExp('[\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]');

/**
 * The characters that read as nothing on screen and that the game refuses wherever a member name
 * belongs. ObjectText's tokenizer counts only tab, line feed, carriage return, space and backslash
 * as spacing and only `[0-9A-Za-z_.]` as name text, so every one of these becomes a token of its
 * own and the file fails to load (`Unexpected " " at position Line=…`). Verified against the
 * shipped HalflingCore parser. Inside a value or a string the game keeps the character, so the
 * lexer only records it and the parser decides whether the position is fatal.
 */
const isInvisibleCode = (code: number): boolean =>
    isControlCode(code) ||
    code === 0x85 ||
    code === 0xa0 ||
    code === 0xad ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200f) ||
    (code >= 0x2028 && code <= 0x202f) ||
    code === 0x205f ||
    code === 0x2060 ||
    code === 0x3000 ||
    code === 0xfeff;

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
 * The character before `at`, with spaces and tabs skipped.
 *
 * @param input the document text.
 * @param at the offset to look back from.
 * @returns the character's code, or NaN before the start of the input.
 */
const codeBeforeSpaces = (input: string, at: number): number => {
    let i = at - 1;
    while (i >= 0) {
        const code = input.charCodeAt(i);
        if (code !== CHAR.SPACE && code !== CHAR.TAB) return code;
        i--;
    }
    return NaN;
};

/**
 * The character at or after `at`, with spaces and tabs skipped.
 *
 * @param input the document text.
 * @param at the offset to look forward from.
 * @returns the character's code, or NaN past the end of the input.
 */
const codeAfterSpaces = (input: string, at: number): number => {
    let i = at;
    while (i < input.length) {
        const code = input.charCodeAt(i);
        if (code !== CHAR.SPACE && code !== CHAR.TAB) return code;
        i++;
    }
    return NaN;
};

/**
 * Whether the `#` or `|` at `at` is written as the mXparser operator it can also be. Both are
 * ordinary text to the game's tokenizer, which is why `Gun #2`, `a#b` and `Guns | Roses` are values
 * it reads, and both compute when the value reaches the expression evaluator, which is why
 * `7 # 3` is 1 and `(0) | (3)` is 1. Only the spelling with whitespace on each side, a number or a
 * `)` on the left and a number or a `(` on the right is read as the operator, so the text forms
 * keep their character and the math forms keep their operator.
 *
 * @param input the document text.
 * @param at the offset of the `#` or `|`.
 * @returns true when the character ends the value and is lexed as an operator.
 */
const standsAsAssembledOperator = (input: string, at: number): boolean => {
    if (!isWhitespaceCode(input.charCodeAt(at - 1)) || !isWhitespaceCode(input.charCodeAt(at + 1))) return false;
    const before = codeBeforeSpaces(input, at);
    if (before !== CHAR.RIGHT_PAREN && !isDigitCode(before)) return false;
    const after = codeAfterSpaces(input, at + 1);
    return after === CHAR.LEFT_PAREN || isDigitCode(after);
};

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
 * which stays in the value. It is recognizable by its neighbors, directly preceded by `&` or `/`,
 * which an inheritance colon never is: there the `:` follows the inherited name or whitespace, as
 * in `Child : Parent` or `X : /BASE/Y`.
 *
 * The segment may also be the last one of the path. `&/Foo/:` and `&:` are both paths the shipped
 * HalflingCore parser accepts and resolves, while `&/Foo/:Bar` is one it refuses, so the colon
 * stays in the value when the path carries on with a `/` and when it ends on the colon, and hands
 * the colon back when a name follows it.
 *
 * @param input the document text.
 * @param at the offset of the `:`.
 * @returns true when the colon is a path segment.
 */
const isVirtualPathColon = (input: string, at: number): boolean => {
    const previous = input.charCodeAt(at - 1);
    if (previous !== CHAR.AMPERSAND && previous !== CHAR.SLASH) return false;
    const next = input.charCodeAt(at + 1);
    if (next === CHAR.SLASH) return true;
    // Past the end of the input, or on a character no value carries on with, the path ends here.
    return Number.isNaN(next) || (next < 128 && VALUE_CHAR_CLASS[next] === VALUE_CHAR.ENDS);
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
        case CHAR.HASH:
        case CHAR.PIPE:
            return !standsAsAssembledOperator(input, at);
        case CHAR.AT:
            // `@"…"` opens a verbatim string, which the game reads as its own token and joins to
            // the value without a separator. Everywhere else an `@` is ordinary value text.
            return input.charCodeAt(at + 1) !== CHAR.QUOTE;
        case CHAR.COLON:
            // Inside a `<…>` file path a colon is the drive letter's, not an inheritance colon.
            // `&<C:/x/y.rules>/Member` is a reference the game reads, and splitting the value on
            // the colon left `&<C` behind as a reference that is not valid.
            if (insideFilePath) return true;
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
 * Everything one lex run reads and writes. The scanners are module-level functions rather than
 * closures over the run, so the cursor, the run flags and the token list travel through this object.
 * Exactly one is built per {@link lexer} call, so nothing is allocated per character or per token.
 */
interface LexerState {
    /** The document text being scanned. */
    readonly input: string;
    /** The offset of the next character to read. */
    current: number;
    /** The zero-based line the cursor stands on. */
    lineNumber: number;
    /** The zero-based column the cursor stands on. */
    lineOffset: number;
    /** The tokens produced so far, in source order. */
    readonly tokens: Token[];
    /**
     * Tracks ObjectText value termination: an unsuppressed newline ends a field value. Mirrors the
     * game's `OTToken.IsUnsuppressedNewLine`, which evaluates the whole insignificant run
     * (whitespace + comments) between two real tokens: the run's newline is suppressed (line
     * continuation) iff a `\` appears before the first newline in that run. So once a `\` is seen
     * before any newline, the rest of the run (extra blank lines and `//` comment lines) is
     * suppressed too.
     */
    sawUnsuppressedNewline: boolean;
    /** Records a `\` seen in the current run before the run's first newline. */
    runSuppressed: boolean;
    /** Locks the current run's fate at its first newline. */
    runNewlineSeen: boolean;
    /** Where the block-comment spans are collected, when the caller asked for them. */
    readonly blockComments?: BlockCommentSpan[];
}

/**
 * Applies the run rule at a newline, the value-terminating newline of a whitespace run or of a `//`
 * comment. Only the first newline in a run decides: it terminates unless an earlier `\` suppressed it.
 *
 * @param state the lex state.
 */
const markNewline = (state: LexerState): void => {
    if (state.runNewlineSeen) return;
    state.runNewlineSeen = true;
    if (!state.runSuppressed) state.sawUnsuppressedNewline = true;
};

/**
 * Appends a token and closes the insignificant run in front of it.
 *
 * @param state the lex state.
 * @param token the token to append.
 */
const pushToken = (state: LexerState, token: Token): void => {
    if (state.sawUnsuppressedNewline) token.precededByNewline = true;
    state.sawUnsuppressedNewline = false;
    state.runSuppressed = false;
    state.runNewlineSeen = false;
    state.tokens.push(token);
};

/**
 * Emits the token one character stands for and steps over it. An operator keeps its own text,
 * which the parser reads back off the token, while a structural token is known by its type alone.
 *
 * @param state the lex state.
 * @param type the token type the character stands for.
 */
const pushSingleChar = (state: LexerState, type: TOKEN_TYPES): void => {
    const { input, current } = state;
    const value = type === TOKEN_TYPES.EXPRESSION ? input[current] : undefined;
    pushToken(state, createToken(type, state.lineOffset++, state.lineNumber, current, current + 1, value));
    state.current = current + 1;
};

/**
 * Skips a `// …` comment and the newline that ends it. That newline is part of the insignificant
 * run and follows the same rule as any other: it terminates the value unless an earlier `\` in the
 * run suppressed it (`"a"\ <newline> //comment <newline> "b"` is one continued string).
 *
 * @param state the lex state, positioned on the opening `/`.
 */
const skipLineComment = (state: LexerState): void => {
    const { input } = state;
    let current = state.current + 2;
    while (input[current] !== '\n') {
        current++;
        if (current >= input.length) {
            break;
        }
    }
    state.lineNumber++;
    state.lineOffset = 0;
    state.current = current + 1;
    markNewline(state);
};

/**
 * Skips a `/* … *\/` block comment, recording its span when the caller asked for the spans. The
 * opening `/*` is two columns like any other text: counting the comment's characters but not its
 * opener reported every token after it two columns early.
 *
 * A line break inside the comment is part of the insignificant run in front of the next token and
 * follows the same rule as any other, so it ends the value unless an earlier `\` suppressed it.
 * The game reads `A = 1 /* c <newline> *\/ 2` as a parse error on the `2` and reads the same text
 * with a `\` in front of the comment as the one value `1 2`.
 *
 * @param state the lex state, positioned on the opening `/`.
 */
const skipBlockComment = (state: LexerState): void => {
    const { input } = state;
    const commentStart = state.current;
    let current = commentStart + 2;
    let lineNumber = state.lineNumber;
    let lineOffset = state.lineOffset + 2;
    let closed = true;
    while (input[current] !== '*' || input[current + 1] !== '/') {
        if (input[current] === '\n') {
            markNewline(state);
            lineNumber++;
            lineOffset = 0;
        } else {
            // The newline itself starts the next line rather than sitting on it, so only a
            // character that is not one advances the column.
            lineOffset++;
        }
        current++;
        if (current >= input.length) {
            closed = false;
            break;
        }
    }
    state.current = current + 2;
    state.lineNumber = lineNumber;
    state.lineOffset = lineOffset + 2;
    state.blockComments?.push({ start: commentStart, end: Math.min(state.current, input.length), closed });
};

/**
 * Reads a verbatim string `@"…"` (ObjectText, C#-style): no `\` escapes, a doubled `""` is a
 * literal quote, and it may span newlines. It ends at the first lone `"`. The loop only counts
 * lines and finds boundaries, and the value is assembled from whole slices between `""` pairs
 * instead of one string concatenation per character.
 *
 * @param state the lex state, positioned on the `@`.
 */
const scanVerbatimString = (state: LexerState): void => {
    const { input } = state;
    const start = state.current;
    const lineOffsetBefore = state.lineOffset;
    let value = '';
    let current = start + 2;
    let lineNumber = state.lineNumber;
    let lineOffset = lineOffsetBefore + 2;
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
    if (!closed) {
        // No closing quote anywhere below, so the game refuses the file (`Unexpected "￿"`).
        // Running to the end of the input would hand every remaining member to this one value and
        // leave the outline, completion and every whole-file check working on a document that lost
        // them. End the token at the end of its own line instead, the way the plain-string scanner
        // does, and let the parser report the missing quote on the `@`.
        const lineEnd = input.indexOf('\n', start);
        current = lineEnd === -1 ? input.length : lineEnd;
        lineNumber = state.lineNumber;
        lineOffset = lineOffsetBefore + (current - start);
        value = input.slice(start + 2, current);
    }
    state.current = current;
    state.lineNumber = lineNumber;
    state.lineOffset = lineOffset;
    const token = createToken(TOKEN_TYPES.STRING, lineOffsetBefore, lineNumber, start, current, value);
    if (!closed) {
        token.unterminatedString = true;
        token.verbatimString = true;
    }
    pushToken(state, token);
};

/**
 * Reads a plain `"…"` string. A `\` escapes the next character (whatever it is), so `\\` is a
 * literal backslash and the quote that follows it closes the string. Tracking the escape explicitly
 * is what keeps a string ending in `\\` (e.g. `"\\"`) from running past its closing quote and
 * swallowing the rest of the file. The value keeps escape sequences raw, so it is exactly the input
 * between the quotes: the loop only counts lines and finds the closing quote, and the value is
 * sliced once.
 *
 * @param state the lex state, positioned on the opening quote.
 */
const scanQuotedString = (state: LexerState): void => {
    const { input } = state;
    const start = state.current;
    const lineOffsetBefore = state.lineOffset;
    let current = start + 1;
    // A plain string never crosses a line break now that a `\` in front of one ends it, so the
    // token stays on the line it opened on.
    const lineNumber = state.lineNumber;
    let lineOffset = lineOffsetBefore + 1;
    let contentEnd = input.length;
    let unterminated = false;
    while (current < input.length) {
        const code = input.charCodeAt(current);
        if (code === CHAR.BACKSLASH) {
            const escaped = input.charCodeAt(current + 1);
            // The game's in-string escape takes any character except a line break, so a `\` at the
            // end of the line is not a continuation inside a quoted value. ObjectText throws
            // `Unexpected "\n"` on it and refuses the whole file, verified against the shipped
            // HalflingCore parser. End the string here so the missing quote is reported on the
            // opening quote and the rest of the file is read as ordinary rules. The backslash
            // itself is consumed, or the lexer's line-continuation rule would suppress the very
            // line break that ends the value.
            if (escaped === CHAR.NEWLINE || escaped === CHAR.CARRIAGE_RETURN) {
                contentEnd = current;
                current++;
                lineOffset++;
                unterminated = true;
                break;
            }
            current++;
            lineOffset++;
            if (current < input.length) {
                current++;
                lineOffset++;
            }
            continue;
        }
        if (code === CHAR.QUOTE) {
            contentEnd = current;
            current++;
            lineOffset++;
            break;
        }
        if (code === CHAR.NEWLINE) {
            // The game's tokenizer ends a plain string at the line break and reports the missing
            // quote there. Running on would hand the rest of the file to one string: typing an
            // opening quote in front of an existing word used to swallow hundreds of lines and bury
            // the file in errors far from the edit.
            contentEnd = current;
            unterminated = true;
            break;
        }
        lineOffset++;
        current++;
    }
    if (current >= input.length && contentEnd === input.length) unterminated = true;
    state.current = current;
    state.lineNumber = lineNumber;
    state.lineOffset = lineOffset;
    const value = input.slice(start + 1, Math.min(contentEnd, current));
    const token = createToken(TOKEN_TYPES.STRING, lineOffsetBefore, lineNumber, start, current, value);
    if (unterminated) token.unterminatedString = true;
    pushToken(state, token);
};

/**
 * Reads an unquoted value, every character up to the one that ends it. The loop consumes contiguous
 * input, so the text is sliced once at the end rather than accumulated character by character.
 *
 * @param state the lex state, positioned on the value's first character.
 */
const scanValue = (state: LexerState): void => {
    const { input } = state;
    const start = state.current;
    const lineOffsetBefore = state.lineOffset;
    let current = start;
    let lineOffset = lineOffsetBefore;
    // Whether every character consumed so far is a digit, space, or decimal point (the number
    // predicate the `!`-factorial and `<number>/` checks need). Tracked incrementally so the loop
    // does not re-scan the whole accumulated value on each character.
    let numberSoFar = true;
    // Whether an actual digit was consumed. The `<number>/` division split requires it so that
    // dot-only prefixes stay whole: `../Ref` and `./Data/…` are paths, not division, while
    // `0.065/1.75` and `.5/2` are division and must split.
    let sawDigit = false;
    // Whether the scanner stands inside a `<…>` file-path segment of a reference, where a
    // backslash is a path separator rather than whitespace.
    let insideFilePath = false;
    // Where the first character that reads as nothing on screen sits, so the parser can report it
    // when the token turns out to name a member. The guard in front of the test keeps the common
    // printable range to two comparisons.
    let invisibleAt = -1;
    for (;;) {
        const valueCode = input.charCodeAt(current);
        const kind = valueCode < 128 ? VALUE_CHAR_CLASS[valueCode] : VALUE_CHAR.ORDINARY;
        if (kind === VALUE_CHAR.ENDS) break;
        if (invisibleAt < 0 && (valueCode < CHAR.SPACE || valueCode > 126) && isInvisibleCode(valueCode)) {
            invisibleAt = current;
        }
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
            // Keep the column counter in step with `current`. Without this every token after a
            // `<number>/…` split (e.g. `1/16`) is reported one column too early.
            lineOffset++;
            break;
        }
        current++;
        lineOffset++;
        if (current >= input.length) break;
    }
    state.current = current;
    state.lineOffset = lineOffset;
    const untrimmedValue = input.slice(start, current);
    const value = untrimmedValue.trim();
    const token = createToken(
        TOKEN_TYPES.VALUE,
        lineOffsetBefore,
        state.lineNumber,
        start,
        current - (untrimmedValue.length - value.length),
        value
    );
    if (invisibleAt >= 0) {
        token.invisibleChar = input.charCodeAt(invisibleAt);
        token.invisibleCharStart = invisibleAt;
    }
    pushToken(state, token);
};

/**
 * Reads a `true`/`false` keyword when one stands whole at the cursor. They are keywords only as
 * whole words: a value that merely begins with one (`truest`, and localized prose such as
 * `falsely`) is a single value to the game, so the character after the keyword has to be one no
 * value could continue with.
 *
 * @param state the lex state, positioned on the candidate keyword.
 * @returns true when a keyword token was emitted and the cursor moved past it.
 */
const scanKeyword = (state: LexerState): boolean => {
    const { input, current } = state;
    let length: number;
    let type: TOKEN_TYPES;
    if (input.startsWith('true', current) && keywordEndsAt(input, current + 4)) {
        length = 4;
        type = TOKEN_TYPES.TRUE;
    } else if (input.startsWith('false', current) && keywordEndsAt(input, current + 5)) {
        length = 5;
        type = TOKEN_TYPES.FALSE;
    } else {
        return false;
    }
    pushToken(state, createToken(type, state.lineOffset, state.lineNumber, current, current + length));
    state.lineOffset += length;
    state.current = current + length;
    return true;
};

/**
 * Emits the token for a character the grammar has no place for, and steps over it. The column
 * advances with it: without that every unexpected character shifted the tokens after it on the line
 * one column left, misplacing their diagnostics and breaking the parser's source-adjacency check
 * for assembled operators such as `@&` or `||`.
 *
 * @param state the lex state, positioned on the character.
 */
const pushUnexpected = (state: LexerState): void => {
    const { input, current } = state;
    // Only under 'verbose'. An UNEXPECTED token is emitted regardless, and parsing the whole game
    // tree (find-all-references) would otherwise spew thousands of these.
    if (globalSettings.trace.server === 'verbose') console.warn('unexcpected', input[current]);
    pushToken(
        state,
        createToken(TOKEN_TYPES.UNEXPECTED, state.lineOffset, state.lineNumber, current, current + 1, input[current])
    );
    state.lineOffset++;
    state.current = current + 1;
};

/**
 * The state one lex run starts from.
 *
 * @param input the document text.
 * @param blockComments where the block-comment spans are collected, when the caller asked for them.
 * @returns the fresh state.
 */
const newLexerState = (input: string, blockComments?: BlockCommentSpan[]): LexerState => ({
    input,
    current: 0,
    lineNumber: 0,
    lineOffset: 0,
    tokens: [],
    sawUnsuppressedNewline: false,
    runSuppressed: false,
    runNewlineSeen: false,
    blockComments,
});

/**
 * Turns rules source into the token stream the parser consumes.
 *
 * @param input the document text.
 * @param blockComments when given, every block comment the lexer skips is appended to it in source
 * order. Omitted, comment spans are not collected.
 * @returns the tokens, comments and whitespace excluded.
 */
export const lexer = (input: string, blockComments?: BlockCommentSpan[]): Token[] => {
    const state = newLexerState(input, blockComments);
    while (state.current < input.length) {
        const code = input.charCodeAt(state.current);

        // The two characters whose meaning depends on what follows them, settled before the table
        // below, together with whitespace, which produces no token at all.
        switch (code) {
            case CHAR.SLASH:
                if (input.charCodeAt(state.current + 1) === CHAR.SLASH) {
                    skipLineComment(state);
                    continue;
                }
                if (input.charCodeAt(state.current + 1) === CHAR.STAR) {
                    skipBlockComment(state);
                    continue;
                }
                // A `/` that opens no comment is the division operator.
                pushSingleChar(state, TOKEN_TYPES.EXPRESSION);
                continue;
            case CHAR.CARET:
                // `^` is mXparser exponentiation except when it begins a `^/…` super-path reference
                // (inheritance), which stays inside the VALUE token below. The value scanner guards
                // the same disambiguation, so `2^8` splits but `^/0/Part` does not.
                if (input.charCodeAt(state.current + 1) !== CHAR.SLASH) {
                    pushSingleChar(state, TOKEN_TYPES.EXPRESSION);
                    continue;
                }
                break;
            case CHAR.NEWLINE:
                // A `\` earlier in this whitespace/comment run (before the run's first newline)
                // suppresses it as an ObjectText line continuation; otherwise it terminates the value.
                markNewline(state);
                state.lineNumber++;
                state.lineOffset = 0;
                state.current++;
                continue;
            case CHAR.CARRIAGE_RETURN:
                // ObjectText's tokenizer ends a line at a carriage return as readily as at a line
                // feed, so a file written with lone `\r` breaks carries one member per return and
                // not one value that swallows all of them. A `\r\n` pair is one line break, so the
                // line feed of a pair is stepped over here rather than counted again.
                markNewline(state);
                state.lineNumber++;
                state.lineOffset = 0;
                state.current++;
                if (input.charCodeAt(state.current) === CHAR.NEWLINE) state.current++;
                continue;
            case CHAR.SPACE:
            case CHAR.TAB: {
                // The whole run of inline whitespace at once, so a line of indentation costs one
                // write-back rather than one per space.
                let at = state.current;
                let column = state.lineOffset;
                do {
                    at++;
                    column++;
                } while (at < input.length && INLINE_WHITESPACE[input.charCodeAt(at)] === 1);
                state.current = at;
                state.lineOffset = column;
                continue;
            }
        }

        // Every character whose code alone fixes what it means: the structural tokens and the
        // operators. One table read replaces the chain of comparisons this used to be, which the
        // lexer ran for every character of every file a project walk parses.
        const single = code < 128 ? SINGLE_CHAR_TOKEN[code] : undefined;
        if (single !== undefined) {
            pushSingleChar(state, single);
            continue;
        }

        // A byte-order mark opening the file is the one invisible character the game skips, so it
        // produces no token here either. Anywhere else it is a token to the game and the value
        // scanner below picks it up like any other invisible character.
        if (code === 0xfeff && state.current === 0) {
            state.current++;
            continue;
        }

        if (code === CHAR.AT && input.charCodeAt(state.current + 1) === CHAR.QUOTE) {
            scanVerbatimString(state);
            continue;
        }

        if (code === CHAR.QUOTE) {
            scanQuotedString(state);
            continue;
        }

        if (scanKeyword(state)) continue;

        // A `#` or `|` in its operator spelling carries no value text, so it is handed to the
        // parser on its own, which assembles it with its neighbours (`||`, `@&`, …). Every other
        // spelling belongs to the value the scanner below reads.
        if ((code === CHAR.HASH || code === CHAR.PIPE) && standsAsAssembledOperator(input, state.current)) {
            pushUnexpected(state);
            continue;
        }

        const valueClass = code < 128 ? VALUE_CHAR_CLASS[code] : VALUE_CHAR.ORDINARY;
        if (valueClass === VALUE_CHAR.ORDINARY || valueClass === VALUE_CHAR.CHECKED) {
            scanValue(state);
            continue;
        }
        // `\` is whitespace in ObjectText, and a `\` before the run's first newline is a line
        // continuation that suppresses the value-terminating newline for the rest of the run (a `\`
        // after a newline comes too late and does not suppress). Skip the backslash.
        if (code === CHAR.BACKSLASH) {
            if (!state.runNewlineSeen) state.runSuppressed = true;
            state.lineOffset++;
            state.current++;
            continue;
        }
        pushUnexpected(state);
    }

    return state.tokens;
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
    /**
     * True when a plain `"…"` string reached the end of its line without a closing quote. The game's
     * tokenizer ends such a string at the newline and reports it there, so the rest of the file is
     * read as ordinary rules. Carrying the fact on the token lets the parser report it on the
     * opening quote, where the missing quote belongs.
     */
    unterminatedString?: boolean;
    /**
     * True when the unterminated string is a verbatim `@"…"` one. A verbatim string may legitimately
     * span line breaks, so the advice that closes a plain string is wrong for it and the parser
     * picks the wording off this flag.
     */
    verbatimString?: boolean;
    /**
     * The first invisible character the token carries, as its code point. The game reads only tab,
     * space, carriage return, line feed and backslash as spacing, so a no-break space or a
     * zero-width character is a token of its own there and makes the whole file fail to load
     * wherever a member name is expected. Inside a value the game keeps it, which is why the fact
     * travels on the token and the parser decides whether the position is fatal.
     */
    invisibleChar?: number;
    /** The offset the {@link invisibleChar} sits at, so the report lands on the character itself. */
    invisibleCharStart?: number;
}
