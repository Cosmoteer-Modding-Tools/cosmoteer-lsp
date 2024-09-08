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
    const walk = (_lastNode?: AbstractNode): AbstractNode | null => {
        const token = tokens[current];
        if (!token) {
            return null;
        }

        if (token.type === TOKEN_TYPES.LEFT_BRACE) {
            current++;
            const node: ObjectNode = {
                type: 'Object',
                properties: [],
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
                    message: 'Expected Right Brace',
                    token,
                } as ParserError);
                return node;
            }

            let lastNode: AbstractNode = node;
            while (tokens[current].type !== TOKEN_TYPES.RIGHT_BRACE) {
                const nextNode = walk(lastNode);
                if (!nextNode) {
                    break;
                }
                lastNode = nextNode;
                node.properties.push(nextNode);
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
                errors.push({
                    message: 'Expected Right Brace',
                    token,
                } as ParserError);
            }
            return node;
        }

        if (token.type === TOKEN_TYPES.RIGHT_BRACE) {
            errors.push({
                message: 'Not expected token',
                token,
            } as ParserError);
            current++;
            return null;
        }

        if (token.type === TOKEN_TYPES.LEFT_BRACKET) {
            current++;
            const node = {
                type: 'Array',
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
                    message: 'Expected Right Bracket',
                    token,
                } as ParserError);
                return node;
            }
            let lastNode: AbstractNode = node;
            while (tokens[current].type !== TOKEN_TYPES.RIGHT_BRACKET) {
                const nextNode = walk(lastNode);
                if (nextNode === null) {
                    break;
                }
                lastNode = nextNode;
                node.elements.push(nextNode);
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
                    message: 'Expected Right Bracket',
                    token,
                } as ParserError);
            }
            return node;
        }

        if (token.type === TOKEN_TYPES.RIGHT_BRACKET) {
            errors.push({
                message: 'Not expected token',
                token,
            } as ParserError);
            current++;
            return null;
        }

        if (token.type === TOKEN_TYPES.COMMA && _lastNode?.type === 'Value') {
            current++;
            (_lastNode as ValueNode).delimiter = ',';
            return walk(_lastNode);
        } else if (token.type === TOKEN_TYPES.COMMA) {
            current++;
            errors.push({
                message: 'Not expected Comma',
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
                    tokens[current] &&
                    tokens[current].type === TOKEN_TYPES.VALUE
                ) {
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
                    lastNode = args[0];
                    while (
                        tokens[current] &&
                        tokens[current].type !== TOKEN_TYPES.RIGHT_PAREN
                    ) {
                        const nextNode = walk(lastNode);
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
                    } as FunctionCallNode;
                }
            } else {
                current++;
                const node = walk() as ValueNode;
                if (!node) {
                    errors.push({
                        message: 'Expected Value',
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
                        message: 'Expected Value',
                        token,
                    } as ParserError);
                    return null;
                }
                node = {
                    type: 'Assignment',
                    assignmentType: 'Equals',
                    left: {
                        type: 'Identifier',
                        name: token.value,
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
                    right: walk(),
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
                    message: 'Expected Value in Colon',
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
                const nextNode = walk(lastNode ?? undefined);
                lastNode = nextNode;
                if (!nextNode) {
                    break;
                }
                if (nextNode.type === 'Value') {
                    inheritanceNodes.push(nextNode as ValueNode);
                } else {
                    console.warn(nextNode);
                    errors.push({
                        message: 'Expected Value after value but found',
                        token: tokens[current],
                    } as ParserError);
                }
                if (tokens[current] === undefined) {
                    break;
                }
            }
            let right: ObjectNode | ArrayNode | undefined = undefined;
            if (tokens[current]?.type === TOKEN_TYPES.LEFT_BRACE) {
                right = walk() as ObjectNode;
            } else if (tokens[current]?.type === TOKEN_TYPES.LEFT_BRACKET) {
                right = walk() as ArrayNode;
            }

            return {
                type: 'Inheritance',
                left: identifierNode,
                inheritance: inheritanceNodes,
                right,
            } as InheritanceNode;
        }

        if (
            token.type === TOKEN_TYPES.SINGLE_COMMENT ||
            token.type === TOKEN_TYPES.MULTI_COMMENT
        ) {
            current++;
            return walk(_lastNode);
        }

        if (token.type === TOKEN_TYPES.RIGHT_PAREN) {
            errors.push({
                message: 'Not expected paren',
                token,
            } as ParserError);
            current++;
            return null;
        }

        errors.push({
            message: 'Unknown token type',
            token,
        } as ParserError);
        return null;
    };

    const ast: AbstractNodeDocument = {
        type: 'Document',
        body: [],
    };

    let lastNode = undefined;
    while (current < tokens.length) {
        const nextNode = walk(lastNode);
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
        ast.body.push(nextNode);
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
