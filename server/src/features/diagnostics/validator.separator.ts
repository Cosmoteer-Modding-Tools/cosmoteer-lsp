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
 * Whether a value token reads as a member name. Names are plain words (or the digits of a list-form
 * index), which keeps the mXparser relations `<=`, `>=` and `==` out of the missing-separator check
 * below: their left side arrives as a value token holding the operator's first character, or as the
 * digits of a number that the second `=` completes into `==`.
 *
 * @param token the token before an `=`.
 * @param next the token after that `=`, which completes an `==` when it is another `=`.
 * @returns true when the pair reads as the start of a new member.
 */
const startsMember = (token: Token | undefined, next: Token | undefined): boolean =>
    token?.type === TOKEN_TYPES.VALUE &&
    typeof token.value === 'string' &&
    /^(?:[A-Za-z_][\w.]*|\d+)$/.test(token.value) &&
    next?.type !== TOKEN_TYPES.EQUALS;

/**
 * Flags a member that starts on the same line as the member before it with no `,` or `;` between the
 * two. A flat field value runs to the end of its line, so the game folds the second member into the
 * first one's value and then throws on the `=` it finds inside a value, which drops the whole file
 * A `{ … }` or `[ … ]` value ends at its own closer instead of at the line break, so a member
 * following one of those is legal and is left alone, as is anything nested inside a `{`, `[` or `(`
 * opened on the line. A line break, a terminator or the end of the enclosing block ends the search.
 *
 * @param tokens the document's lexer tokens.
 * @returns one finding per member that needs a separator in front of it.
 */
export const validateMissingSeparators = (tokens: Token[]): ValidationError[] => {
    const errors: ValidationError[] = [];
    for (let i = 0; i < tokens.length; i++) {
        if (tokens[i].type !== TOKEN_TYPES.EQUALS) continue;
        if (tokens[i + 1]?.type === TOKEN_TYPES.LEFT_BRACE || tokens[i + 1]?.type === TOKEN_TYPES.LEFT_BRACKET) {
            continue;
        }
        let depth = 0;
        for (let j = i + 1; j < tokens.length; j++) {
            const token = tokens[j];
            if (token.precededByNewline) break;
            if (
                token.type === TOKEN_TYPES.LEFT_BRACE ||
                token.type === TOKEN_TYPES.LEFT_BRACKET ||
                token.type === TOKEN_TYPES.LEFT_PAREN
            ) {
                depth++;
                continue;
            }
            if (
                token.type === TOKEN_TYPES.RIGHT_BRACE ||
                token.type === TOKEN_TYPES.RIGHT_BRACKET ||
                token.type === TOKEN_TYPES.RIGHT_PAREN
            ) {
                if (depth === 0) break;
                depth--;
                continue;
            }
            if (depth > 0) continue;
            if (token.type === TOKEN_TYPES.SEMICOLON || token.type === TOKEN_TYPES.COMMA) break;
            if (token.type !== TOKEN_TYPES.EQUALS) continue;
            const name = tokens[j - 1];
            if (!startsMember(name, tokens[j + 1])) break;
            // A `\` continuation joins the lines on purpose, and the whole run is one value the
            // author meant to write.
            if (name.lineNumber > tokens[i].lineNumber) break;
            errors.push({
                message: l10n.t('The value before this swallows it'),
                node: syntheticNodeAt(name),
                severity: 'warning',
                additionalInfo: l10n.t(
                    'A value runs to the end of the line, so the game reads this member as part of the value before it instead of as a member of its own. Put the member on its own line or separate the two with ";".'
                ),
            });
            break;
        }
    }
    return errors;
};

/** The tokens that end the member before them, so that the next one starts a member of its own. */
const MEMBER_BOUNDARIES: ReadonlySet<TOKEN_TYPES> = new Set([
    TOKEN_TYPES.EQUALS,
    TOKEN_TYPES.COLON,
    TOKEN_TYPES.LEFT_BRACE,
    TOKEN_TYPES.LEFT_BRACKET,
    TOKEN_TYPES.RIGHT_BRACE,
    TOKEN_TYPES.RIGHT_BRACKET,
    TOKEN_TYPES.SEMICOLON,
    TOKEN_TYPES.COMMA,
]);

