/**
 * Whitespace-only formatter for `.rules` documents (including `mod.rules` and its actions, which
 * are the same ObjectText syntax).
 *
 * ObjectText makes classic pretty-printing dangerous: unquoted values may contain spaces
 * (`Name = Big Gun`), a newline terminates a value unless a `\` suppressed it, `10 - 3` and `10-3`
 * lex differently, and comments are not tokens. So this formatter never moves, merges or splits
 * tokens. It lexes the document with the real lexer, treats every token, comment and `\`
 * continuation as an untouchable span, and rewrites only the whitespace around them:
 *
 * - line indentation from `{`/`[` nesting (tab or spaces per the editor options), with value
 *   continuation lines indented one extra level,
 * - exactly one space around `=` and the inheritance `:`, none before and one after `,`/`;`,
 *   none inside `(…)`/`[…]`, one inside an inline `{ … }`,
 * - trailing whitespace removed, runs of blank lines capped, exactly one final newline.
 *
 * Lines that begin inside a multi-line string or block comment are preserved verbatim. As a final
 * guarantee the result is lexed again and must produce the identical token stream (and identical
 * comments), otherwise the formatter returns null and the document is left untouched.
 */
import { lexer, Token, TOKEN_TYPES } from '../../core/lexer/lexer';

export interface RulesFormattingOptions {
    tabSize: number;
    insertSpaces: boolean;
}

/** The maximum run of consecutive blank lines the formatter keeps. */
const MAX_BLANK_LINES = 2;

type SpanKind = 'token' | 'lineComment' | 'blockComment' | 'continuation';

interface Span {
    start: number;
    end: number;
    kind: SpanKind;
    token?: Token;
    /** Index into the token stream, set for `token` spans. */
    tokenIndex?: number;
}

/**
 * Collect the untouchable spans of the document: every lexer token plus the comments and `\`
 * line continuations the lexer skips over (found by scanning the gaps between tokens).
 *
 * @param text the full document text.
 * @param tokens the lexer's token stream for that text.
 * @returns all spans in document order, or null when a gap holds something unexpected.
 */
const collectSpans = (text: string, tokens: Token[]): Span[] | null => {
    const spans: Span[] = [];
    let cursor = 0;
    const scanGap = (from: number, to: number): boolean => {
        let i = from;
        while (i < to) {
            const c = text[i];
            if (c === '/' && text[i + 1] === '/') {
                let end = i;
                while (end < to && text[end] !== '\n') end++;
                spans.push({ start: i, end, kind: 'lineComment' });
                i = end;
                continue;
            }
            if (c === '/' && text[i + 1] === '*') {
                let end = i + 2;
                while (end < to && !(text[end] === '*' && text[end + 1] === '/')) end++;
                end = Math.min(end + 2, to);
                spans.push({ start: i, end, kind: 'blockComment' });
                i = end;
                continue;
            }
            if (c === '\\') {
                spans.push({ start: i, end: i + 1, kind: 'continuation' });
                i++;
                continue;
            }
            if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v' || c.charCodeAt(0) > 127) {
                i++;
                continue;
            }
            return false;
        }
        return true;
    };
    for (let t = 0; t < tokens.length; t++) {
        const token = tokens[t];
        if (!scanGap(cursor, token.start)) return null;
        const end = token.end ?? token.start + 1;
        spans.push({ start: token.start, end, kind: 'token', token, tokenIndex: t });
        cursor = end;
    }
    if (!scanGap(cursor, text.length)) return null;
    return spans;
};

/**
 * The whitespace a same-line gap between two tokens should become.
 *
 * @param left the token type before the gap.
 * @param right the token type after the gap.
 * @param original the gap's current text.
 * @returns the normalized gap. An empty gap is only widened around structural punctuation, and a
 * non-empty gap is never emptied next to a value, so token boundaries can never merge.
 */
