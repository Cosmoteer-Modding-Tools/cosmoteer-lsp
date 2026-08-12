import { FoldingRange, FoldingRangeKind } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
    AbstractNode,
    AbstractNodeDocument,
    GroupNode,
    ListNode,
    isAssignmentNode,
    isGroupNode,
    isListNode,
} from '../../core/ast/ast';
import { BlockCommentSpan, Token } from '../../core/lexer/lexer';
import { enclosingRange } from '../navigation/ast-range';

/**
 * Folding ranges (`textDocument/foldingRange`) for `.rules` documents.
 *
 * Two things fold: the body of every `{ … }` / `[ … ]` container, and every comment covering more
 * than one line. A container fold stops one line above the closer, because the protocol folds
 * through the last character of `endLine`, and a collapsed body only reads as a pair when its
 * closing brace is still on screen.
 *
 * Containers come from the AST, comments from the lexer. A comment produces no token, and a `//`
 * only opens one when nothing else already claims those two characters, so which lines are comment
 * lines is decided from the token and comment spans rather than from the text: an ObjectText string
 * may run across lines, which no text scan could see.
 */

/** The fold of one container body, or nothing when the body does not outlive its opening line. */
const containerFold = (container: GroupNode | ListNode, document: TextDocument): FoldingRange | undefined => {
    const { line, start, end } = container.position;
    // `end` is the offset one past the closer and stays at its `0` default when the parser never saw
    // one. The closer's line is the one thing the position does not record, so it is read back from
    // the text and the fold stops above it. An unclosed container has no closer to keep on screen,
    // so its body ends where the envelope of its members ends.
    const endLine = end > start ? document.positionAt(end - 1).line - 1 : enclosingRange(container).end.line;
    if (endLine <= line) return undefined;
    return { startLine: line, endLine };
};

/**
 * Report every container of a subtree. Only a container or the assignment that introduces one can
 * hold another, so math and function-call values are not descended into.
 */
const collectContainers = (
    node: AbstractNode | null | undefined,
    found: (container: GroupNode | ListNode) => void
): void => {
    if (!node) return;
    if (isGroupNode(node) || isListNode(node)) {
        found(node);
        node.elements.forEach((element) => collectContainers(element, found));
        return;
    }
    if (isAssignmentNode(node)) collectContainers(node.right, found);
};

/** The fold of one block comment, dropped when it opens and closes on one line. */
const blockCommentFold = (span: BlockCommentSpan, document: TextDocument): FoldingRange | undefined => {
    const startLine = document.positionAt(span.start).line;
    const endLine = document.positionAt(Math.max(span.end - 1, span.start)).line;
    if (endLine <= startLine) return undefined;
    return { startLine, endLine, kind: FoldingRangeKind.Comment };
};

/** The source spans a `//` cannot open a comment in: every token and every block comment. */
const claimedSpans = (tokens: Token[], blockComments: BlockCommentSpan[]): Array<{ start: number; end: number }> => {
    const spans: Array<{ start: number; end: number }> = tokens.map((token) => ({
        start: token.start,
        end: token.end ?? token.start + 1,
    }));
    for (const comment of blockComments) spans.push({ start: comment.start, end: comment.end });
    return spans.sort((a, b) => a.start - b.start);
};

/**
 * The folds of the `//` banners a rules file separates its sections with: every run of two or more
 * lines carrying nothing but a line comment. A `//` inside a string or inside a block comment opens
 * nothing, and both of those may run across lines, so a line counts only when the lexer left those
 * two characters unclaimed.
 */
const lineCommentFolds = (text: string, tokens: Token[], blockComments: BlockCommentSpan[]): FoldingRange[] => {
    const spans = claimedSpans(tokens, blockComments);
    const folds: FoldingRange[] = [];
    let spanIndex = 0;
    let runStart = -1;
    let runEnd = -1;
    const closeRun = () => {
        if (runEnd > runStart) folds.push({ startLine: runStart, endLine: runEnd, kind: FoldingRangeKind.Comment });
        runStart = -1;
        runEnd = -1;
    };
    let lineStart = 0;
    for (let line = 0; lineStart <= text.length; line++) {
        const newline = text.indexOf('\n', lineStart);
        const lineEnd = newline === -1 ? text.length : newline;
        let at = lineStart;
        while (at < lineEnd && (text[at] === ' ' || text[at] === '\t' || text[at] === '\r')) at++;
        // Lines and spans are both walked in source order and no two spans overlap, so one cursor
        // over the spans answers every line.
        while (spanIndex < spans.length && spans[spanIndex].end <= at) spanIndex++;
        const claimed = spanIndex < spans.length && spans[spanIndex].start <= at;
        if (!claimed && text.startsWith('//', at)) {
            if (runStart < 0) runStart = line;
            runEnd = line;
        } else {
            closeRun();
        }
        if (newline === -1) break;
        lineStart = newline + 1;
    }
    closeRun();
    return folds;
};

/**
 * The folding ranges of one `.rules` document.
 *
 * @param document the open document, read for the line a source offset falls on.
 * @param parserResult the parsed AST of that same text.
 * @param tokens the lexer tokens of that same text.
 * @param blockComments the block-comment spans the lexer collected for that text.
 * @returns one fold per multi-line container body and per multi-line comment.
 */
export const computeFoldingRanges = (
    document: TextDocument,
    parserResult: AbstractNodeDocument,
    tokens: Token[],
    blockComments: BlockCommentSpan[]
): FoldingRange[] => {
    const folds: FoldingRange[] = [];
    for (const element of parserResult.elements) {
        collectContainers(element, (container) => {
            const fold = containerFold(container, document);
            if (fold) folds.push(fold);
        });
    }
    for (const comment of blockComments) {
        const fold = blockCommentFold(comment, document);
        if (fold) folds.push(fold);
    }
    folds.push(...lineCommentFolds(document.getText(), tokens, blockComments));
    return folds;
};