/**
 * Flags a second reference hung behind a field value on a `,`. A field takes one value and the `,`
 * ends the member, so `X = &<a>, &<b>` leaves the second reference standing on its own where the game
 * expects a member name, and the game fails to load the whole file. The `,` of a `[ … ]` list and of
 * a `foo(…)` argument list take a value after them and are skipped through the opener stack, and an
 * inheritance list (`Components : ^/0/Components, &<file>`) is skipped because its member was opened
 * by a `:`.
 *
 * @param tokens the document's lexer tokens.
 * @returns one finding per reference that stands alone behind a field value.
 */
export const validateUnbracketedValueList = (tokens: Token[]): ValidationError[] => {
    const errors: ValidationError[] = [];
    const openers: TOKEN_TYPES[] = [];
    // What opened the member the walk is inside of, an `=` for a field and a `:` for an inheritance.
    let memberOpener: TOKEN_TYPES | undefined;
    for (let i = 0; i < tokens.length; i++) {
        const type = tokens[i].type;
        const boundary = MEMBER_BOUNDARIES.has(type);
        const enclosing = openers[openers.length - 1];
        if (
            type === TOKEN_TYPES.LEFT_BRACE ||
            type === TOKEN_TYPES.LEFT_BRACKET ||
            type === TOKEN_TYPES.LEFT_PAREN
        ) {
            openers.push(type);
        } else if (
            type === TOKEN_TYPES.RIGHT_BRACE ||
            type === TOKEN_TYPES.RIGHT_BRACKET ||
            type === TOKEN_TYPES.RIGHT_PAREN
        ) {
            openers.pop();
        }
        const openerBefore = memberOpener;
        if (boundary) memberOpener = type;
        if (type !== TOKEN_TYPES.COMMA || openerBefore !== TOKEN_TYPES.EQUALS) continue;
        if (enclosing === TOKEN_TYPES.LEFT_BRACKET || enclosing === TOKEN_TYPES.LEFT_PAREN) continue;
        const next = tokens[i + 1];
        if (next?.type !== TOKEN_TYPES.VALUE || !next.value?.startsWith('&')) continue;
        errors.push({
            message: l10n.t('The game cannot read a standalone reference here'),
            node: syntheticNodeAt(next),
            additionalInfo: l10n.t(
                'The "," in front of it ends the field, so this reference is a member of its own rather than a second value. A field carries one value, and the game fails to load the whole file on this. Collect the references in a "[ ]" list or inherit from them with ":".'
            ),
        });
    }
    return errors;
};

/**
 * Whether the separator at `index` is the last meaningful token on its (logical) line. Unsuppressed
 * newlines are recorded on the following token's `precededByNewline`, so the answer is that token's
 * own flag, and a separator at the end of the file has nothing after it at all. Comments produce no
 * tokens, and only a `//` comment reports the newline that ends it, so a separator followed by a
 * multi-line block comment reads as still terminating something, which errs toward not flagging.
 *
 * @param tokens the document's lexer tokens.
 * @param index the position of the separator token in `tokens`.
 * @returns true when the separator is followed by an unsuppressed newline or by the end of file.
 */
const isFollowedByLineBreakOrEof = (tokens: Token[], index: number): boolean => {
    const next = tokens[index + 1];
    return next === undefined || !!next.precededByNewline;
};

/**
 * Builds a minimal AST node anchored to a single token, since the tokens these checks report on never
 * become AST nodes the diagnostic could point at. Only the position is consumed by the diagnostic
 * publisher.
 *
 * @param token the token to anchor the diagnostic to.
 * @returns a value node spanning exactly the token.
 */
const syntheticNodeAt = (token: Token): AbstractNode => {
    const end = token.end ?? token.start + 1;
    return {
        type: 'Value',
        position: {
            line: token.lineNumber,
            characterStart: token.lineOffset,
            characterEnd: token.lineOffset + (end - token.start),
            start: token.start,
            end,
        },
    } as AbstractNode;
};
