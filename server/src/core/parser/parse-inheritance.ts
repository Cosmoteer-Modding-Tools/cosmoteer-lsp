import { Token, TOKEN_TYPES } from '../lexer/lexer';
import {
    AbstractNode,
    AbstractNodeDocument,
    GroupNode,
    ListNode,
    ValueNode,
    isExpressionNode,
    isIdentifierNode,
    isValueNode,
} from '../ast/ast';
import * as l10n from '@vscode/l10n';
import { ParserError, ParserState } from './parser.types';
import { isListElementIdentifier } from './parse-list';

/**
 * Whether the token an inheritance list is about to collect opens a new member instead of naming
 * another base.
 *
 * Only a `{` or a `[` ends an inheritance list in the game. A newline is insignificant filler
 * inside it (`Ships :` in builtin_ships/builtins.rules names eight bases, one per line, with no
 * commas), while `}`, `]`, `=` and everything else are absorbed into the reference text until
 * `Validator.ValidatePath` throws and the whole file is dropped. An inheritance whose body never
 * comes is therefore a file the game refuses to load, and the only question left is how much of it
 * stays readable here. A member head is the one shape that can be recognised without guessing: the
 * game reaches it only on input it has already refused, so stopping there costs no conformance,
 * and it is what keeps an unfinished head, the shape every group has while it is being typed, from
 * swallowing the rest of the file.
 *
 * @param state the parse state holding the token stream.
 * @param at the index of the token in question.
 * @returns true when the token opens a new member.
 */
const startsNewMember = (state: ParserState, at: number): boolean =>
    state.tokens[at]?.type === TOKEN_TYPES.VALUE &&
    (state.tokens[at + 1]?.type === TOKEN_TYPES.EQUALS || state.tokens[at + 1]?.type === TOKEN_TYPES.COLON);

/**
 * Collects the bases an inheritance names, from just after the colon up to the body or to the first
 * token that names no base.
 *
 * @param state the parse state, positioned after the colon.
 * @param parent the container the member belongs to.
 * @returns the bases, each normalized to a reference value.
 */
const collectInheritanceBases = (
    state: ParserState,
    parent?: GroupNode | ListNode | AbstractNodeDocument
): ValueNode[] => {
    const { tokens, errors } = state;
    const inheritanceNodes: ValueNode[] = [];
    let lastNode: AbstractNode | undefined | null = undefined;
    // check for next value or the special case with Expression(/) + Value
    while (
        tokens[state.current] &&
        (tokens[state.current].type === TOKEN_TYPES.VALUE ||
            // A quoted base is legal: `Part : "A"` parses in the game exactly like
            // `Part : A`, the quotes only delimit the one path (verified against
            // Halfling.ObjectText in HalflingCore.dll).
            tokens[state.current].type === TOKEN_TYPES.STRING ||
            (tokens[state.current].type === TOKEN_TYPES.EXPRESSION &&
                tokens[state.current + 1]?.type === TOKEN_TYPES.VALUE) ||
            (tokens[state.current].type === TOKEN_TYPES.EXPRESSION && tokens[state.current].value === '/')) &&
        !startsNewMember(state, state.current)
    ) {
        const nextNode = state.walk(state, lastNode ?? undefined, parent);
        lastNode = nextNode;
        if (!nextNode) {
            break;
        }
        if (isExpressionNode(nextNode) && nextNode.expressionType === '/') {
            inheritanceNodes.push({
                position: nextNode.position,
                parent: nextNode.parent,
                type: 'Value',
                valueType: {
                    type: 'Reference',
                    value: '/',
                },
            } as ValueNode);
        }
        if (isValueNode(nextNode)) {
            if (nextNode.valueType.type === 'Reference') {
                inheritanceNodes.push(nextNode as ValueNode);
            } else if (nextNode.valueType.type === 'String') {
                // Same-file inheritance by name (e.g. `Child : Parent`, or the quoted
                // `Child : "Parent"`). The lexer classifies both as a String, and a
                // quoted reference (`"&<f>/Part"`) already types as Reference above.
                // Normalize it to a relative reference (`&Parent`) so it is captured as
                // inheritance and resolves through the parent scope like an explicit `&` ref.
                nextNode.valueType = {
                    type: 'Reference',
                    value: '&' + String(nextNode.valueType.value),
                };
                inheritanceNodes.push(nextNode as ValueNode);
            } else if (nextNode.valueType.type === 'Number' && !nextNode.parenthesized) {
                // Numeric inheritance (e.g. `: 1` for a list element) inherits from
                // the sibling at that index in the containing list/group. Normalize
                // to a relative `&<index>` reference, resolved (via isInheritanceMember)
                // against the container: `stepIntoNode` indexes the list by number.
                nextNode.valueType = {
                    type: 'Reference',
                    value: '&' + String(nextNode.valueType.value),
                };
                inheritanceNodes.push(nextNode as ValueNode);
            } else {
                errors.push({
                    message: l10n.t(
                        'Expected reference value after reference value but found {0}',
                        nextNode.valueType.type
                    ),
                    token: tokens[state.current - 1],
                } as ParserError);
                break;
            }
        } else {
            errors.push({
                message: l10n.t('Expected reference value after reference value but found {0}', nextNode.type),
                token: tokens[state.current - 1],
            } as ParserError);
            break;
        }
        if (tokens[state.current] === undefined) {
            break;
        }
        // A `;` (like `,`) terminates an inheritance reference inside the inheritance list:
        // the game's `OTReferenceNode.Parse` breaks a ref on `;`/`,`/newline, and the
        // inheritance list keeps collecting refs until it reaches the body `{`/`[`. So the
        // list-element form `: ~/Base/N; { override }` (real in workshop mods, e.g.
        // pipebase.rules `ProxyableComponents`) is one element: a group inheriting from the
        // ref with a `{}` override. Consuming the `;` here lets the body attach. Without it
        // the `;` and `{ … }` leaked out and desynced the enclosing list's bracket matching.
        if (
            tokens[state.current]?.type === TOKEN_TYPES.COMMA ||
            tokens[state.current]?.type === TOKEN_TYPES.SEMICOLON
        ) {
            state.current++;
            continue;
        }
    }
    return inheritanceNodes;
};

