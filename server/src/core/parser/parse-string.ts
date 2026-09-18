import { Token, TOKEN_TYPES } from '../lexer/lexer';
import { AbstractNodeDocument, GroupNode, ListNode, ValueNode, ValueNodeTypes } from '../ast/ast';
import * as l10n from '@vscode/l10n';
import { inferValueType } from './infer-value-type';
import { ParserError, ParserState } from './parser.types';
import { tokenDisplayText } from './token-display';

/**
 * The tokens a bare run between two quoted segments of one value may hold. An unescaped `"` inside a
 * quoted value splits it into segments with bare source between them, and the game reads that whole
 * run as one value, so everything in it belongs to the string. Prose punctuation the lexer has no
 * grammar for arrives as UNEXPECTED (`?`, `#`, `@`), and the run also carries brackets, a colon and
 * the boolean words, all of which the game keeps in the value (verified against `OTFile`).
 *
 * The value terminators stay out: a `,` or `;` in such a run makes the game refuse the file, and a
 * `}`/`]` closes the parent, so absorbing either would hide a real error. `=`, `{` and `[` stay out
 * too: they carry no meaning inside a quoted value, and swallowing them could silently eat the
 * structure of a following member.
 */
const IN_STRING_RUN: ReadonlySet<TOKEN_TYPES> = new Set([
    TOKEN_TYPES.VALUE,
    TOKEN_TYPES.EXPRESSION,
    TOKEN_TYPES.UNEXPECTED,
    TOKEN_TYPES.LEFT_PAREN,
    TOKEN_TYPES.RIGHT_PAREN,
    TOKEN_TYPES.COLON,
    TOKEN_TYPES.TRUE,
    TOKEN_TYPES.FALSE,
]);

/**
 * Reads a quoted value, joining every segment the game reads as one string onto it.
 *
 * @param state the parse state, positioned on the opening segment.
 * @param token the first quoted segment.
 * @param parent the container the value belongs to.
 * @returns the value node carrying the whole assembled text.
 */
export const parseString = (
    state: ParserState,
    token: Token,
    parent?: GroupNode | ListNode | AbstractNodeDocument
): ValueNode => {
    const { tokens, errors } = state;
    state.current++;
    if (token.unterminatedString) {
        errors.push({
            message: l10n.t('This text is missing its closing quote'),
            token,
            additionalInfo: [
                {
                    message: l10n.t(
                        'A quoted value ends at the end of its line. Close the quote, or end the line with a backslash to carry the value on'
                    ),
                },
            ],
        } as ParserError);
    }
    let value = token.value as string;
    // ObjectText concatenates consecutive string literals (C-style): `"a" "b"` and the
    // line-continued form `"a"\ <newline> "b"` are a single string. They lex as adjacent
    // STRING tokens. The continuation segments carry no unsuppressed newline (a `\` before
    // the newline suppresses it, or the segments share a line). Without joining them the
    // trailing segments leak as sibling values: junk nodes in localization files, and in
    // the heat_management tutorial a continued string even stole the following `Entries`
    // list's identifier. Stop at an unsuppressed newline, which genuinely ends the value.
    // An unescaped quote inside a quoted value splits it into segments with bare words
    // between them, which is how `"… the "C" symbol …"` and vanilla's `"… the "military free
    // market", though …"` lex. The game reads the whole run as one value, so those bare
    // words belong to the string. Without absorbing them they leak as sibling members and
    // invent nodes the game never sees, including bogus localization keys. Only a run of
    // bare words that leads back into another segment on the same line is taken, which keeps
    // a genuine trailing word, a reference and an operator out of the string. The run has to
    // start on a word, but everything in {@link IN_STRING_RUN} may sit inside it, since prose
    // is full of `Mod - Expansion` dashes and `pourquoi ?` question marks and none of them
    // carry meaning inside a quoted value.
    // The game separates two unquoted tokens of a value by a single space when the source
    // separates them, and concatenates a quoted token with its neighbour directly whatever
    // stands between them (`"start"   tail ?` is the value `starttail ?`). The assembled
    // text follows the same rule.
    let previousWasQuoted = true;
    let previousEnd = token.end ?? token.start;
    for (;;) {
        const next = tokens[state.current];
        if (!next || next.precededByNewline) break;
        if (next.type === TOKEN_TYPES.STRING) {
            value += next.value as string;
            previousWasQuoted = true;
            previousEnd = next.end ?? next.start;
            state.current++;
            continue;
        }
        if (next.type !== TOKEN_TYPES.VALUE) break;
        let lookahead = state.current;
        for (;;) {
            const type = tokens[lookahead]?.type;
            if (!type || !IN_STRING_RUN.has(type) || tokens[lookahead]?.precededByNewline) break;
            lookahead++;
        }
        const rejoins = tokens[lookahead]?.type === TOKEN_TYPES.STRING && !tokens[lookahead]?.precededByNewline;
        if (!rejoins) break;
        while (state.current <= lookahead) {
            const runToken = tokens[state.current];
            const quoted = runToken.type === TOKEN_TYPES.STRING;
            if (!quoted && !previousWasQuoted && runToken.start > previousEnd) value += ' ';
            value += tokenDisplayText(runToken);
            previousWasQuoted = quoted;
            previousEnd = runToken.end ?? runToken.start;
            state.current++;
        }
    }
    // The quoted-string span must include the surrounding quotes (and any adjacent
    // concatenated segments), so derive the end from the last consumed token's absolute
    // offset rather than the unquoted content length, which is short by the quote characters
    // and would corrupt the file on rename and truncate every quoted-value highlight/hover.
    const lastStringToken = tokens[state.current - 1] ?? token;
    const endOffset = lastStringToken.end ?? token.end ?? token.start;
    // A quoted value is a string literal even when its content is all digits: the game reads
    // `SituationCode = "0000"` as the eight-character text, not the number 0. Never let the
    // numeric inference type a quoted token `Number`, or its highlight and hover read as a
    // number and the leading zeros vanish.
    const inferredType = inferValueType(token);
    const quotedType = inferredType.type === 'Number' ? { type: 'String' as const } : inferredType;
    return {
        type: 'Value',
        // Keep the type inferred from the first segment (String/Sprite/Sound/…) but carry the
        // full concatenated text as the value, so hover/rename/goto see the whole string.
        valueType: { ...quotedType, value } as ValueNodeTypes,
        parent,
        position: {
            characterEnd: token.lineOffset + (endOffset - token.start),
            characterStart: token.lineOffset,
            end: endOffset,
            line: token.lineNumber,
            start: token.start,
        },
        quoted: true,
    } as ValueNode;
};
