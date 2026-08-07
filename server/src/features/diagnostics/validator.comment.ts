import { BlockCommentSpan, Token, TOKEN_TYPES } from '../../core/lexer/lexer';
import { AbstractNode } from '../../core/ast/ast';
import { ValidationError } from './validator';
import * as l10n from '@vscode/l10n';

/**
 * The number of `*` directly in front of a block comment's closing `/`, not counting the `*` of the
 * opening `/*`. The count is what decides whether the game closes the comment, so `/***\/` counts 2
 * (the opening star is structure, not part of the closing run) while `/**\/` counts 1.
 *
 * @param text the document text.
 * @param span the comment's span, which must be a closed comment.
 * @returns the length of the closing `*` run.
 */
const closingStarRun = (text: string, span: BlockCommentSpan): number => {
    const bodyStart = span.start + 2;
    let index = span.end - 2;
    let run = 0;
    while (index >= bodyStart && text[index] === '*') {
        run++;
        index--;
    }
    return run;
};

/**
 * Builds a minimal AST node anchored to a byte range, since a comment never becomes an AST node the
 * diagnostic could point at. The publisher consumes the offsets, the line and column are filled in
 * for consumers that read a node's own position.
 *
 * @param text the document text, for the line and column of `start`.
 * @param start the first offset of the anchored range.
 * @param end the offset one past the anchored range.
 * @returns a value node spanning exactly that range.
 */
const syntheticNodeAt = (text: string, start: number, end: number): AbstractNode => {
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    let line = 0;
    for (let i = 0; i < lineStart; i++) if (text[i] === '\n') line++;
    return {
        type: 'Value',
        position: {
            line,
            characterStart: start - lineStart,
            characterEnd: end - lineStart,
            start,
            end,
        },
    } as AbstractNode;
};

/**
 * Flags every block comment the game leaves open. The game's ObjectText scanner closes a block
 * comment only when an odd number of `*` precedes the closing `/`: `/* x *\/` and `/* x ***\/`
 * close, while `/***\/`, `/* x **\/` and `/******** x ********\/` do not. An unclosed comment runs on to the next `*\/` in the file, or to the end of the file, where
 * the game throws a parse error. Banner comments are the usual victim: a file with an even number of
 * `/******** SECTION ********\/` banners still loads, and every part written between two banners is
 * swallowed, so the game reads an empty object where the author wrote a full one. Our own lexer
 * closes all of them, so without this check the swallowed content validates as clean. Warning
 * severity, since the file silently loses content at load time.
 *
 * @param text the document text.
 * @param blockComments the block-comment spans the lexer collected for that text.
 * @returns one finding per comment the game does not close, each with a fix that closes it.
 */
export const validateUnclosedComments = (text: string, blockComments: BlockCommentSpan[]): ValidationError[] => {
    const errors: ValidationError[] = [];
    for (const span of blockComments) {
        if (!span.closed) continue;
        const run = closingStarRun(text, span);
        if (run < 2 || run % 2 === 1) continue;
        const start = span.end - run - 1;
        errors.push({
            message: l10n.t(
                'The game does not close this comment. Everything up to the next "*/" in the file is dropped when the mod loads.'
            ),
            node: syntheticNodeAt(text, start, span.end),
            severity: 'warning',
            additionalInfo: l10n.t(
                "The game's comment scanner closes a block comment only when the run of '*' before the closing '/' is odd, and this run is {0} long. Content the comment swallows is invisible to the game even though it looks like ordinary rules.",
                run
            ),
            data: {
                quickFix: {
                    title: l10n.t("Remove one '*' so the comment closes"),
                    newText: `${'*'.repeat(run - 1)}/`,
                },
            },
        });
    }
    return errors;
};

/**
 * Flags a block comment that no `*\/` ever ends. The game reads on to the end of the file looking for
 * the terminator and then throws, so the whole file fails to load and every rule below the `/*` is
 * gone. Our own lexer treats the end of the file as the end of the comment, so the swallowed content
 * simply disappears from the tree and nothing else reports it.
 *
 * @param text the document text.
 * @param blockComments the block-comment spans the lexer collected for that text.
 * @returns one finding per comment that never closes, anchored to its `/*`.
 */
export const validateUnterminatedComments = (text: string, blockComments: BlockCommentSpan[]): ValidationError[] => {
    const errors: ValidationError[] = [];
    for (const span of blockComments) {
        if (span.closed) continue;
        errors.push({
            message: l10n.t('This comment is never closed'),
            node: syntheticNodeAt(text, span.start, Math.min(span.start + 2, text.length)),
            additionalInfo: l10n.t(
                'The game looks for the matching "*/" to the end of the file and then fails to load the whole file. Everything below this point is lost with it.'
            ),
        });
    }
    return errors;
};

/**
 * Flags a `*\/` that closes nothing. Block comments do not nest and a `//` inside one does not hide
 * its terminator, so the first `*\/` after a `/*` already ended the comment and a second one is read
 * as rules content. The game throws on it and the whole file fails to load. The lexer hands the
 * leftover through as an adjacent `*` and `/` operator pair, which is only meaningful mid-value, so
 * the check takes the pair where a new member would start.
 *
 * @param tokens the document's lexer tokens.
 * @returns one finding per stray comment terminator.
 */
export const validateOrphanCommentTerminators = (tokens: Token[]): ValidationError[] => {
    const errors: ValidationError[] = [];
    for (let i = 0; i + 1 < tokens.length; i++) {
        const star = tokens[i];
        const slash = tokens[i + 1];
        if (star.type !== TOKEN_TYPES.EXPRESSION || star.value !== '*') continue;
        if (slash.type !== TOKEN_TYPES.EXPRESSION || slash.value !== '/' || star.end !== slash.start) continue;
        if (i > 0 && !star.precededByNewline) continue;
        errors.push({
            message: l10n.t('This "*/" closes no comment'),
            node: {
                type: 'Value',
                position: {
                    line: star.lineNumber,
                    characterStart: star.lineOffset,
                    characterEnd: star.lineOffset + 2,
                    start: star.start,
                    end: slash.end ?? star.start + 2,
                },
            } as AbstractNode,
            additionalInfo: l10n.t(
                'Block comments do not nest and a "//" inside one does not hide its "*/", so the comment ended earlier and the game reads this as rules content. It fails to load the whole file on it.'
            ),
        });
    }
    return errors;
};
