/**
 * Whitespace-only formatter for `.shader` files (HLSL). It re-indents lines from `{}` nesting,
 * trims trailing whitespace, caps blank-line runs and normalizes the final newline. It never
 * touches anything inside a line: spacing between HLSL tokens, strings and comments stay exactly
 * as written, so the code cannot change meaning.
 *
 * Kept verbatim: lines inside a block comment (comment art), lines continuing a preprocessor
 * macro (after a trailing `\`). Preprocessor directives themselves go to column 0, HLSL style.
 */

export interface ShaderFormattingOptions {
    tabSize: number;
    insertSpaces: boolean;
}

/** The maximum run of consecutive blank lines the formatter keeps. */
const MAX_BLANK_LINES = 2;

interface ScanState {
    /** Brace nesting depth at the current position. */
    depth: number;
    /** Parenthesis nesting depth, used to indent wrapped argument lists one extra level. */
    parens: number;
    /** True while inside a block comment. */
    inBlockComment: boolean;
}

/**
 * Advance the scan state over one line, counting braces and parens outside strings and comments.
 *
 * @param line the line's text without its terminator.
 * @param state the state at the line's start, mutated to the state at its end.
 */
const scanLine = (line: string, state: ScanState): void => {
    let inString = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (state.inBlockComment) {
            if (c === '*' && line[i + 1] === '/') {
                state.inBlockComment = false;
                i++;
            }
            continue;
        }
        if (inString) {
            if (c === '\\') i++;
            else if (c === '"') inString = false;
            continue;
        }
        if (c === '"') inString = true;
        else if (c === '/' && line[i + 1] === '/') return;
        else if (c === '/' && line[i + 1] === '*') {
            state.inBlockComment = true;
            i++;
        } else if (c === '{') state.depth++;
        else if (c === '}') state.depth = Math.max(0, state.depth - 1);
        else if (c === '(') state.parens++;
        else if (c === ')') state.parens = Math.max(0, state.parens - 1);
    }
};

/**
 * Format a `.shader` document.
 *
 * @param text the full document text.
 * @param options indentation preferences from the editor.
 * @returns the formatted text, identical to the input when nothing changes.
 */
export const formatShaderDocument = (text: string, options: ShaderFormattingOptions): string => {
    if (!text.trim()) return text;
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const indentUnit = options.insertSpaces ? ' '.repeat(Math.max(1, options.tabSize)) : '\t';
    const lines = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
    // Drop the empty pseudo-line a trailing newline produces, the final newline is re-added below.
    if (lines.length && lines[lines.length - 1] === '') lines.pop();

    const state: ScanState = { depth: 0, parens: 0, inBlockComment: false };
    let previousEndedWithBackslash = false;
    const output: string[] = [];
    let blankRun = 0;

    for (const line of lines) {
        const startedInBlockComment = state.inBlockComment;
        const startDepth = state.depth;
        const startParens = state.parens;
        const trimmed = line.trim();
        scanLine(line, state);
        const endsWithBackslash = !startedInBlockComment && trimmed.endsWith('\\');

        // Lines inside a block comment and macro continuation lines are preserved verbatim (only
        // right-trimmed), their internal alignment is intentional.
        if (startedInBlockComment || previousEndedWithBackslash) {
            previousEndedWithBackslash = endsWithBackslash;
            blankRun = 0;
            output.push(line.replace(/[ \t]+$/, ''));
            continue;
        }
        previousEndedWithBackslash = endsWithBackslash;

        if (!trimmed) {
            blankRun++;
            if (blankRun <= MAX_BLANK_LINES) output.push('');
            continue;
        }
        blankRun = 0;

        if (trimmed.startsWith('#')) {
            output.push(trimmed);
            continue;
        }

        let lineDepth = startDepth;
        if (trimmed.startsWith('}')) lineDepth = Math.max(0, lineDepth - 1);
        // Continuation of a wrapped expression or argument list gets one extra level.
        if (startParens > 0) lineDepth++;
        output.push(indentUnit.repeat(lineDepth) + trimmed);
    }

    while (output.length && output[output.length - 1] === '') output.pop();
    const formatted = output.join(eol) + eol;
    return formatted === text ? text : formatted;
};
