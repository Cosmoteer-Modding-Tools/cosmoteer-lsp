import { Token, TOKEN_TYPES } from '../lexer/lexer';
import { walk } from './parser';
import {
    AbstractNode,
    AbstractNodeDocument,
    GroupNode,
    ListNode,
    isIdentifierNode,
    isListNode,
    isValueNode,
} from '../ast/ast';
import * as l10n from '@vscode/l10n';
import { ParserError, ParserState } from './parser.types';
import { continueMathExpression } from './parse-expression';
import { reportOrphanTerminator } from './parse-terminator';

/**
 * Reads a `[ … ]` list body. The opening bracket has already been seen, so the elements are
 * collected until the matching `]`, an element that reads as nothing or the end of the file.
 *
 * @param state the parse state, positioned on the opening bracket.
 * @param token the opening bracket.
 * @param _lastNode the node read before the bracket, which names the list when it is an identifier.
 * @param parent the container the list belongs to.
 * @returns the list, even when its closing bracket never came.
 */
export const parseList = (
    state: ParserState,
    token: Token,
    _lastNode: AbstractNode | undefined,
    parent?: GroupNode | ListNode | AbstractNodeDocument
): ListNode => {
    const { tokens, errors } = state;
    state.current++;
    const node = {
        type: 'List',
        parent,
        identifier: _lastNode && isIdentifierNode(_lastNode) && !isListNode(parent) ? _lastNode : undefined,
        elements: [],
        position: {
            line: token.lineNumber,
            characterStart: token.lineOffset,
            characterEnd: 0,
            start: token.start,
            end: 0,
        },
    } as ListNode;
    if (!tokens[state.current]) {
        errors.push({
            message: l10n.t('Expected right bracket but found end of file'),
            token,
        } as ParserError);
        return node;
    }
    let lastNode: AbstractNode | undefined = node;
    while (tokens[state.current] && tokens[state.current].type !== TOKEN_TYPES.RIGHT_BRACKET) {
        // A list element ends only at `,`, `;`, a line break or `]`, so an operator run
        // belongs to the element it follows: the game reads `[255*.45, 255*.45]` as two
        // elements. Folding the run into one node here is what keeps every index in the list
        // the index the game sees, which positional fields and `…/1` references depend on.
        const nextNode = continueMathExpression(state, walk(state, lastNode, node), node);
        if (nextNode === null) {
            break;
        }
        lastNode = nextNode;
        node.elements.push(nextNode);
        if (
            tokens[state.current]?.type === TOKEN_TYPES.COMMA ||
            tokens[state.current]?.type === TOKEN_TYPES.SEMICOLON
        ) {
            // Record the terminator on the element: a separated name before a `{`/`[` body
            // is two legal elements, only an unseparated one merges into the body's line.
            if (isValueNode(nextNode) || isIdentifierNode(nextNode)) {
                nextNode.delimiter = tokens[state.current].type === TOKEN_TYPES.COMMA ? ',' : ';';
            }
            reportOrphanTerminator(state, state.current);
            state.current++;
            // A comma/semicolon ends the entry, so the next element starts fresh. Clearing
            // `lastNode` lets a leading `-N` read as a negative literal (`[0, -1]` is the pair
            // 0 and -1) instead of a subtraction continuing the previous value (`0 - 1`).
            lastNode = undefined;
        }
        if (tokens[state.current] === undefined) {
            break;
        }
    }
    if (tokens[state.current]?.type === TOKEN_TYPES.RIGHT_BRACKET) {
        node.position.characterEnd = tokens[state.current].lineOffset;
        node.position.end = tokens[state.current].end ?? 0;
        state.current++;
    } else {
        errors.push({
            message: l10n.t('Expected right bracket to close the list'),
            token,
        } as ParserError);
    }
    return node;
};
