import { Token, TOKEN_TYPES } from '../lexer/lexer';
import { walk } from './parser';
import {
    AbstractNode,
    AstPosition,
    AbstractNodeDocument,
    AssignmentNode,
    GroupNode,
    IdentifierNode,
    ListNode,
    ValueNode,
    ValueNodeTypes,
    isListNode,
    isValueNode,
} from '../ast/ast';
import * as l10n from '@vscode/l10n';
import { inferValueType, IS_NUMBER } from './infer-value-type';
import { ParserError, ParserState } from './parser.types';
import { continueMathExpression } from './parse-expression';

/**
 * The tokens the game accepts directly after a member name: an assignment, an inheritance colon, a
 * `{`/`[` body, or one of the terminators that end the member. A line break ends the member too and
 * leaves a void node behind, which is why it is handled separately from this set.
 */
const NAME_FOLLOWERS: ReadonlySet<TOKEN_TYPES> = new Set([
    TOKEN_TYPES.EQUALS,
    TOKEN_TYPES.COLON,
    TOKEN_TYPES.LEFT_BRACE,
    TOKEN_TYPES.LEFT_BRACKET,
    TOKEN_TYPES.SEMICOLON,
    TOKEN_TYPES.COMMA,
    TOKEN_TYPES.RIGHT_BRACE,
    TOKEN_TYPES.RIGHT_BRACKET,
]);

// Hoisted out of the parse loop, which tests this for every member name of every parsed file. A
// regex literal in the body allocates a fresh RegExp per call, and it carries no state.

/** Matches a name that holds whitespace, which the game refuses as a member name. */
const HAS_WHITESPACE = /\s/;

/**
 * Matches the punctuation that reads as ordinary text inside a value and that the game's tokenizer
 * refuses where a member name belongs. Its name text is `[0-9A-Za-z_.]`, and running `A#B = 1`,
 * `A@B = 1` and `A?B = 1` through the shipped HalflingCore parser answers `Unexpected "#"`,
 * `Unexpected "@"` and `Unexpected "?"`, each of which drops the whole file.
 */
