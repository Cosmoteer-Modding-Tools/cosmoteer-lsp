import { DocumentUri } from 'vscode-languageserver';
import { Token, TOKEN_TYPES } from '../lexer/lexer';
import { AbstractNode, AbstractNodeDocument, GroupNode, IdentifierNode, ListNode, ValueNode } from '../ast/ast';
import * as l10n from '@vscode/l10n';
import { IS_NUMBER } from './infer-value-type';
import { ParserError, ParserState, TokenParserResult } from './parser.types';
import { parseGroup } from './parse-group';
import { parseList } from './parse-list';
import { parseExpression } from './parse-expression';
import { parseString } from './parse-string';
import { parseCallOrParenGroup } from './parse-function-call';
import { parseBoolean, parseStrayRightParen, parseValue } from './parse-value';
import { parseInheritance } from './parse-inheritance';
import { tokenDisplayText } from './token-display';
import { reportOrphanTerminator } from './parse-terminator';

// A file this broken carries no usable tree past this point, so parsing stops to bound the work.
// Deliberately not the user's `maxNumberOfProblems`: the parse result is cached and persisted by
// content, so it must not vary with a setting, and both diagnostic sites truncate on the setting
// anyway.
const MAX_PARSER_ERRORS = 100;

/**
 * Reads the next node out of the token stream, dispatching on the token the cursor sits on. Every
 * branch consumes the tokens it read, so the caller can keep reading where this one stopped.
 *
 * @param state the parse state, positioned on the token to read.
 * @param _lastNode the node the container read before this one, which decides whether an operator
 * is a sign or a binary operator and whether an identifier names what follows it.
 * @param parent the container the node belongs to.
 * @returns the node read, or null when the token carried none.
 */
export const walk = (
    state: ParserState,
    _lastNode?: AbstractNode,
    parent?: GroupNode | ListNode | AbstractNodeDocument
): AbstractNode | null => {
    const { tokens, errors } = state;
    const token = tokens[state.current];
    if (!token) {
        return null;
    }

    if (token.type === TOKEN_TYPES.LEFT_BRACE) {
        return parseGroup(state, token, _lastNode, parent);
    }

    if (token.type === TOKEN_TYPES.RIGHT_BRACE) {
        errors.push({
            message: l10n.t('Not expected right brace, did you mean to open a group?'),
            token,
        } as ParserError);
        state.current++;
        return null;
    }

    if (token.type === TOKEN_TYPES.LEFT_BRACKET) {
        return parseList(state, token, _lastNode, parent);
    }

    if (token.type === TOKEN_TYPES.RIGHT_BRACKET) {
        errors.push({
            message: l10n.t('Not expected bracket, did you mean to open a list?'),
            token,
        } as ParserError);
        state.current++;
        return null;
    }

    if (token.type === TOKEN_TYPES.COMMA && _lastNode?.type === 'Value') {
        state.current++;
        (_lastNode as ValueNode).delimiter = ',';
        return walk(state, _lastNode, parent);
    } else if (token.type === TOKEN_TYPES.COMMA) {
        state.current++;
        errors.push({
            message: l10n.t('Not expected comma'),
            token,
        } as ParserError);
        return null;
    }

    if (token.type === TOKEN_TYPES.STRING) {
        return parseString(state, token, parent);
    }

    if (token.type === TOKEN_TYPES.TRUE || token.type === TOKEN_TYPES.FALSE) {
        return parseBoolean(state, token, parent);
    }

    if (token.type === TOKEN_TYPES.EXPRESSION) {
        return parseExpression(state, token, _lastNode, parent);
    }

    if (
        (token.type === TOKEN_TYPES.VALUE &&
            !IS_NUMBER.test(token.value as string) &&
            tokens[state.current + 1] &&
            tokens[state.current + 1].type === TOKEN_TYPES.LEFT_PAREN) ||
        token.type === TOKEN_TYPES.LEFT_PAREN
    ) {
        return parseCallOrParenGroup(state, token, _lastNode, parent);
    }

    if (token.type === TOKEN_TYPES.VALUE) {
        return parseValue(state, token, _lastNode, parent);
    }

    if (token.type === TOKEN_TYPES.COLON) {
        return parseInheritance(state, token, _lastNode, parent);
    }

    if (token.type === TOKEN_TYPES.RIGHT_PAREN) {
        return parseStrayRightParen(state, token, _lastNode, parent);
    }

    if (token.type === TOKEN_TYPES.UNEXPECTED) {
        errors.push({
            message: l10n.t('Unknown token type'),
            token,
            additionalInfo: [
                {
                    message: l10n.t(
                        'This could be a bug in the parser or lexer, please report this issue, if you think this is a bug'
                    ),
                },
            ],
        } as ParserError);
        state.current++;
        return null;
    }
    // A known token in a position no rule accepts, e.g. the stray `=` in `X = &<a>, = &<b>`.
    // The game's OTGroupNode.Parse throws the same way (`Unexpected "=" at position …`), so this
    // is invalid input, not a parser bug.
    errors.push({
        message: l10n.t('Unexpected "{0}"', tokenDisplayText(token)),
        token,
    } as ParserError);
    state.current++;
    return null;
};

/**
 * Parses a token stream into the document tree.
 *
 * @param tokens the tokens the lexer produced for the document.
 * @param uri the document the tokens came from.
 * @returns the document tree and every parse error found while building it.
 */
export const parser = (tokens: Token[], uri: DocumentUri): TokenParserResult => {
    const state: ParserState = { tokens, current: 0, errors: [], uri };

    const ast: AbstractNodeDocument = {
        type: 'Document',
        elements: [],
        position: {
            characterEnd: 0,
            characterStart: 0,
            end: 0,
            line: 0,
            start: 0,
        },
        uri,
    };

    while (state.current < tokens.length) {
        // A `;` or `,` terminates a top-level field or void entry (ObjectText treats both as the
        // node terminator, see OTGroupedReferenceNode: `Foo;` / `Bar = 1,`). Consume it and clear
        // `lastNode` so the completed entry is not bound to whatever follows, e.g. a void `Foo;`
        // must not become the identifier of a subsequent `Bar { … }` group.
        if (tokens[state.current].type === TOKEN_TYPES.SEMICOLON || tokens[state.current].type === TOKEN_TYPES.COMMA) {
            reportOrphanTerminator(state, state.current);
            state.current++;
            state.lastNode = undefined;
            continue;
        }
        const nextNode = walk(state, state.lastNode, ast);
        if (state.errors.length > MAX_PARSER_ERRORS) {
            break;
        }
        if (!nextNode) {
            continue;
        }
        if (state.lastNode?.type === 'Identifier' && nextNode.type === 'List') {
            (nextNode as ListNode).identifier = state.lastNode as IdentifierNode;
        }
        if (state.lastNode?.type === 'Identifier' && nextNode.type === 'Group') {
            (nextNode as GroupNode).identifier = state.lastNode as IdentifierNode;
        }
        state.lastNode = nextNode;
        ast.elements.push(nextNode);
    }

    return { value: ast, parserErrors: state.errors };
};
