import { Token, TOKEN_TYPES } from '../lexer/lexer';
import { AbstractNode, AbstractNodeDocument, GroupNode, ListNode, isIdentifierNode } from '../ast/ast';
import * as l10n from '@vscode/l10n';
import { ParserError, ParserState } from './parser.types';
import { isListElementIdentifier } from './parse-list';
import { reportOrphanTerminator } from './parse-terminator';

/**
 * Reads a `{ … }` group body. The opening brace has already been seen, so the body is collected
 * until the matching `}`, an unreadable member or the end of the file ends it.
 *
 * @param state the parse state, positioned on the opening brace.
 * @param token the opening brace.
 * @param _lastNode the node read before the brace, which names the group when it is an identifier.
 * @param parent the container the group belongs to.
 * @returns the group, even when its closing brace never came.
 */
export const parseGroup = (
    state: ParserState,
    token: Token,
    _lastNode: AbstractNode | undefined,
    parent?: GroupNode | ListNode | AbstractNodeDocument
): GroupNode => {
    const { tokens, errors } = state;
    state.current++;
    const node: GroupNode = {
        type: 'Group',
        elements: [],
        // An identifier element in a list never names the container that follows it
        // (the game keeps it a standalone element and the body opens a separate
        // anonymous element), so it must not be consumed as this group's identifier.
        identifier:
            _lastNode && isIdentifierNode(_lastNode) && !isListElementIdentifier(parent) ? _lastNode : undefined,
        parent,
        position: {
            line: token.lineNumber,
            characterStart: token.lineOffset,
            characterEnd: 0,
            start: token.start,
            end: 0,
        },
    };
    if (!tokens[state.current]) {
        errors.push({
            message: l10n.t('Expected right brace but found end of file'),
            token,
        } as ParserError);
        return node;
    }

    let lastNode: AbstractNode = node;
    while (tokens[state.current]?.type !== TOKEN_TYPES.RIGHT_BRACE) {
        const before = state.current;
        const nextNode = state.walk(state, lastNode, node);
        if (!nextNode) {
            // A member that read its tokens and still built nothing, an inheritance whose body
            // never came being the one that happens while typing. The group has to keep
            // reading, or one unfinished member costs every member after it. Guarded on the
            // cursor having moved, so a walk that declines without consuming still ends the
            // body instead of spinning.
            if (state.current > before && tokens[state.current]) continue;
            break;
        }
        lastNode = nextNode;
        node.elements.push(nextNode);
        if (
            tokens[state.current] &&
            (tokens[state.current].type === TOKEN_TYPES.SEMICOLON || tokens[state.current].type === TOKEN_TYPES.COMMA)
        ) {
            reportOrphanTerminator(state, state.current);
            state.current++;
        }
        if (!tokens[state.current]) {
            break;
        }
    }
    if (tokens[state.current]?.type === TOKEN_TYPES.RIGHT_BRACE) {
        node.position.characterEnd = tokens[state.current].lineOffset;
        node.position.end = tokens[state.current].end ?? 0;
        state.current++;
    } else {
        errors.push({
            message: l10n.t('Expected right brace to close the group'),
            token,
        } as ParserError);
    }
    return node;
};