/**
 * Builds the member an inheritance whose body never came leaves behind. The game demands the body
 * right after the bases and throws when it is missing, so this is a file it refuses to load. It is
 * also the state every such member passes through while it is being typed, so the member is kept
 * with an empty body and its bases attached: dropping it left the editor with nothing to complete a
 * base against, and no target to jump to, until the braces were written.
 *
 * @param state the parse state, positioned after the bases.
 * @param token the colon.
 * @param _lastNode the node read before the colon, which names the member when it is an identifier.
 * @param inheritanceNodes the bases the member starts from.
 * @param parent the container the member belongs to.
 * @returns the member as an empty group carrying its bases.
 */
const bodylessInheritance = (
    state: ParserState,
    token: Token,
    _lastNode: AbstractNode | undefined,
    inheritanceNodes: ValueNode[],
    parent?: GroupNode | ListNode | AbstractNodeDocument
): GroupNode => {
    state.errors.push({
        message: l10n.t('Expected a "{" or "[" body after the inheritance'),
        token,
        additionalInfo: [
            {
                message: l10n.t(
                    'An inheritance names what the body starts from, so the game expects the body that follows it. It fails to load the whole file when there is none.'
                ),
            },
        ],
    } as ParserError);
    const lastBase = inheritanceNodes[inheritanceNodes.length - 1];
    const bodyless = {
        type: 'Group',
        elements: [],
        // Named the same way a group with a body is, so the half-written member reads as itself
        // rather than as an anonymous one.
        identifier:
            _lastNode && isIdentifierNode(_lastNode) && !isListElementIdentifier(parent) ? _lastNode : undefined,
        parent,
        position: {
            characterEnd: lastBase?.position.characterEnd ?? token.lineOffset + 1,
            characterStart: token.lineOffset,
            end: lastBase?.position.end ?? token.end ?? 0,
            line: token.lineNumber,
            start: token.start,
        },
    } as GroupNode;
    bodyless.inheritance = inheritanceNodes.map((base) => {
        base.parent = bodyless;
        return base;
    });
    return bodyless;
};

/**
 * Reads an inheritance (`Child : Base { … }`): the bases named after the colon and the `{`/`[` body
 * they start from.
 *
 * @param state the parse state, positioned on the colon.
 * @param token the colon.
 * @param _lastNode the node read before the colon, which names the member when it is an identifier.
 * @param parent the container the member belongs to.
 * @returns the body with its bases attached, an empty group when the body never came, or null.
 */
export const parseInheritance = (
    state: ParserState,
    token: Token,
    _lastNode: AbstractNode | undefined,
    parent?: GroupNode | ListNode | AbstractNodeDocument
): AbstractNode | null => {
    const { tokens, errors } = state;
    state.current++;
    if (state.current >= tokens.length) {
        errors.push({
            message: l10n.t('Expected value after colon'),
            token,
            additionalInfo: [
                {
                    message: l10n.t('Those Values should be a References'),
                },
            ],
        } as ParserError);
        return null;
    }
    const inheritanceNodes = collectInheritanceBases(state, parent);
    let right: ListNode | GroupNode | null = null;
    if (tokens[state.current]?.type === TOKEN_TYPES.LEFT_BRACE) {
        right = state.walk(state, _lastNode, parent) as GroupNode;
    } else if (tokens[state.current]?.type === TOKEN_TYPES.LEFT_BRACKET) {
        right = state.walk(state, _lastNode, parent) as ListNode;
    }
    if (!right) {
        return bodylessInheritance(state, token, _lastNode, inheritanceNodes, parent);
    }
    // Inheritance nodes parent is the right node
    right.inheritance = inheritanceNodes.map((v) => {
        v.parent = right;
        return v;
    });
    return right;
};
