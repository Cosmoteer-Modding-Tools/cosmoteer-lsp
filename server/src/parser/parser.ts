import { DocumentUri } from 'vscode-languageserver';
import { Token, TOKEN_TYPES } from '../lexer/lexer';
import { MAX_NUMBER_OF_PROBLEMS } from '../server';
import { ALLOWED_AUDIO_EXTENSIONS } from '../utils/constants';
import {
    AbstractNode,
    AbstractNodeDocument,
    ArrayNode,
    AssignmentNode,
    ExpressionNode,
    FunctionCallNode,
    IdentifierNode,
    isExpressionNode,
    isIdentifierNode,
    isMathExpressionNode,
    isValueNode,
    MathExpressionNode,
    ObjectNode,
    ValueNode,
    ValueNodeTypes,
} from './ast';
import * as l10n from '@vscode/l10n';
/**
 * TODO add Parser per Object to beatufy the code below lol
 */
abstract class Parser {
    abstract parse(): void;
}

export const parser = (tokens: Token[], uri: DocumentUri): TokenParserResult => {
    let current = 0;
    const errors: ParserError[] = [];
    const IS_NUMBER = /[-.]?^[\d]+[.]?[\d]*d?$/;
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
                identifier: _lastNode ? (isIdentifierNode(_lastNode) ? _lastNode : undefined) : undefined,
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
                    message: l10n.t('Expected right brace but found end of file'),
                    token,
                } as ParserError);
                return node;
            }

            let lastNode: AbstractNode = node;
            while (tokens[current]?.type !== TOKEN_TYPES.RIGHT_BRACE) {
                const nextNode = walk(lastNode, node);
                if (!nextNode) {
                    break;
                }
                lastNode = nextNode;
                node.elements.push(nextNode);
                if (
                    tokens[current] &&
                    (tokens[current].type === TOKEN_TYPES.SEMICOLON || tokens[current].type === TOKEN_TYPES.COMMA)
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
                errors.push({
                    message: l10n.t('Expected right brace to close the object'),
                    token,
                } as ParserError);
            }
            return node;
        }

        if (token.type === TOKEN_TYPES.RIGHT_BRACE) {
            errors.push({
                message: l10n.t('Not expected right brace, did you mean to open an object?'),
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
                identifier: _lastNode ? (isIdentifierNode(_lastNode) ? _lastNode : undefined) : undefined,
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
                    message: l10n.t('Expected right bracket but found end of file'),
                    token,
                } as ParserError);
                return node;
            }
            let lastNode: AbstractNode = node;
            while (tokens[current] && tokens[current].type !== TOKEN_TYPES.RIGHT_BRACKET) {
                const nextNode = walk(lastNode, node);
                if (nextNode === null) {
                    break;
                }
                lastNode = nextNode;
                node.elements.push(nextNode);
                if (tokens[current]?.type === TOKEN_TYPES.COMMA || tokens[current]?.type === TOKEN_TYPES.SEMICOLON) {
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
                errors.push({
                    message: l10n.t('Expected right bracket to close the array'),
                    token,
                } as ParserError);
            }
            return node;
        }

        if (token.type === TOKEN_TYPES.RIGHT_BRACKET) {
            errors.push({
                message: l10n.t('Not expected bracket, did you mean to open an array?'),
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
            let value = token.value as string;
            let lastType: 'STRING' | 'STRING_DELIMITER' = 'STRING';
            while (
                (tokens[current]?.type === TOKEN_TYPES.STRING ||
                    tokens[current]?.type === TOKEN_TYPES.STRING_DELIMITER) &&
                lastType !== tokens[current]?.type
            ) {
                lastType = tokens[current]?.type as 'STRING' | 'STRING_DELIMITER';
                if (
                    tokens[current]?.type === TOKEN_TYPES.STRING_DELIMITER &&
                    tokens[current + 1]?.type !== TOKEN_TYPES.STRING
                ) {
                    break;
                }
                if (tokens[current]?.type === TOKEN_TYPES.STRING_DELIMITER) {
                    current++;
                    continue;
                }
                value += tokens[current].value as string;
                current++;
            }
            return {
                type: 'Value',
                valueType: inferValueType(IS_NUMBER, token),
                parent,
                position: {
                    characterEnd: token.lineOffset + value?.length,
                    characterStart: token.lineOffset,
                    end: token.end ?? 0,
                    line: token.lineNumber,
                    start: token.start,
                },
                quoted: true,
            } as ValueNode;
        }

        if (token.type === TOKEN_TYPES.TRUE) {
            current++;
            return {
                type: 'Value',
                valueType: {
                    type: 'Boolean',
                    value: true,
                },
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
                valueType: {
                    type: 'Boolean',
                    value: false,
                },
                parent,
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
                tokens[current]?.type === TOKEN_TYPES.VALUE &&
                IS_NUMBER.test(tokenValue) &&
                _lastNode?.type !== 'Value'
            ) {
                const value = -tokenValue;
                current++;
                return {
                    type: 'Value',
                    valueType: {
                        type: 'Number',
                        value: value,
                    },
                    parent,
                    position: {
                        characterEnd: token.lineOffset + (value as number).toString().length,
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
                tokens[current]?.type === TOKEN_TYPES.VALUE &&
                !IS_NUMBER.test(tokenValue)
            ) {
                const value = '/' + tokenValue;
                current++;
                return {
                    type: 'Value',
                    valueType: {
                        type: 'Reference',
                        value: value,
                    },
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
                !IS_NUMBER.test(token.value as string) &&
                tokens[current + 1] &&
                tokens[current + 1].type === TOKEN_TYPES.LEFT_PAREN) ||
            token.type === TOKEN_TYPES.LEFT_PAREN
        ) {
            // handle case for a function call
            if (token.type === TOKEN_TYPES.VALUE) {
                const name = token.value;
                current += 2;
                if (tokens[current]?.type === TOKEN_TYPES.VALUE || tokens[current]?.type === TOKEN_TYPES.LEFT_PAREN) {
                    let startWithParens = false;
                    if (tokens[current]?.type === TOKEN_TYPES.LEFT_PAREN) {
                        current++;
                        startWithParens = true;
                    }
                    const currentToken = tokens[current];
                    const args: ValueNode[] = [
                        {
                            type: 'Value',
                            valueType: inferValueType(IS_NUMBER, currentToken),
                            parent,
                            position: {
                                characterEnd: token.lineOffset + (tokens[current].value as string).length,
                                characterStart: token.lineOffset,
                                end: tokens[current].end ?? 0,
                                line: token.lineNumber,
                                start: tokens[current].start,
                            },
                        },
                    ];
                    current++;
                    if (startWithParens && tokens[current]?.type === TOKEN_TYPES.RIGHT_PAREN) {
                        args[0].parenthesized = true;
                        current++;
                    } else if (startWithParens) {
                        errors.push({
                            message: l10n.t('Expected right paren for reference'),
                            token,
                        } as ParserError);
                    }
                    lastNode = args[0];
                    while (tokens[current] && tokens[current].type !== TOKEN_TYPES.RIGHT_PAREN) {
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
                            errors.push({
                                message: l10n.t('Expected value, expression or function call'),
                                token,
                                addditionalInfo: [
                                    {
                                        message: l10n.t(
                                            'Values can be a number or a reference, expressions can be +, -, *, /'
                                        ),
                                    },
                                ],
                            } as ParserError);
                            current++;
                        }
                        if (tokens[current]?.type === TOKEN_TYPES.COMMA) {
                            current++;
                        }
                        if (tokens[current] === undefined) {
                            break;
                        }
                    }
                    if (tokens[current] && tokens[current].type === TOKEN_TYPES.RIGHT_PAREN) {
                        current++;
                    }
                    return {
                        type: 'FunctionCall',
                        name,
                        arguments: args,
                        position: {
                            characterEnd: token.lineOffset + (name?.length ?? 0),
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
                        message: l10n.t('Expected value after left paren'),
                        token,
                    } as ParserError);
                    return null;
                }
                if (tokens[current] && tokens[current].type === TOKEN_TYPES.RIGHT_PAREN) {
                    current++;
                    node.parenthesized = true;
                    return node;
                } else if (tokens[current]) {
                    const mathNode = {
                        type: 'MathExpression',
                        elements: [node],
                        parent,
                        position: {
                            characterEnd: node.position.characterEnd,
                            characterStart: node.position.characterStart,
                            end: node.position.end,
                            line: node.position.line,
                            start: node.position.start,
                        },
                    } as MathExpressionNode;
                    let lastNode: AbstractNode = node;
                    while (tokens[current] && tokens[current].type !== TOKEN_TYPES.RIGHT_PAREN) {
                        const nextNode = walk(lastNode, parent);
                        if (!nextNode) {
                            break;
                        }
                        if (isValueNode(nextNode) || isExpressionNode(nextNode) || isMathExpressionNode(nextNode)) {
                            mathNode.elements.push(nextNode);
                        } else {
                            errors.push({
                                message: l10n.t('Expected value or expression in math expression'),
                                token,
                            } as ParserError);
                        }
                        if (tokens[current] === undefined) {
                            break;
                        }
                        lastNode = nextNode;
                    }
                    if (tokens[current] && tokens[current].type !== TOKEN_TYPES.RIGHT_PAREN) {
                        errors.push({
                            message: l10n.t('Expected right paren'),
                            token,
                        } as ParserError);
                    }
                    current++;
                    return mathNode;
                }
                return null;
            }
        }

        if (token.type === TOKEN_TYPES.VALUE) {
            current++;
            let node: AbstractNode;
            if (tokens[current] && tokens[current].type === TOKEN_TYPES.EQUALS) {
                current++;
                if (current >= tokens.length) {
                    errors.push({
                        message: l10n.t('Expected value after equals'),
                        token,
                        addditionalInfo: [
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
                node = {
                    type: 'Assignment',
                    assignmentType: 'Equals',
                    parent,
                    left: {
                        type: 'Identifier',
                        name: token.value,
                        parent,
                        position: {
                            characterEnd: token.lineOffset + (token.value as string)?.length,
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
                node = {
                    type: 'Value',
                    valueType: inferValueType(IS_NUMBER, token),
                    parent,
                    position: {
                        characterEnd: token.lineOffset + (token.value as string)?.length,
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
                        characterEnd: token.lineOffset + (token.value as string)?.length,
                        characterStart: token.lineOffset,
                        end: token.end ?? 0,
                        line: token.lineNumber,
                        start: token.start,
                    },
                } as IdentifierNode;
                if (
                    tokens[current]?.type === TOKEN_TYPES.LEFT_BRACE ||
                    tokens[current]?.type === TOKEN_TYPES.LEFT_BRACKET ||
                    tokens[current]?.type === TOKEN_TYPES.COLON
                ) {
                    return walk(node, parent);
                }
            }
            return node;
        }

        if (token.type === TOKEN_TYPES.COLON) {
            current++;
            if (current >= tokens.length) {
                errors.push({
                    message: l10n.t('Expected value after colon'),
                    token,
                    addditionalInfo: [
                        {
                            message: l10n.t('Those Values should be a References'),
                        },
                    ],
                } as ParserError);
                return null;
            }
            const inheritanceNodes: ValueNode[] = [];
            let lastNode: AbstractNode | undefined | null = undefined;
            // check for next value or the special case with Expression(/) + Value
            while (
                tokens[current] &&
                (tokens[current].type === TOKEN_TYPES.VALUE ||
                    (tokens[current].type === TOKEN_TYPES.EXPRESSION &&
                        tokens[current + 1]?.type === TOKEN_TYPES.VALUE) ||
                    (tokens[current].type === TOKEN_TYPES.EXPRESSION && tokens[current].value === '/'))
            ) {
                const nextNode = walk(lastNode ?? undefined, parent);
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
                    inheritanceNodes.push(nextNode as ValueNode);
                } else {
                    errors.push({
                        message: l10n.t('Expected reference value after reference value but found {0}', nextNode.type),
                        token: tokens[current],
                    } as ParserError);
                }
                if (tokens[current] === undefined) {
                    break;
                }
                if (tokens[current]?.type === TOKEN_TYPES.COMMA) {
                    current++;
                    continue;
                }
            }
            let right: ArrayNode | ObjectNode | null = null;
            if (tokens[current]?.type === TOKEN_TYPES.LEFT_BRACE) {
                right = walk(_lastNode, parent) as ObjectNode;
            } else if (tokens[current]?.type === TOKEN_TYPES.LEFT_BRACKET) {
                right = walk(_lastNode, parent) as ArrayNode;
            }
            if (right) {
                // Inheritance nodes parent is the right node
                right.inheritance = inheritanceNodes.map((v) => {
                    v.parent = right;
                    return v;
                });
            }
            return right;
        }

        if (token.type === TOKEN_TYPES.SINGLE_COMMENT || token.type === TOKEN_TYPES.MULTI_COMMENT) {
            current++;
            return walk(_lastNode, parent);
        }

        if (token.type === TOKEN_TYPES.RIGHT_PAREN && _lastNode?.type !== 'Value') {
            errors.push({
                message: l10n.t('Not expected paren'),
                token,
            } as ParserError);
            current++;
            return null;
        } else if (token.type === TOKEN_TYPES.RIGHT_PAREN && _lastNode?.type === 'Value') {
            current++;
            return walk(_lastNode, parent);
        }

        if (token.type === TOKEN_TYPES.STRING_DELIMITER) {
            current++;
            errors.push({
                message: l10n.t('String delimiters are only allowed after a String'),
                token,
            } as ParserError);
            return walk(_lastNode, parent);
        }

        // Invalid Section
        errors.push({
            message: l10n.t('Unknown token type'),
            token,
            addditionalInfo: [
                {
                    message: l10n.t(
                        'This could be a bug in the parser or lexer, please report this issue, if you think this is a bug'
                    ),
                },
            ],
        } as ParserError);
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
        uri,
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
    addditionalInfo?: Pick<ParserError, 'message' | 'token'>[];
};

export interface TokenParserResult {
    value: AbstractNodeDocument;
    parserErrors: ParserError[];
}

function inferValueType(IS_NUMBER: RegExp, token: Token): ValueNodeTypes {
    if (typeof token.value === 'undefined') throw new Error('Token value is undefined');
    let value: ValueNodeTypes['value'] = token.value;
    let valueType: ValueNodeTypes['type'] = IS_NUMBER.test(token.value) ? 'Number' : 'String';
    const IS_SOUND = new RegExp(ALLOWED_AUDIO_EXTENSIONS.join('|').replaceAll('.', '\\.'));
    if (valueType === 'String' && token.value.includes('.png')) {
        valueType = 'Sprite';
        value = value as string;
    } else if (valueType === 'String' && IS_SOUND.test(token.value)) {
        valueType = 'Sound';
        value = value as string;
    } else if (valueType === 'String' && token.value.endsWith('.shader')) {
        valueType = 'Shader';
        value = value as string;
    } else if (
        token.value.startsWith('&') ||
        token.value.startsWith('^') ||
        token.value.startsWith('..') ||
        token.value.startsWith('/') ||
        token.value.startsWith('~') ||
        (token.value.startsWith('<') && token.value.includes('.rules'))
    ) {
        return {
            type: 'Reference',
            value: token.value,
        };
    }
    if (valueType === 'Number') {
        return { type: 'Number', value: parseFloat(value as string) };
    }
    return { type: valueType, value: value };
}
