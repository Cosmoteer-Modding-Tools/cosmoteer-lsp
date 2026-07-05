import { Token, TOKEN_TYPES } from '../../core/lexer/lexer';
import { AbstractNode } from '../../core/ast/ast';
import { ValidationError } from './validator';
import * as l10n from '@vscode/l10n';

/**
 * Flags `,`/`;` separators a line break already makes redundant. ObjectText ends a field, list
 * element or group member at an unsuppressed newline (and at end of file), so a separator whose
 * next token starts a new line terminates nothing. Commas inside parentheses are function-argument
 * separators (mXparser syntax, not ObjectText terminators) and are never flagged, and a token whose
 * newline is suppressed by a `\` line continuation keeps its separator (removing it would merge the
 * lines into one value).
 *
 * @param tokens the document's lexer tokens.
 * @returns one hint-severity finding per redundant separator, each carrying a remove quick-fix.
 */
export const validateRedundantSeparators = (tokens: Token[]): ValidationError[] => {
    const errors: ValidationError[] = [];
    let parenDepth = 0;
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token.type === TOKEN_TYPES.LEFT_PAREN) parenDepth++;
        else if (token.type === TOKEN_TYPES.RIGHT_PAREN && parenDepth > 0) parenDepth--;
        if ((token.type !== TOKEN_TYPES.SEMICOLON && token.type !== TOKEN_TYPES.COMMA) || parenDepth > 0) {
            continue;
        }
        if (isFollowedByLineBreakOrEof(tokens, i)) {
            errors.push({
                message: l10n.t('Unnecessary separator'),
                node: syntheticNodeAt(token),
                severity: 'hint',
                additionalInfo: l10n.t(
                    'The line break already ends this entry, so the separator has no effect. Separators are only needed between entries on the same line'
                ),
                data: { quickFix: { title: l10n.t('Remove separator'), newText: '' } },
            });
        }
    }
    return errors;
};

/**
 * Whether the separator at `index` is the last meaningful token on its (logical) line. Unsuppressed
 * newlines are recorded on the FOLLOWING token's `precededByNewline`, so the scan walks forward:
 * a newline before the next non-comment token means the separator sits at a line end; reaching a
 * non-comment token first means the separator still terminates something. A multi-line block
 * comment hides its inner newlines inside its own token, which errs toward not flagging.
 *
 * @param tokens the document's lexer tokens.
 * @param index the position of the separator token in `tokens`.
 * @returns true when only comments follow before the next unsuppressed newline or end of file.
 */
const isFollowedByLineBreakOrEof = (tokens: Token[], index: number): boolean => {
    for (let j = index + 1; j < tokens.length; j++) {
        const candidate = tokens[j];
        if (candidate.precededByNewline) return true;
        if (candidate.type === TOKEN_TYPES.SINGLE_COMMENT || candidate.type === TOKEN_TYPES.MULTI_COMMENT) {
            continue;
        }
        return false;
    }
    return true;
};

/**
 * Builds a minimal AST node anchored to a single token, since separator tokens never become AST
 * nodes the diagnostic could point at. Only the position is consumed by the diagnostic publisher.
 *
 * @param token the separator token to anchor the diagnostic to.
 * @returns a value node spanning exactly the token.
 */
const syntheticNodeAt = (token: Token): AbstractNode => {
    return {
        type: 'Value',
        position: {
            line: token.lineNumber,
            characterStart: token.lineOffset,
            characterEnd: token.lineOffset + 1,
            start: token.start,
            end: token.end ?? token.start + 1,
        },
    } as AbstractNode;
};