const REFUSED_IN_NAME = /[#@$?|`]/;

/**
 * The span a single-token node covers, as the token's own extent.
 *
 * @param token the token the node is built from.
 * @returns the node position.
 */
const tokenPosition = (token: Token): AstPosition => ({
    characterEnd: token.lineOffset + (token.value as string)?.length,
    characterStart: token.lineOffset,
    end: token.end ?? 0,
    line: token.lineNumber,
    start: token.start,
});

/**
 * The tokens that make the value token in front of them the head of a member rather than a word of
 * the value before it. The game does fold such a member into the value it follows, which is a typo
 * the parser refuses to reproduce: the member would disappear from the tree and the mistake would
 * be reported on a line the author never touched.
 */
const MEMBER_HEAD_FOLLOWERS: ReadonlySet<TOKEN_TYPES> = new Set([
    TOKEN_TYPES.EQUALS,
    TOKEN_TYPES.COLON,
    TOKEN_TYPES.LEFT_BRACE,
    TOKEN_TYPES.LEFT_BRACKET,
]);

/**
 * Joins the value tokens that carry on the one the cursor sits on. A value runs to the end of its
 * line, and two things split it without ending it: a `\`, which the game reads as spacing and which
 * suppresses the line break after it, and a block comment between two words. The game joins the
 * pieces into one value separated by a single space, so `A = 1 \ <newline> 2` and `A = 1 /* c *\/ 2`
 * are both the value `1 2`, and inside a list they are one element rather than two.
 *
 * @param state the parse state, positioned one past the first value token.
 * @param token the value token the run starts on.
 * @returns the joined text and the last token the run consumed.
 */
const joinContinuedValue = (state: ParserState, token: Token): { text: string; last: Token } => {
    const { tokens } = state;
    let text = token.value as string;
    let last = token;
    for (;;) {
        const next = tokens[state.current];
        if (!next || next.type !== TOKEN_TYPES.VALUE || next.precededByNewline) break;
        const following = tokens[state.current + 1];
        if (following && MEMBER_HEAD_FOLLOWERS.has(following.type)) break;
        text += ` ${next.value as string}`;
        last = next;
        state.current++;
    }
    return { text, last };
};

/**
 * The span of a value assembled from a run of tokens, from the first token's start to the last
 * one's end. The joined text is shorter than the span it covers, the same way a concatenated
 * quoted value is, since the `\` and the comment between the pieces are spacing.
 *
 * @param token the first token of the run.
 * @param last the last token of the run.
 * @returns the node position.
 */
const runPosition = (token: Token, last: Token): AstPosition => {
    const end = last.end ?? last.start;
    return {
        characterEnd: token.lineOffset + (end - token.start),
        characterStart: token.lineOffset,
        end,
        line: token.lineNumber,
        start: token.start,
    };
};

/**
 * Whether the token continues the previous line through a `\`, which suppresses the newline. The
 * lexer only marks an unsuppressed newline, so a continued token looks like it shares the line
 * with what came before it. A continued run is part of a value the game reads as one string, and
 * the words in it are never member names.
 *
 * @param token the token to judge.
 * @param previous the token before it, or undefined at the start of the file.
 * @returns true when a suppressed newline separates the two.
 */
const continuesPreviousLine = (token: Token, previous: Token | undefined): boolean =>
    !!previous && token.lineNumber > previous.lineNumber && !token.precededByNewline;

/**
 * Reports a member name the game refuses to read in group or document position. ObjectText reads
 * the name and then requires `=`, `:`, `{`, `[`, a terminator or a line break, and it never lets a
 * number name a member. Both spellings make the game throw and drop the whole file. Our
 * unquoted-value charset holds spaces so that a value keeps its words together, which means a
 * whole sentence of prose arrives here as one name token, and the whitespace test is what
 * catches it.
 *
 * @param state the parse state the error is recorded in.
 * @param token the name token.
 * @param next the token following the name, undefined at the end of the file.
 * @param previous the token before the name, undefined at the start of the file.
 * @param numbersAllowed whether a number may name this member. It may on the left of an `=`,
 * which is the list-form index field (`0 = 5`), and may not anywhere else.
 */
const reportInvalidMemberName = (
    state: ParserState,
    token: Token,
    next: Token | undefined,
    previous: Token | undefined,
    numbersAllowed = false
): void => {
    // A `\` continuation glues the next line onto this value, so nothing in the run is a name.
    if (continuesPreviousLine(token, previous)) return;
    const { errors } = state;
    if (token.invisibleChar !== undefined) {
        const at = token.invisibleCharStart ?? token.start;
        errors.push({
            message: l10n.t(
                'The invisible character {0} stands where a member name belongs',
                `U+${token.invisibleChar.toString(16).toUpperCase().padStart(4, '0')}`
            ),
            token: { ...token, start: at, end: at + 1 },
            additionalInfo: [
                {
                    message: l10n.t(
                        'The game reads only a tab, a space and a line break as spacing, so it stops on this character and fails to load the whole file. Delete it, or replace it with a plain space.'
                    ),
                },
            ],
        } as ParserError);
        return;
    }
    const name = typeof token.value === 'string' ? token.value : '';
    const refused = REFUSED_IN_NAME.exec(name);
    if (refused) {
        errors.push({
            message: l10n.t('Unexpected "{0}"', refused[0]),
            token,
            additionalInfo: [
                {
                    message: l10n.t(
                        'The game reads only letters, digits, "_" and "." in a member name, so it stops on this character and fails to load the whole file. It reads the same character as ordinary text on the right of an "=".'
                    ),
                },
            ],
        } as ParserError);
        return;
    }
    if (!numbersAllowed && IS_NUMBER.test(name)) {
        errors.push({
            message: l10n.t('A number cannot name a member'),
            token,
            additionalInfo: [
                {
                    message: l10n.t(
                        'The game reads a number as a list element or as a path segment, never as the name of a group member. It fails to load the whole file on this.'
                    ),
                },
            ],
        } as ParserError);
        return;
    }
    if (!HAS_WHITESPACE.test(name) && (!next || next.precededByNewline || NAME_FOLLOWERS.has(next.type))) {
        return;
    }
    errors.push({
        message: l10n.t('A member name must be followed by "=", ":", "{", "[" or the end of the line'),
        token,
        additionalInfo: [
            {
                message: l10n.t(
                    'The game stops at anything else and fails to load the whole file. Free text such as a note or a description has to go into a "//" comment or a quoted value.'
                ),
            },
        ],
    } as ParserError);
};

/**
 * Reads a `Name = value` assignment. The name has been read and the cursor sits on the `=`.
 *
 * A newline after `=` does not end the value. The game skips ahead to the next significant token,
 * so `DamageResistances =` with its `{ … }` body on the following line is that field's group,
 * `RandomSounds =` with its `[ … ]` underneath is that field's list, and `OnDeath =` above a
 * reference binds the reference.
 *
 * Two cases deliberately stay empty instead. Both are inputs the game answers with a parse error
 * that cascades to the end of the file, so staying graceful beats reproducing it. A member
 * terminator or EOF (`X =` right before `}`) is one of them, because consuming it would eat the
 * enclosing group's closer and desync the whole container, which is exactly the live-editing state
 * right after a completion snippet scaffolds the field or the user deletes a value. The head of a
 * new member on a later line (`X =` above `Y = 1`) is the other, since the game folds that whole
 * member into the value, which no shipped file relies on and no live edit ever means.
 *
 * @param state the parse state, positioned on the `=`.
 * @param token the name token.
 * @param _lastNode the node read before the name.
 * @param parent the container the assignment belongs to.
 * @returns the assignment, or null when the file ended right after the `=`.
 */
const parseAssignment = (
    state: ParserState,
    token: Token,
    _lastNode: AbstractNode | undefined,
    parent?: GroupNode | ListNode | AbstractNodeDocument
): AssignmentNode | null => {
    const { tokens, errors } = state;
    // A name with a space in it is one the game refuses, whatever follows it. `Foo Bar {}` was
    // already reported and `Foo Bar = 1` was not, although the game stops on both.
    //
    // A number may name the left side of an `=` only inside a `[ … ]` list, where the game reads
    // the whole line as one text element and `0 = 2` is simply the text `"0 = 2"`. In a group or at
    // the document top level it is a hard parse failure: the game's identifier may not start with a
    // digit, and running `G { 0 = 2 }` through the shipped HalflingCore parser answers
    // `Unexpected "0" at position Line=3,Char=2`. That is what makes a list-typed slot written as
    // `Resources { 0 = [steel, 32] }` and a vector written as `Size { 0 = 2; 1 = 2 }` unreadable,
    // whatever their schema slot says.
    reportInvalidMemberName(state, token, tokens[state.current], tokens[state.current - 2], parent?.type === 'List');
    const equals = tokens[state.current];
    state.current++;
    if (state.current >= tokens.length) {
        errors.push({
            message: l10n.t('Expected value after equals'),
            token,
            additionalInfo: [
                {
                    message: l10n.t(
                        'If you want to assign a value to an identifier, you need to provide a value after the equals sign'
                    ),
                },
                {
                    message: l10n.t(
                        "If you don't want to assign a value to an identifier, you need to remove the equals sign"
                    ),
                },
            ],
        } as ParserError);
        return null;
    }
    const next = tokens[state.current];
    const following = tokens[state.current + 1];
    const nextStartsNewMember =
        !!next.precededByNewline && (following?.type === TOKEN_TYPES.EQUALS || following?.type === TOKEN_TYPES.COLON);
    const valueIsEmpty =
        nextStartsNewMember ||
        next.type === TOKEN_TYPES.RIGHT_BRACE ||
        next.type === TOKEN_TYPES.RIGHT_BRACKET ||
        next.type === TOKEN_TYPES.SEMICOLON ||
        next.type === TOKEN_TYPES.COMMA;
    // The game hunts for the value past the line break and takes whatever it finds first, so a `}`
    // standing there becomes the value and the group never closes. Running the shipped HalflingCore
    // parser over `G { A = }` answers `Unexpected EOF`, and the same shape with one more `}` below
    // it loads with `A` holding `"}"`. Our parse leaves the slot empty instead, so the file keeps
    // its shape while the report says the game will not read it. A `]` is not the same case: inside
    // a list there is no assignment to leave dangling and the game reads the whole line as one
    // element, so only the brace is reported. A member on a line an earlier empty `=` already
    // swallowed is not reported either, since the game never reads it as a member at all.
    if (next.type === TOKEN_TYPES.RIGHT_BRACE && state.swallowedValueLine !== token.lineNumber) {
        errors.push({
            message: l10n.t('This "=" has no value, so the game reads the closing brace as one'),
            token: equals,
            additionalInfo: [
                {
                    message: l10n.t(
                        'The value slot takes the next thing the game finds, which here is the "}" that closes the group. The group then never closes and the whole file fails to load. Write the value, or delete the "=".'
                    ),
                },
            ],
        } as ParserError);
    }
    state.swallowedValueLine = nextStartsNewMember ? next.lineNumber : undefined;
    return {
        type: 'Assignment',
        assignmentType: 'Equals',
        parent,
        left: {
            type: 'Identifier',
            name: token.value,
            parent,
            position: tokenPosition(token),
        } as IdentifierNode,
        right: valueIsEmpty ? null : continueMathExpression(state, walk(state, _lastNode, parent), parent),
    } as AssignmentNode;
};

/**
 * Reads a bare token: the head of an assignment, a value continuing the one before it, or an
 * identifier that names whatever follows it.
 *
 * @param state the parse state, positioned on the token.
 * @param token the bare token to read.
 * @param _lastNode the node read before it, which decides whether this one continues a value.
 * @param parent the container the node belongs to.
 * @returns the assignment, value or identifier read, or whatever the identifier heads.
 */
export const parseValue = (
    state: ParserState,
    token: Token,
    _lastNode: AbstractNode | undefined,
    parent?: GroupNode | ListNode | AbstractNodeDocument
): AbstractNode | null => {
    const { tokens, errors } = state;
    state.current++;
    let node: AbstractNode;
    if (tokens[state.current] && tokens[state.current].type === TOKEN_TYPES.EQUALS) {
        const assignment = parseAssignment(state, token, _lastNode, parent);
        if (!assignment) return null;
        node = assignment;
    } else if (
        token.value &&
        tokens[state.current - 2] &&
        (tokens[state.current - 2].type === TOKEN_TYPES.EQUALS ||
            tokens[state.current - 2].type === TOKEN_TYPES.COLON ||
            tokens[state.current - 2].type === TOKEN_TYPES.LEFT_BRACKET ||
            // An operator makes what follows it an operand, but only while the value is
            // still going: a value ends at the line break, so the word on the next line
            // names a member. Reading it as an operand of a trailing `-` left the group or
            // list it names anonymous.
            (tokens[state.current - 2].type === TOKEN_TYPES.EXPRESSION && !token.precededByNewline) ||
            tokens[state.current - 2].type === TOKEN_TYPES.LEFT_PAREN ||
            _lastNode?.type === 'Value' ||
            // Right after a `,` field separator, an identifier that heads a group/list/
            // inheritance (`, Criterias [ … ]`, real mod gaugeincreaser.rules) is a new
            // member, not a comma-separated value. So classify it as a value only when it is
            // not immediately followed by `{`/`[`/`:` (else its opener is orphaned and the
            // member goes anonymous). The multi-value continuation cases above are left as-is.
            (tokens[state.current - 2].type === TOKEN_TYPES.COMMA &&
                tokens[state.current]?.type !== TOKEN_TYPES.LEFT_BRACE &&
                tokens[state.current]?.type !== TOKEN_TYPES.LEFT_BRACKET &&
                tokens[state.current]?.type !== TOKEN_TYPES.COLON))
    ) {
        const run = joinContinuedValue(state, token);
        const joined = run.last === token ? token : ({ ...token, value: run.text, end: run.last.end } as Token);
        node = {
            type: 'Value',
            valueType: inferValueType(joined),
            parent,
            position: run.last === token ? tokenPosition(token) : runPosition(token, run.last),
        } as ValueNode;
    } else {
        node = {
            type: 'Identifier',
            name: token.value,
            parent,
            position: tokenPosition(token),
        } as IdentifierNode;
        // The game accepts a bare `&…` reference only as a list element or a field
        // value. In group or document position it throws `Unexpected "&"` and the whole
        // file fails to load, so report it as a parse error while keeping the node for
        // navigation.
        if (typeof token.value === 'string' && token.value.startsWith('&') && parent?.type !== 'List') {
            errors.push({
                message: l10n.t('The game cannot read a standalone reference here'),
                token,
                additionalInfo: [
                    {
                        message: l10n.t(
                            'A bare reference is only allowed as a list element or as a field value (Field = &/Path). The game fails to load the whole file on this.'
                        ),
                    },
                ],
            } as ParserError);
        } else if (parent?.type !== 'List') {
            // A list element is not a member, so it carries none of the naming rules: a
            // number and a run of words are both ordinary element values there.
            reportInvalidMemberName(state, token, tokens[state.current], tokens[state.current - 2]);
        }
        if (
            tokens[state.current]?.type === TOKEN_TYPES.LEFT_BRACE ||
            tokens[state.current]?.type === TOKEN_TYPES.LEFT_BRACKET ||
            tokens[state.current]?.type === TOKEN_TYPES.COLON
        ) {
            // Inside a list the game never attaches a following `{`/`[`/`:` to an
            // identifier element: the identifier stays its own element and the `{`/`:`
            // opens a separate anonymous element, so keep it standalone instead of making
            // it a head.
            if (isListNode(parent)) {
                return node;
            }
            return walk(state, node, parent);
        }
    }
    return node;
};

/**
 * Reads a boolean literal.
 *
 * @param state the parse state, positioned on the literal.
 * @param token the `true` or `false` token.
 * @param parent the container the value belongs to.
 * @returns the boolean value node.
 */
export const parseBoolean = (
    state: ParserState,
    token: Token,
    parent?: GroupNode | ListNode | AbstractNodeDocument
): ValueNode => {
    state.current++;
    const value = token.type === TOKEN_TYPES.TRUE;
    return {
        type: 'Value',
        valueType: {
            type: 'Boolean',
            value,
        },
        parent,
        position: {
            // The span covers the word as it is written, four characters for `true` and five
            // for `false`.
            characterEnd: token.lineOffset + (value ? 4 : 5),
            characterStart: token.lineOffset,
            end: token.end ?? 0,
            line: token.lineNumber,
            start: token.start,
        },
    } as ValueNode;
};

/**
 * Reads a `)` that no paren group or call is waiting for.
 *
 * A `)` reaching here is unmatched. Every paren-group/function-call loop consumes its own closing
 * `)` before calling `walk`, so this is a stray paren. The real OT parser (OTFieldNode) reads such
 * a token as part of the value string, e.g. `RightBracket = )` or `AsteroidGold_S = 金小惑星（S)` in
 * cosmoteer `strings/*.rules`. When the field it belongs to is still on the same line, append it
 * there so the member keeps the one value the game gives it. A full-width `（` is an ordinary value
 * character, so only the closing half reaches the parser and the value would otherwise lose it and
 * gain a sibling the game never sees.
 *
 * @param state the parse state, positioned on the paren.
 * @param token the stray paren.
 * @param _lastNode the node read before it, which the paren is appended to when it is still open.
 * @param parent the container the value belongs to.
 * @returns the paren as its own value, or whatever follows once it was appended to the value.
 */
export const parseStrayRightParen = (
    state: ParserState,
    token: Token,
    _lastNode: AbstractNode | undefined,
    parent?: GroupNode | ListNode | AbstractNodeDocument
): AbstractNode | null => {
    if (_lastNode?.type === 'Value') {
        state.current++;
        return walk(state, _lastNode, parent);
    }
    const previous = _lastNode?.type === 'Assignment' ? (_lastNode as AssignmentNode).right : undefined;
    if (previous && isValueNode(previous) && previous.position.line === token.lineNumber && !previous.quoted) {
        previous.valueType = {
            ...previous.valueType,
            value: `${previous.valueType.value})`,
        } as ValueNodeTypes;
        previous.position.characterEnd = token.lineOffset + 1;
        previous.position.end = token.end ?? previous.position.end;
        state.current++;
        return walk(state, _lastNode, parent);
    }
    state.current++;
    return {
        type: 'Value',
        valueType: { type: 'String', value: ')' },
        parent,
        position: {
            line: token.lineNumber,
            characterStart: token.lineOffset,
            characterEnd: token.lineOffset + 1,
            start: token.start,
            end: token.end ?? 0,
        },
    } as ValueNode;
};
