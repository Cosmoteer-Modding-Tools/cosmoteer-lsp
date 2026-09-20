import { Token, TOKEN_TYPES } from '../lexer/lexer';
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
    isValueNode,
} from '../ast/ast';
import * as l10n from '@vscode/l10n';
import { inferValueType, IS_NUMBER } from './infer-value-type';
import { ParserError, ParserState } from './parser.types';
import { isListElementIdentifier } from './parse-list';
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
    const name = typeof token.value === 'string' ? token.value : '';
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
    reportInvalidMemberName(state, token, tokens[state.current], tokens[state.current - 2], true);
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
        right: valueIsEmpty ? null : continueMathExpression(state, state.walk(state, _lastNode, parent), parent),
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
        node = {
            type: 'Value',
            valueType: inferValueType(token),
            parent,
            position: tokenPosition(token),
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
            if (isListElementIdentifier(parent)) {
                return node;
            }
            return state.walk(state, node, parent);
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
        return state.walk(state, _lastNode, parent);
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
        return state.walk(state, _lastNode, parent);
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
