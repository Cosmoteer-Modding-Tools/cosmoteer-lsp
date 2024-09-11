import { Token, TOKEN_TYPES } from '../lexer/lexer';
import { MAX_NUMBER_OF_PROBLEMS } from '../server';
import {
    AbstractNode,
    AbstractNodeDocument,
    ArrayNode,
    AssignmentNode,
    ExpressionNode,
    FunctionCallNode,
    IdentifierNode,
    InheritanceNode,
    ObjectNode,
    ValueNode,
} from './ast';
import * as l10n from '@vscode/l10n';
/**
 * TODO add Parser per Object to beatufy the code below lol
 */
abstract class Parser {
    abstract parse(): void;
}

export const parser = (tokens: Token[]): TokenParserResult => {
    let current = 0;
    const errors: ParserError[] = [];
    const IS_NUMBER = /[-.]?^[\d]+[.]?[\d]*$/;
    // TODO: Add Identifier to object and array if exists
    // TODO: Add Function calls and expressions to assignment nodes
    const walk = (
        _lastNode?: AbstractNode,
        parent?: ObjectNode | ArrayNode | AbstractNodeDocument
    ): AbstractNode | null => {
        const token = tokens[current];
        if (!token) {
            return null;
        }

        if (token.type === TOKEN_TYPES.LEFT_BRACE) {
            current++;
            const node: ObjectNode = {
                type: 'Object',
                elements: [],
                parent,
                position: {
                    line: token.lineNumber,
                    characterStart: token.lineOffset,
                    characterEnd: 0,
                    start: token.start,
                    end: 0,
                },
            };
            if (!tokens[current]) {
                errors.push({
                    message: l10n.t(
                        'Expected right brace but found end of file'
                    ),
                    token,
                } as ParserError);
                return node;
            }

            let lastNode: AbstractNode = node;
            while (tokens[current].type !== TOKEN_TYPES.RIGHT_BRACE) {
                const nextNode = walk(lastNode, node);
                if (!nextNode) {
                    break;
                }
                lastNode = nextNode;
                node.elements.push(nextNode);
                if (
                    tokens[current] &&
                    tokens[current].type === TOKEN_TYPES.SEMICOLON
                ) {
                    current++;
                }
                if (!tokens[current]) {
                    break;
                }
            }
            if (tokens[current]?.type === TOKEN_TYPES.RIGHT_BRACE) {
                node.position.characterEnd = tokens[current].lineOffset;
                node.position.end = tokens[current].end ?? 0;
                current++;
            } else {
                console.warn(tokens[current]);
                errors.push({
                    message: l10n.t('Expected right brace'),
                    token,
                } as ParserError);
            }
            return node;
        }

        if (token.type === TOKEN_TYPES.RIGHT_BRACE) {
            errors.push({
                message: l10n.t('Not expected token'),
                token,
            } as ParserError);
            current++;
            return null;
        }

        if (token.type === TOKEN_TYPES.LEFT_BRACKET) {
            current++;
            const node = {
                type: 'Array',
                parent,
                elements: [],
                position: {
                    line: token.lineNumber,
                    characterStart: token.lineOffset,
                    characterEnd: 0,
                    start: token.start,
                    end: 0,
                },
            } as ArrayNode;
            if (!tokens[current]) {
                errors.push({
                    message: l10n.t(
                        'Expected right bracket but found end of file'
                    ),
                    token,
                } as ParserError);
                return node;
            }
            let lastNode: AbstractNode = node;
            while (
                tokens[current] &&
                tokens[current].type !== TOKEN_TYPES.RIGHT_BRACKET
            ) {
                const nextNode = walk(lastNode, node);
                if (nextNode === null) {
                    break;
                }
                lastNode = nextNode;
                node.elements.push(nextNode);
                if (
                    tokens[current]?.type === TOKEN_TYPES.COMMA ||
                    tokens[current]?.type === TOKEN_TYPES.SEMICOLON
                ) {
                    current++;
                }
                if (tokens[current] === undefined) {
                    break;
                }
            }
            if (tokens[current]?.type === TOKEN_TYPES.RIGHT_BRACKET) {
                node.position.characterEnd = tokens[current].lineOffset;
                node.position.end = tokens[current].end ?? 0;
                current++;
            } else {
                console.warn(tokens[current]);
                errors.push({
                    message: l10n.t('Expected right bracket'),
                    token,
                } as ParserError);
            }
            return node;
        }

        if (token.type === TOKEN_TYPES.RIGHT_BRACKET) {
            errors.push({
                message: l10n.t('Not expected bracket'),
                token,
            } as ParserError);
            current++;
            return null;
        }

        if (token.type === TOKEN_TYPES.COMMA && _lastNode?.type === 'Value') {
            current++;
            (_lastNode as ValueNode).delimiter = ',';
            return walk(_lastNode, parent);
        } else if (token.type === TOKEN_TYPES.COMMA) {
            current++;
            errors.push({
                message: l10n.t('Not expected comma'),
                token,
            } as ParserError);
            return null;
        }

        if (token.type === TOKEN_TYPES.STRING) {
            current++;
            return {
                type: 'Value',
                valueType: 'String',
                values: token.value,
                parent,
                position: {
                    characterEnd:
                        token.lineOffset + (token.value as string)?.length,
                    characterStart: token.lineOffset,
                    end: token.end ?? 0,
                    line: token.lineNumber,
                    start: token.start,
                },
            } as ValueNode;
        }

        if (token.type === TOKEN_TYPES.TRUE) {
            current++;
            return {
                type: 'Value',
                valueType: 'Boolean',
                values: true,
                parent,
                position: {
                    characterEnd: token.lineOffset + 4,
                    characterStart: token.lineOffset,
                    end: token.end ?? 0,
                    line: token.lineNumber,
                    start: token.start,
                },
            } as ValueNode;
        }

        if (token.type === TOKEN_TYPES.FALSE) {
            current++;
            return {
                type: 'Value',
                valueType: 'Boolean',
                parent,
                values: false,
                position: {
                    characterEnd: token.lineOffset + 5,
                    characterStart: token.lineOffset,
                    end: token.end ?? 0,
                    line: token.lineNumber,
                    start: token.start,
                },
            } as ValueNode;
        }

        if (token.type === TOKEN_TYPES.EXPRESSION) {
            current++;
            // case for negative numbers last token is not a value and next token is a value and is a number
            const tokenValue = tokens[current]?.value;
            if (
                tokenValue &&
                tokens[current - 2] &&
                tokens[current].type === TOKEN_TYPES.VALUE &&
                IS_NUMBER.test(tokenValue) &&
                tokens[current - 2].type !== TOKEN_TYPES.VALUE
            ) {
                const value = -tokenValue;
                current++;
                return {
                    type: 'Value',
                    valueType: 'Number',
                    values: value,
                    parent,
                    position: {
                        characterEnd:
                            token.lineOffset +
                            (value as number).toString().length,
                        characterStart: token.lineOffset,
                        end: tokens[current].end ?? 0,
                        line: token.lineNumber,
                        start: token.start,
                    },
                } as ValueNode;
            }
            // case for Values starting with /
            else if (
                tokenValue &&
                token.value === '/' &&
                tokens[current].type === TOKEN_TYPES.VALUE
            ) {
                const value = '/' + tokenValue;
                current++;
                return {
                    type: 'Value',
                    valueType: 'Reference',
                    values: value,
                    parent,
                    position: {
                        characterEnd: token.lineOffset + value.length,
                        characterStart: token.lineOffset,
                        end: tokens[current].end ?? 0,
                        line: token.lineNumber,
                        start: token.start,
                    },
                } as ValueNode;
            }
            return {
                type: 'Expression',
                expressionType: token.value as '+' | '-' | '*' | '/',
                parent,
                position: {
                    characterEnd: token.lineOffset + 1,
                    characterStart: token.lineOffset,
                    end: token.end ?? 0,
                    line: token.lineNumber,
                    start: token.start,
                },
            } as ExpressionNode;
        }

        if (
            (token.type === TOKEN_TYPES.VALUE &&
                tokens[current + 1] &&
                tokens[current + 1].type === TOKEN_TYPES.LEFT_PAREN) ||
            token.type === TOKEN_TYPES.LEFT_PAREN
        ) {
            // handle case for a function call
            if (token.type === TOKEN_TYPES.VALUE) {
                const name = token.value;
                current += 2;
                if (
                    tokens[current]?.type === TOKEN_TYPES.VALUE ||
                    tokens[current]?.type === TOKEN_TYPES.LEFT_PAREN
                ) {
                    let startWithParens = false;
                    if (tokens[current]?.type === TOKEN_TYPES.LEFT_PAREN) {
                        current++;
                        startWithParens = true;
                    }
                    const valueType:
                        | 'String'
                        | 'Number'
                        | 'Reference'
                        | 'Sprite' = inferValueType(IS_NUMBER, tokens[current]);
                    const args: ValueNode[] = [
                        {
                            type: 'Value',
                            valueType: valueType,
                            values: tokens[current].value as string,
                            parent,
                            position: {
                                characterEnd:
                                    token.lineOffset +
                                    (tokens[current].value as string).length,
                                characterStart: token.lineOffset,
                                end: tokens[current].end ?? 0,
                                line: token.lineNumber,
                                start: token.start,
                            },
                        },
                    ];
                    current++;
                    if (
                        startWithParens &&
                        tokens[current]?.type === TOKEN_TYPES.RIGHT_PAREN
                    ) {
                        args[0].parenthesized = true;
                        current++;
                    } else if (startWithParens) {
                        errors.push({
                            message: l10n.t(
                                'Expected right paren for reference'
                            ),
                            token,
                        } as ParserError);
                    }
                    lastNode = args[0];
                    while (
                        tokens[current] &&
                        tokens[current].type !== TOKEN_TYPES.RIGHT_PAREN
                    ) {
                        const nextNode = walk(lastNode, parent);
                        if (!nextNode) {
                            break;
                        }
                        lastNode = nextNode;
                        if (
                            nextNode.type === 'Value' ||
                            nextNode.type === 'Expression' ||
                            nextNode.type === 'FunctionCall'
                        ) {
                            args.push(nextNode as ValueNode);
                        } else {
                            throw new Error('Invalid argument type');
                        }
                        if (tokens[current]?.type === TOKEN_TYPES.COMMA) {
                            current++;
                        }
                        if (tokens[current] === undefined) {
                            break;
                        }
                    }
                    if (
                        tokens[current] &&
                        tokens[current].type === TOKEN_TYPES.RIGHT_PAREN
                    ) {
                        current++;
                    }
                    return {
                        type: 'FunctionCall',
                        name,
                        arguments: args,
                        position: {
                            characterEnd:
                                token.lineOffset + (name?.length ?? 0),
                            characterStart: token.lineOffset,
                            end: tokens[current - 1]?.start ?? 0,
                            line: token.lineNumber,
                            start: token.start,
                        },
                        parent,
                    } as FunctionCallNode;
                }
            } else {
                current++;
                const node = walk(_lastNode, parent) as ValueNode;
                if (!node) {
                    errors.push({
                        message: l10n.t('Expected value'),
                        token,
                    } as ParserError);
                    return null;
                }
                if (
                    tokens[current] &&
                    tokens[current].type === TOKEN_TYPES.RIGHT_PAREN
                ) {
                    current++;
                }
                node.parenthesized = true;
                return node;
            }
        }

        if (token.type === TOKEN_TYPES.VALUE) {
            current++;
            let node: AbstractNode;
            if (
                tokens[current] &&
                tokens[current].type === TOKEN_TYPES.EQUALS
            ) {
                current++;
                if (current >= tokens.length) {
                    errors.push({
                        message: l10n.t('Expected value'),
                        token,
                    } as ParserError);
                    return null;
                }
                node = {
                    type: 'Assignment',
                    assignmentType: 'Equals',
                    parent,
                    left: {
                        type: 'Identifier',
                        name: token.value,
                        parent,
                        position: {
                            characterEnd:
                                token.lineOffset +
                                (token.value as string)?.length,
                            characterStart: token.lineOffset,
                            end: token.end ?? 0,
                            line: token.lineNumber,
                            start: token.start,
                        },
                    } as IdentifierNode,
                    right: walk(_lastNode, parent),
                } as AssignmentNode;
            } else if (
                token.value &&
                tokens[current - 2] &&
                (tokens[current - 2].type === TOKEN_TYPES.EQUALS ||
                    tokens[current - 2].type === TOKEN_TYPES.COLON ||
                    tokens[current - 2].type === TOKEN_TYPES.COMMA ||
                    tokens[current - 2].type === TOKEN_TYPES.LEFT_BRACKET ||
                    tokens[current - 2].type === TOKEN_TYPES.EXPRESSION ||
                    tokens[current - 2].type === TOKEN_TYPES.LEFT_PAREN ||
                    _lastNode?.type === 'Value')
            ) {
                const valueType: 'String' | 'Number' | 'Reference' | 'Sprite' =
                    inferValueType(IS_NUMBER, token);

                node = {
                    type: 'Value',
                    valueType,
                    values: token.value,
                    parent,
                    position: {
                        characterEnd:
                            token.lineOffset + (token.value as string)?.length,
                        characterStart: token.lineOffset,
                        end: token.end ?? 0,
                        line: token.lineNumber,
                        start: token.start,
                    },
                } as ValueNode;
            } else {
                node = {
                    type: 'Identifier',
                    name: token.value,
                    parent,
                    position: {
                        characterEnd:
                            token.lineOffset + (token.value as string)?.length,
                        characterStart: token.lineOffset,
                        end: token.end ?? 0,
                        line: token.lineNumber,
                        start: token.start,
                    },
                } as IdentifierNode;
            }
            return node;
        }

        if (token.type === TOKEN_TYPES.COLON) {
            current++;
            if (current >= tokens.length) {
                errors.push({
                    message: l10n.t('Expected value in colon'),
                    token,
                } as ParserError);
                return null;
            }
            const inheritanceNodes: ValueNode[] = [];
            let identifierNode = undefined;
            if (_lastNode?.type === 'Identifier') {
                identifierNode = _lastNode as IdentifierNode;
            }
            let lastNode: AbstractNode | undefined | null = _lastNode;
            // check for next value or the special case with Expression(/) + Value
            while (
                tokens[current] &&
                (tokens[current].type === TOKEN_TYPES.VALUE ||
                    (tokens[current].type === TOKEN_TYPES.EXPRESSION &&
                        tokens[current + 1]?.type === TOKEN_TYPES.VALUE))
            ) {
                const nextNode = walk(lastNode ?? undefined, parent);
                lastNode = nextNode;
                if (!nextNode) {
                    break;
                }
                if (nextNode.type === 'Value') {
                    inheritanceNodes.push(nextNode as ValueNode);
                } else {
                    errors.push({
                        message: l10n.t(
                            'Expected value after value but found {0}',
                            nextNode.type
                        ),
                        token: tokens[current],
                    } as ParserError);
                }
                if (tokens[current] === undefined) {
                    break;
                }
            }
            let right: ObjectNode | ArrayNode | undefined = undefined;
            if (tokens[current]?.type === TOKEN_TYPES.LEFT_BRACE) {
                right = walk(_lastNode, parent) as ObjectNode;
            } else if (tokens[current]?.type === TOKEN_TYPES.LEFT_BRACKET) {
                right = walk(_lastNode, parent) as ArrayNode;
            }

            return {
                type: 'Inheritance',
                left: identifierNode,
                inheritance: inheritanceNodes,
                right,
                parent,
            } as InheritanceNode;
        }

        if (
            token.type === TOKEN_TYPES.SINGLE_COMMENT ||
            token.type === TOKEN_TYPES.MULTI_COMMENT
        ) {
            current++;
            return walk(_lastNode, parent);
        }

        if (token.type === TOKEN_TYPES.RIGHT_PAREN) {
            errors.push({
                message: l10n.t('Not expected paren'),
                token,
            } as ParserError);
            current++;
            return null;
        }

        // Invalid Section
        errors.push({
            message: l10n.t('Unknown token type'),
            token,
        } as ParserError);
        console.log(token);
        current++;
        return null;
    };

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
    };

    let lastNode = undefined;
    while (current < tokens.length) {
        const nextNode = walk(lastNode, ast);
        if (errors.length > MAX_NUMBER_OF_PROBLEMS) {
            break;
        }
        if (!nextNode) {
            continue;
        }
        if (lastNode?.type === 'Identifier' && nextNode.type === 'Array') {
            (nextNode as ArrayNode).identifier = lastNode as IdentifierNode;
        }
        if (lastNode?.type === 'Identifier' && nextNode.type === 'Object') {
            (nextNode as ObjectNode).identifier = lastNode as IdentifierNode;
        }
        lastNode = nextNode;
        ast.elements.push(nextNode);
    }

    return { value: ast, parserErrors: errors };
};

export type ParserError = {
    message: string;
    token: Token;
};

export interface TokenParserResult {
    value: AbstractNodeDocument;
    parserErrors: ParserError[];
}

function inferValueType(IS_NUMBER: RegExp, token: Token) {
    if (!token.value) throw new Error('Token value is undefined');
    let valueType: 'String' | 'Number' | 'Reference' | 'Sprite' =
        IS_NUMBER.test(token.value) ? 'Number' : 'String';
    if (valueType === 'String' && token.value.includes('.png')) {
        valueType = 'Sprite';
    }
    if (token.value.includes('&') || token.value.includes('<')) {
        valueType = 'Reference';
    }
    return valueType;
}