const desiredGap = (left: TOKEN_TYPES, right: TOKEN_TYPES, original: string): string => {
    // A space is a value character, so two unquoted values separated by a tab would merge into one
    // token if the tab became a space. Keep such gaps exactly as written.
    const valueLike = (t: TOKEN_TYPES): boolean =>
        t === TOKEN_TYPES.VALUE || t === TOKEN_TYPES.TRUE || t === TOKEN_TYPES.FALSE;
    if (left === TOKEN_TYPES.VALUE && valueLike(right)) return original;
    if (left === TOKEN_TYPES.LEFT_BRACE && right === TOKEN_TYPES.RIGHT_BRACE) {
        return original.length ? ' ' : '';
    }
    if (right === TOKEN_TYPES.COMMA || right === TOKEN_TYPES.SEMICOLON) return '';
    if (left === TOKEN_TYPES.LEFT_PAREN || right === TOKEN_TYPES.RIGHT_PAREN) return '';
    if (left === TOKEN_TYPES.LEFT_BRACKET || right === TOKEN_TYPES.RIGHT_BRACKET) return '';
    if (left === TOKEN_TYPES.COMMA || left === TOKEN_TYPES.SEMICOLON) return ' ';
    if (left === TOKEN_TYPES.EQUALS || right === TOKEN_TYPES.EQUALS) return ' ';
    if (left === TOKEN_TYPES.COLON || right === TOKEN_TYPES.COLON) return ' ';
    if (left === TOKEN_TYPES.LEFT_BRACE || right === TOKEN_TYPES.RIGHT_BRACE) return ' ';
    if (right === TOKEN_TYPES.LEFT_BRACE) return ' ';
    return original.length ? ' ' : '';
};

const isOpener = (type: TOKEN_TYPES): boolean =>
    type === TOKEN_TYPES.LEFT_BRACE || type === TOKEN_TYPES.LEFT_BRACKET;
const isCloser = (type: TOKEN_TYPES): boolean =>
    type === TOKEN_TYPES.RIGHT_BRACE || type === TOKEN_TYPES.RIGHT_BRACKET;

interface Line {
    /** Offset of the line's first character. */
    start: number;
    /** Offset of the terminating `\n` (or the text length for the last line). */
    end: number;
}

/**
 * Split the text into lines by `\n`, keeping offsets into the original text.
 *
 * @param text the document text.
 * @returns the line table.
 */
const splitLines = (text: string): Line[] => {
    const lines: Line[] = [];
    let start = 0;
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\n') {
            lines.push({ start, end: i });
            start = i + 1;
        }
    }
    lines.push({ start, end: text.length });
    return lines;
};

/** Extract every comment's content for the preservation check, line comments trimmed at the end. */
const commentContents = (text: string, spans: Span[]): string[] =>
    spans
        .filter((s) => s.kind === 'lineComment' || s.kind === 'blockComment')
        .map((s) => (s.kind === 'lineComment' ? text.slice(s.start, s.end).trimEnd() : text.slice(s.start, s.end)));

/**
 * Verify the formatted text is still the same document: identical token stream (type, value and
 * value-terminating newline structure) and identical comments.
 *
 * @param original the text before formatting.
 * @param originalTokens the token stream of the original text.
 * @param originalSpans the span table of the original text.
 * @param formatted the formatter's output.
 * @returns true when the two texts are lexically equivalent.
 */
const isEquivalent = (original: string, originalTokens: Token[], originalSpans: Span[], formatted: string): boolean => {
    const newTokens = lexer(formatted);
    if (newTokens.length !== originalTokens.length) return false;
    for (let i = 0; i < newTokens.length; i++) {
        const a = originalTokens[i];
        const b = newTokens[i];
        if (a.type !== b.type || (a.value ?? '') !== (b.value ?? '')) return false;
        if (!!a.precededByNewline !== !!b.precededByNewline) return false;
    }
    const newSpans = collectSpans(formatted, newTokens);
    if (!newSpans) return false;
    const oldComments = commentContents(original, originalSpans);
    const newComments = commentContents(formatted, newSpans);
    return oldComments.length === newComments.length && oldComments.every((c, i) => c === newComments[i]);
};

/**
 * Format a `.rules` document.
 *
 * @param text the full document text.
 * @param options indentation preferences from the editor.
 * @returns the formatted text (identical to the input when nothing changes), or null when the
 * document cannot be formatted safely because the result would not be lexically identical.
 */
export const formatRulesDocument = (text: string, options: RulesFormattingOptions): string | null => {
    if (!text.trim()) return text;
    const tokens = lexer(text);
    const spans = collectSpans(text, tokens);
    if (!spans) return null;

    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const indentUnit = options.insertSpaces ? ' '.repeat(Math.max(1, options.tabSize)) : '\t';
    const lines = splitLines(text);

    // Depth of `{`/`[` nesting in front of each token, in token order. A closing token is recorded
    // at the already-decremented depth, which is exactly the indent its line should get.
    const depthBefore: number[] = [];
    let depth = 0;
    for (const token of tokens) {
        if (isCloser(token.type)) depth = Math.max(0, depth - 1);
        depthBefore.push(depth);
        if (isOpener(token.type)) depth++;
    }

    interface RenderedLine {
        content: string;
        /** True when the line is blank and outside any span or `\`-suppressed run, so it may collapse. */
        blank: boolean;
    }

    /** Strip the `\r` a CRLF terminator leaves at the end of a sliced line, it is re-added via eol. */
    const dropCr = (s: string): string => (s.endsWith('\r') ? s.slice(0, -1) : s);

    const rendered: RenderedLine[] = [];
    let spanIndex = 0;
    for (const line of lines) {
        const raw = dropCr(text.slice(line.start, line.end));
        while (spanIndex < spans.length && spans[spanIndex].end <= line.start) spanIndex++;
        const lineSpans: Span[] = [];
        for (let i = spanIndex; i < spans.length && spans[i].start < line.end; i++) lineSpans.push(spans[i]);

        // A line beginning inside a multi-line string or block comment is preserved verbatim, its
        // leading whitespace is string content (or comment art) that must not be re-indented.
        if (lineSpans.length && lineSpans[0].start < line.start) {
            rendered.push({ content: raw, blank: false });
            continue;
        }

        if (lineSpans.length === 0) {
            // Blank line. It may collapse unless it sits in a `\`-suppressed run, recognizable by
            // the next token continuing the previous line's value despite the intervening newline.
            let nextToken: Token | undefined;
            for (let i = spanIndex; i < spans.length; i++) {
                if (spans[i].kind === 'token') {
                    nextToken = spans[i].token;
                    break;
                }
            }
            const suppressed = nextToken !== undefined && nextToken !== tokens[0] && !nextToken.precededByNewline;
            rendered.push({ content: suppressed ? raw : '', blank: !suppressed });
            continue;
        }

        // Indentation from the structural depth at the line's first token. A comment-only line uses
        // the depth of the next token after it (one level deeper when that token closes a group, the
        // comment still belongs inside it). A line whose first token continues the previous line's
        // value (its newline was `\`-suppressed) gets one extra level.
        const firstTokenSpan = lineSpans.find((s) => s.kind === 'token');
        let lineDepth = 0;
        if (firstTokenSpan?.tokenIndex !== undefined) {
            lineDepth = depthBefore[firstTokenSpan.tokenIndex];
        } else {
            for (let i = spanIndex; i < spans.length; i++) {
                if (spans[i].kind === 'token') {
                    const idx = spans[i].tokenIndex as number;
                    lineDepth = depthBefore[idx] + (isCloser(tokens[idx].type) ? 1 : 0);
                    break;
                }
            }
        }
        const leadToken = lineSpans[0].kind === 'token' ? lineSpans[0].token : undefined;
        if (leadToken && leadToken !== tokens[0] && !leadToken.precededByNewline) lineDepth++;

        let content = indentUnit.repeat(Math.max(0, lineDepth));
        for (let i = 0; i < lineSpans.length; i++) {
            const span = lineSpans[i];
            if (i > 0) {
                const prevSpan = lineSpans[i - 1];
                const gap = text.slice(prevSpan.end, span.start);
                if (prevSpan.kind === 'token' && span.kind === 'token' && prevSpan.token && span.token) {
                    content += desiredGap(prevSpan.token.type, span.token.type, gap);
                } else {
                    content += gap;
                }
            }
            let piece = text.slice(span.start, Math.min(span.end, line.end));
            if (span.kind === 'lineComment') piece = piece.trimEnd();
            // A span running past the line end (multi-line string or block comment) freezes the
            // rest of the line, nothing after it may be trimmed.
            if (span.end > line.end) piece = dropCr(piece);
            content += piece;
        }
        rendered.push({ content, blank: false });
    }

    // Cap blank-line runs and drop trailing blank lines, then terminate with exactly one EOL.
    const output: string[] = [];
    let blankRun = 0;
    for (const line of rendered) {
        if (line.blank) {
            blankRun++;
            if (blankRun <= MAX_BLANK_LINES) output.push('');
            continue;
        }
        blankRun = 0;
        output.push(line.content);
    }
    while (output.length && output[output.length - 1] === '') output.pop();
    const formatted = output.join(eol) + eol;

    if (formatted === text) return text;
    if (!isEquivalent(text, tokens, spans, formatted)) return null;
    return formatted;
};
