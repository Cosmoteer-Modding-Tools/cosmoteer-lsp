import { DocumentUri } from 'vscode-languageserver';
import { Token, TOKEN_TYPES } from '../lexer/lexer';
import { MAX_NUMBER_OF_PROBLEMS } from '../../settings';
import { ALLOWED_AUDIO_EXTENSIONS } from '../../utils/constants';
import {
    AbstractNode,
    AbstractNodeDocument,
    ListNode,
    AssignmentNode,
    ExpressionNode,
    FunctionCallNode,
    IdentifierNode,
    isExpressionNode,
    isIdentifierNode,
    isMathExpressionNode,
    isValueNode,
    MathExpressionNode,
    GroupNode,
    ValueNode,
    ValueNodeTypes,
} from '../ast/ast';
import * as l10n from '@vscode/l10n';
/**
 * TODO add Parser per Group to beatufy the code below lol
 */
abstract class Parser {
    abstract parse(): void;
}

/** The source spelling of punctuation tokens, for error messages. */
const TOKEN_DISPLAY: Partial<Record<TOKEN_TYPES, string>> = {
    [TOKEN_TYPES.LEFT_BRACE]: '{',
    [TOKEN_TYPES.RIGHT_BRACE]: '}',
    [TOKEN_TYPES.LEFT_BRACKET]: '[',
    [TOKEN_TYPES.RIGHT_BRACKET]: ']',
    [TOKEN_TYPES.LEFT_PAREN]: '(',
    [TOKEN_TYPES.RIGHT_PAREN]: ')',
    [TOKEN_TYPES.SEMICOLON]: ';',
    [TOKEN_TYPES.COLON]: ':',
    [TOKEN_TYPES.EQUALS]: '=',
    [TOKEN_TYPES.COMMA]: ',',
    [TOKEN_TYPES.STRING_DELIMITER]: '"',
};

/**
 * The text a token reads as in an error message, preferring its literal value.
 *
 * @param token the token to describe.
 * @returns the token's source text, punctuation spelling, or type name.
 */
const tokenDisplayText = (token: Token): string => token.value ?? TOKEN_DISPLAY[token.type] ?? token.type;

export const parser = (tokens: Token[], uri: DocumentUri): TokenParserResult => {
    let current = 0;
    const errors: ParserError[] = [];
    // Plain numbers: an integer/decimal mantissa — including a leading-dot decimal such as `.5`
    // or `.75` (common in Cosmoteer, e.g. `Bleed = .75 * .5`) — with an optional scientific
    // exponent (`3.4028235E+38`, `1.5e10`) and the legacy `d` suffix. The previous pattern put the
    // `^` anchor mid-expression (`[-.]?^…`), which made the leading `-`/`.` branch dead and typed
    // `.5` as a String, breaking value typing, math validation and resolved-value computation.
    const IS_NUMBER = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?d?$/;
    // A numeric literal carrying a unit suffix — percent `%`, degrees `d`, radians `r` (mXparser /
    // Cosmoteer expression suffixes). The lexer keeps the suffix inside the value token, so `40%`
    // lexes as one String value. Used so a leading sign (`-40%`) folds into that value instead of
    // leaking the sign as a lone Expression and desyncing the parse.
    const NUMBER_WITH_UNIT = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[%dr]$/;
    const walk = (
        _lastNode?: AbstractNode,
        parent?: GroupNode | ListNode | AbstractNodeDocument
    ): AbstractNode | null => {
        const token = tokens[current];
        if (!token) {
            return null;
        }

        if (token.type === TOKEN_TYPES.LEFT_BRACE) {
            current++;
            const node: GroupNode = {
                type: 'Group',
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
                    message: l10n.t('Expected right brace to close the group'),
                    token,
                } as ParserError);
            }
            return node;
        }

        if (token.type === TOKEN_TYPES.RIGHT_BRACE) {
            errors.push({
                message: l10n.t('Not expected right brace, did you mean to open a group?'),
                token,
            } as ParserError);
            current++;
            return null;
        }

        if (token.type === TOKEN_TYPES.LEFT_BRACKET) {
            current++;
            const node = {
                type: 'List',
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
            } as ListNode;
            if (!tokens[current]) {
                errors.push({
                    message: l10n.t('Expected right bracket but found end of file'),
                    token,
                } as ParserError);
                return node;
            }
            let lastNode: AbstractNode | undefined = node;
            while (tokens[current] && tokens[current].type !== TOKEN_TYPES.RIGHT_BRACKET) {
                const nextNode = walk(lastNode, node);
                if (nextNode === null) {
                    break;
                }
                lastNode = nextNode;
                node.elements.push(nextNode);
                if (tokens[current]?.type === TOKEN_TYPES.COMMA || tokens[current]?.type === TOKEN_TYPES.SEMICOLON) {
                    current++;
                    // A comma/semicolon ends the entry, so the next element starts fresh. Clearing
                    // `lastNode` lets a leading `-N` read as a negative literal (`[0, -1]` is the pair
                    // 0 and -1) instead of a subtraction continuing the previous value (`0 - 1`).
                    lastNode = undefined;
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
                    message: l10n.t('Expected right bracket to close the list'),
                    token,
                } as ParserError);
            }
            return node;
        }

        if (token.type === TOKEN_TYPES.RIGHT_BRACKET) {
            errors.push({
                message: l10n.t('Not expected bracket, did you mean to open a list?'),
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
            // ObjectText concatenates consecutive string literals (C-style): `"a" "b"` and the
            // line-continued form `"a"\ <newline> "b"` are a SINGLE string. They lex as adjacent
            // STRING tokens; the continuation segments carry no unsuppressed newline (a `\` before
            // the newline suppresses it, or the segments share a line). Without joining them the
            // trailing segments leak as sibling values — junk nodes in localization files, and in
            // the heat_management tutorial a continued string even stole the following `Entries`
            // list's identifier. Stop at an unsuppressed newline, which genuinely ends the value.
            while (tokens[current]?.type === TOKEN_TYPES.STRING && !tokens[current]?.precededByNewline) {
                value += tokens[current]?.value as string;
                current++;
            }
            // The quoted-string span must include the surrounding quotes (and any adjacent
            // concatenated segments), so derive the end from the last consumed token's absolute
            // offset rather than the unquoted content length, which is short by the quote characters
            // and would corrupt the file on rename and truncate every quoted-value highlight/hover.
            const lastStringToken = tokens[current - 1] ?? token;
            const endOffset = lastStringToken.end ?? token.end ?? token.start;
            return {
                type: 'Value',
                // Keep the type inferred from the first segment (String/Sprite/Sound/…) but carry the
                // FULL concatenated text as the value, so hover/rename/goto see the whole string.
                valueType: { ...inferValueType(IS_NUMBER, token), value } as ValueNodeTypes,
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
            // Whether the preceding node already produced a complete value, which makes the operator
            // that follows binary (e.g. the `*` in `sqrt(x) * 2`) rather than a unary sign on the next
            // number. A plain value, a function call, and a parenthesized math group all qualify, as
            // does a postfix `!` (factorial) which completes the value before it (e.g. `4! / 7`).
            const lastCompletesValue =
                _lastNode?.type === 'Value' ||
                _lastNode?.type === 'FunctionCall' ||
                _lastNode?.type === 'MathExpression' ||
                (!!_lastNode && isExpressionNode(_lastNode) && (_lastNode as ExpressionNode).expressionType === '!');
            if (
                tokenValue &&
                tokens[current - 2] &&
                tokens[current]?.type === TOKEN_TYPES.VALUE &&
                IS_NUMBER.test(tokenValue) &&
                // `IS_NUMBER` tolerates a trailing `d` (degrees), so `40d` matches but is not a
                // JS-coercible number (`-"40d"` is NaN); let those fall through to the unit-suffix
                // branch below rather than folding to a NaN value.
                !Number.isNaN(Number(tokenValue)) &&
                !lastCompletesValue
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
                        // The number token was just consumed (now `tokens[current - 1]`). Read its
                        // end, not `tokens[current]` which is undefined when the negative number is
                        // the last token in the file (`X = -5` at EOF) and would throw.
                        end: tokens[current - 1]?.end ?? token.end ?? 0,
                        line: token.lineNumber,
                        start: token.start,
                    },
                } as ValueNode;
            }
            // case for a unary sign before a value that the numeric fold above does not handle: a
            // unit-suffixed number (`-40%`, `-1.5r`, `-2d`) or a bare-word numeric constant
            // (`-Infinity`, `-pi`). The suffix / letters keep the token out of `IS_NUMBER`, so
            // without this the sign is returned as a lone Expression and the operand leaks as a
            // sibling value, silently desyncing the parse — it swallows the following named
            // group/list's identifier (seen on vanilla `BaseValue = -0.6%` stealing the next
            // `Modifiers` list, and `MinIntensity = -Infinity`). Fold the sign into a single String
            // value, mirroring the POSITIVE form (`40%` / `Infinity` also lex as plain Strings);
            // downstream percent/unit regexes already accept a leading `-`. References and paths
            // (`&…`, `/…`, `<…`) are excluded — a negated reference belongs in a MathExpression.
            else if (
                tokenValue &&
                tokens[current - 2] &&
                tokens[current]?.type === TOKEN_TYPES.VALUE &&
                // The operand must be on the SAME line as the sign: a bare `-`/`+` that is itself the
                // whole value (vanilla ru.rules key names `MinusUnderscore = -`, `PlusEquals = +`) is
                // followed by the NEXT line's field — folding across the newline would steal that
                // field's identifier and desync the parse.
                !tokens[current]?.precededByNewline &&
                (token.value === '-' || token.value === '+') &&
                (NUMBER_WITH_UNIT.test(tokenValue) || /^[A-Za-z_][\w.]*$/.test(tokenValue)) &&
                !lastCompletesValue
            ) {
                const numberToken = tokens[current];
                current++;
                const signed = (token.value === '-' ? '-' : '') + tokenValue;
                return {
                    type: 'Value',
                    valueType: {
                        type: 'String',
                        value: signed,
                    },
                    quoted: false,
                    parent,
                    position: {
                        characterEnd: token.lineOffset + signed.length,
                        characterStart: token.lineOffset,
                        end: numberToken?.end ?? token.end ?? 0,
                        line: token.lineNumber,
                        start: token.start,
                    },
                } as ValueNode;
            }
            // case for a unary sign before a parenthesized group, e.g. `-(&A/B)` or `-(5)`. The
            // negative-number branch above only folds `-<number>`; a parenthesized operand is not a
            // bare number, so without this the sign would be returned as a lone Expression node and the
            // `( … )` left unconsumed — it then leaks out as sibling fields and swallows the following
            // group's identifier (a silent desync seen on vanilla `ION_ENERGY = -(&Part/…)`). Parse the
            // operand and wrap it as a MathExpression `[sign, operand]`, mirroring how the game reads a
            // unary-negated parenthesized value.
            else if (
                (token.value === '-' || token.value === '+') &&
                !lastCompletesValue &&
                tokens[current]?.type === TOKEN_TYPES.LEFT_PAREN
            ) {
                const signNode = {
                    type: 'Expression',
                    expressionType: token.value as '+' | '-',
                    parent,
                    position: {
                        characterEnd: token.lineOffset + 1,
                        characterStart: token.lineOffset,
                        end: token.end ?? 0,
                        line: token.lineNumber,
                        start: token.start,
                    },
                } as ExpressionNode;
                const operand = walk(undefined, parent);
                // Nothing to negate (e.g. empty `()` already reported) — leave the bare sign rather
                // than fabricate an operand.
                if (!operand) return signNode;
                return {
                    type: 'MathExpression',
                    elements: [signNode, operand as ValueNode | MathExpressionNode | ExpressionNode],
                    parent,
                    position: {
                        characterStart: signNode.position.characterStart,
                        characterEnd: operand.position.characterEnd,
                        start: signNode.position.start,
                        end: operand.position.end,
                        line: signNode.position.line,
                    },
                } as MathExpressionNode;
            }
            // case for Values starting with / — a super-path reference like `/SW_X` or `/Foo/Bar`.
            // The reference segment must be on the same line as the `/`: references are always
            // written contiguously, and the lexer drops newlines, so without this guard a bare `/`
            // value (`SlashQuestion = /` in cosmoteer `strings/*.rules`) would swallow the next
            // line's identifier as its segment. OT terminates the value at the newline, leaving `/`.
            else if (
                tokenValue &&
                token.value === '/' &&
                tokens[current]?.type === TOKEN_TYPES.VALUE &&
                tokens[current]?.lineNumber === token.lineNumber &&
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
                        // The segment token was just consumed (it is now `tokens[current - 1]`).
                        // Read its end, not `tokens[current]` which may be undefined at EOF
                        // (`X = /Ref` as the last line) and would throw.
                        end: tokens[current - 1]?.end ?? token.end ?? 0,
                        line: token.lineNumber,
                        start: token.start,
                    },
                } as ValueNode;
            }
            return {
                type: 'Expression',
                expressionType: token.value as '+' | '-' | '*' | '/' | '^' | '!',
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
                if (
                    tokens[current]?.type === TOKEN_TYPES.VALUE ||
                    tokens[current]?.type === TOKEN_TYPES.LEFT_PAREN ||
                    // A quoted-string argument, e.g. the Cosmoteer `db2vol("&~/…")` audio function.
                    // The general loop below `walk`s it (its STRING branch yields a Value node).
                    tokens[current]?.type === TOKEN_TYPES.STRING
                ) {
                    const args: ValueNode[] = [];
                    // A simple first argument is `VALUE` or `( VALUE )`. Only that shape
                    // is built directly here. Anything more complex — nested parens or
                    // math such as `ceil(((&a)*4+(&b))/3)` — is left to the general
                    // argument loop below, which `walk`s each argument (and `walk`
                    // already resolves nested parens). Without this guard the next token
                    // after the consumed `(` could be another `(`, and inferValueType
                    // would throw on a LEFT_PAREN, aborting the whole file's parse.
                    // Only the exact shape `( VALUE )` is taken as a simple parenthesized first
                    // argument (closing `)` immediately after the value). Anything larger — a
                    // nested call `(name(...))`, or an expression `( VALUE op … )` such as the
                    // `(1 / (&X))` in `ceil((1 / (&X)))` — must fall through to the general
                    // argument loop, which `walk`s it as a proper parenthesized math group.
                    // Taking the shortcut for `( VALUE op …` wrongly demanded a `)` right after
                    // VALUE and reported a bogus "Expected right paren for reference" (which then
                    // desynced paren matching and corrupted the rest of the file).
                    let startWithParens = false;
                    if (
                        tokens[current]?.type === TOKEN_TYPES.LEFT_PAREN &&
                        tokens[current + 1]?.type === TOKEN_TYPES.VALUE &&
                        tokens[current + 2]?.type === TOKEN_TYPES.RIGHT_PAREN
                    ) {
                        current++;
                        startWithParens = true;
                    }
                    if (
                        tokens[current]?.type === TOKEN_TYPES.VALUE &&
                        // …but not when that first value is itself a nested function call (a non-numeric
                        // name immediately followed by `(`, e.g. the `sqrt` in `floor(sqrt(&A) * 2)`).
                        // Building it as a bare value here would split the nested call into a string +
                        // parenthesized args. Instead fall through to the loop below, whose `walk` parses
                        // it as a proper FunctionCall (the same way a `(`-first argument is handled).
                        !(
                            !IS_NUMBER.test(tokens[current].value as string) &&
                            tokens[current + 1]?.type === TOKEN_TYPES.LEFT_PAREN
                        )
                    ) {
                        const currentToken = tokens[current];
                        args.push({
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
                        });
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
                    }
                    while (
                        tokens[current] &&
                        tokens[current].type !== TOKEN_TYPES.RIGHT_PAREN &&
                        // Stop at an unsuppressed line break: ObjectText terminates a value at the
                        // newline, so an unclosed `(`/call must not consume the next line's field.
                        !tokens[current].precededByNewline
                    ) {
                        const nextNode = walk(lastNode, parent);
                        if (!nextNode) {
                            break;
                        }
                        lastNode = nextNode;
                        if (
                            nextNode.type === 'Value' ||
                            nextNode.type === 'Expression' ||
                            nextNode.type === 'FunctionCall' ||
                            // A parenthesized math group is a valid argument too, e.g.
                            // `ceil(((&a)*4+(&b))/3)` — its inner `((…)*4+(…))` walks to
                            // a MathExpression.
                            nextNode.type === 'MathExpression'
                        ) {
                            args.push(nextNode as ValueNode);
                        } else {
                            errors.push({
                                message: l10n.t('Expected value, expression or function call'),
                                token,
                                additionalInfo: [
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
                    // Remember the closing `)` so the node's end position spans the whole call,
                    // not just its name — callers (e.g. inlay hints) place markers after it. A
                    // function call that is never closed (`X = ceil(5`) is reported here.
                    const closeParen =
                        tokens[current]?.type === TOKEN_TYPES.RIGHT_PAREN ? tokens[current] : undefined;
                    if (closeParen) {
                        current++;
                    } else {
                        errors.push({
                            message: l10n.t('Expected right paren'),
                            token,
                        } as ParserError);
                    }
                    return {
                        type: 'FunctionCall',
                        name,
                        arguments: args,
                        position: {
                            characterEnd: closeParen ? closeParen.lineOffset + 1 : token.lineOffset + (name?.length ?? 0),
                            characterStart: token.lineOffset,
                            end: closeParen?.end ?? tokens[current - 1]?.start ?? 0,
                            line: closeParen?.lineNumber ?? token.lineNumber,
                            start: token.start,
                        },
                        parent,
                    } as FunctionCallNode;
                }
            } else {
                const parenStartIndex = current;
                const errorCountBeforeParen = errors.length;
                current++;
                // Empty parentheses `()` — the `(` is immediately closed. Consume the `)` here and
                // report the empty group: otherwise the stray-`)` literal rule (further down in
                // `walk`) would turn this closing paren into a value and desync the rest of the file.
                if (tokens[current]?.type === TOKEN_TYPES.RIGHT_PAREN) {
                    errors.push({
                        message: l10n.t('Expected value after left paren'),
                        token,
                    } as ParserError);
                    current++;
                    return null;
                }
                const node = walk(_lastNode, parent) as ValueNode;
                if (!node) {
                    errors.push({
                        message: l10n.t('Expected value after left paren'),
                        token,
                    } as ParserError);
                    return null;
                }
                // If the parenthesized content is not a math operand (a Value, Expression,
                // MathExpression or FunctionCall) we walked past the value into the next field —
                // e.g. `LeftBracket = (` (cosmoteer `strings/ja.rules`, `ru.rules`) where `(` is a
                // literal value, not the start of an expression group, so `walk` returned the
                // following `M = ""` field as an Assignment. The real OT parser (OTFieldNode) reads
                // a bare `(` as the string "(". Rewind the tokens (and any errors they produced)
                // and emit `(` as a plain value so the following fields parse normally.
                const innerType = (node as AbstractNode).type;
                if (
                    innerType !== 'Value' &&
                    innerType !== 'Expression' &&
                    innerType !== 'MathExpression' &&
                    innerType !== 'FunctionCall'
                ) {
                    current = parenStartIndex + 1;
                    errors.length = errorCountBeforeParen;
                    return {
                        type: 'Value',
                        valueType: { type: 'String', value: '(' },
                        parent,
                        position: {
                            characterEnd: token.lineOffset + 1,
                            characterStart: token.lineOffset,
                            end: token.end ?? 0,
                            line: token.lineNumber,
                            start: token.start,
                        },
                    } as ValueNode;
                }
                if (tokens[current] && tokens[current].type === TOKEN_TYPES.RIGHT_PAREN) {
                    const closeParen = tokens[current];
                    current++;
                    node.parenthesized = true;
                    // Span the closing `)` so an end-of-expression marker sits after it, e.g. the
                    // `(&~/SIZE/1)` operand in `… / (&~/SIZE/1)`.
                    node.position = {
                        ...node.position,
                        characterEnd: closeParen.lineOffset + 1,
                        end: closeParen.end ?? node.position.end,
                        line: closeParen.lineNumber,
                    };
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
                    while (
                        tokens[current] &&
                        tokens[current].type !== TOKEN_TYPES.RIGHT_PAREN &&
                        // Stop at an unsuppressed line break: ObjectText terminates a value at the
                        // newline, so an unclosed `(`/call must not consume the next line's field.
                        !tokens[current].precededByNewline
                    ) {
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
                    // Span the closing `)` so an end-of-expression marker lands after the whole
                    // parenthesized group (e.g. `(6/1)` or `((&~/SIZE/0)/2)`). A missing `)` —
                    // whether a stray non-paren token interrupted the group or the file ended
                    // mid-expression (`X = (5 + 3`) — leaves `closeParen` undefined and is reported.
                    const closeParen =
                        tokens[current]?.type === TOKEN_TYPES.RIGHT_PAREN ? tokens[current] : undefined;
                    if (!closeParen) {
                        errors.push({
                            message: l10n.t('Expected right paren'),
                            token,
                        } as ParserError);
                    }
                    if (closeParen) {
                        mathNode.position = {
                            ...mathNode.position,
                            characterEnd: closeParen.lineOffset + 1,
                            end: closeParen.end ?? mathNode.position.end,
                            line: closeParen.lineNumber,
                        };
                        // Consume the `)` only when it is actually present. When the group ended at a
                        // line break (no `)`), leaving `current` put would skip the next line's field.
                        current++;
                    }
                    return mathNode;
                }
                // A single parenthesized value whose `)` never arrives (`X = (&A`) — the value
                // parsed but the group was left open at end of file.
                errors.push({
                    message: l10n.t('Expected right paren'),
                    token,
                } as ParserError);
                return node;
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
                    right: continueMathExpression(walk(_lastNode, parent), parent),
                } as AssignmentNode;
            } else if (
                token.value &&
                tokens[current - 2] &&
                (tokens[current - 2].type === TOKEN_TYPES.EQUALS ||
                    tokens[current - 2].type === TOKEN_TYPES.COLON ||
                    tokens[current - 2].type === TOKEN_TYPES.LEFT_BRACKET ||
                    tokens[current - 2].type === TOKEN_TYPES.EXPRESSION ||
                    tokens[current - 2].type === TOKEN_TYPES.LEFT_PAREN ||
                    _lastNode?.type === 'Value' ||
                    // Right after a `,` field separator, an identifier that HEADS a group/list/
                    // inheritance (`, Criterias [ … ]`, real mod gaugeincreaser.rules) is a NEW
                    // member, not a comma-separated value — so classify it as a value only when it is
                    // NOT immediately followed by `{`/`[`/`:` (else its opener is orphaned and the
                    // member goes anonymous). The multi-value continuation cases above are left as-is.
                    (tokens[current - 2].type === TOKEN_TYPES.COMMA &&
                        tokens[current]?.type !== TOKEN_TYPES.LEFT_BRACE &&
                        tokens[current]?.type !== TOKEN_TYPES.LEFT_BRACKET &&
                        tokens[current]?.type !== TOKEN_TYPES.COLON))
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
                    additionalInfo: [
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
                    if (nextNode.valueType.type === 'Reference') {
                        inheritanceNodes.push(nextNode as ValueNode);
                    } else if (nextNode.valueType.type === 'String' && !nextNode.quoted) {
                        // Same-file inheritance by bare name (e.g. `Child : Parent`). The
                        // lexer classifies the bare identifier as a String. Normalize it to
                        // a relative reference (`&Parent`) so it is captured as inheritance
                        // and resolves through the parent scope like an explicit `&` ref.
                        nextNode.valueType = {
                            type: 'Reference',
                            value: '&' + String(nextNode.valueType.value),
                        };
                        inheritanceNodes.push(nextNode as ValueNode);
                    } else if (nextNode.valueType.type === 'Number' && !nextNode.parenthesized) {
                        // Numeric inheritance (e.g. `: 1` for a list element) inherits from
                        // the sibling at that index in the containing list/group. Normalize
                        // to a relative `&<index>` reference, resolved (via isInheritanceMember)
                        // against the container — `stepIntoNode` indexes the list by number.
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
                            token: tokens[current - 1],
                        } as ParserError);
                    }
                } else {
                    errors.push({
                        message: l10n.t('Expected reference value after reference value but found {0}', nextNode.type),
                        token: tokens[current - 1],
                    } as ParserError);
                }
                if (tokens[current] === undefined) {
                    break;
                }
                // A `;` (like `,`) terminates an inheritance reference inside the inheritance list —
                // the game's `OTReferenceNode.Parse` breaks a ref on `;`/`,`/newline, and the
                // inheritance list keeps collecting refs until it reaches the body `{`/`[`. So the
                // list-element form `: ~/Base/N; { override }` (real in workshop mods, e.g.
                // pipebase.rules `ProxyableComponents`) is ONE element: a group inheriting from the
                // ref with a `{}` override. Consuming the `;` here lets the body attach; without it
                // the `;` and `{ … }` leaked out and desynced the enclosing list's bracket matching.
                if (
                    tokens[current]?.type === TOKEN_TYPES.COMMA ||
                    tokens[current]?.type === TOKEN_TYPES.SEMICOLON
                ) {
                    current++;
                    continue;
                }
            }
            let right: ListNode | GroupNode | null = null;
            if (tokens[current]?.type === TOKEN_TYPES.LEFT_BRACE) {
                right = walk(_lastNode, parent) as GroupNode;
            } else if (tokens[current]?.type === TOKEN_TYPES.LEFT_BRACKET) {
                right = walk(_lastNode, parent) as ListNode;
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
            // A `)` reaching here is unmatched — every paren-group/function-call loop consumes its
            // own closing `)` before calling `walk`, so this is a stray paren. The real OT parser
            // (OTFieldNode) reads such a token as part of the value string, e.g. `RightBracket = )`
            // or `AsteroidGold_S = 金小惑星（S)` in cosmoteer `strings/*.rules`. Emit it as a literal
            // value rather than a spurious "Not expected paren" that desyncs the rest of the file.
            current++;
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
            current++;
            return null;
        }
        // A known token in a position no rule accepts, e.g. the stray `=` in `X = &<a>, = &<b>`.
        // The game's OTGroupNode.Parse throws the same way (`Unexpected "=" at position …`), so this
        // is invalid input, not a parser bug.
        errors.push({
            message: l10n.t('Unexpected "{0}"', tokenDisplayText(token)),
            token,
        } as ParserError);
        current++;
        return null;
    };

    /**
     * After a value, a math operator at the same level (not inside parens) starts a
     * binary expression — consume the whole `value (op value)*` chain as one
     * MathExpression. Without this the trailing `op value` stays orphaned at the
     * container level and can swallow the following token (e.g. `XXLChance = 1/16`
     * leaves `/16`, which then consumes the next identifier `CommonAsteroidTypes`).
     * The operator is consumed here so `/16` is not misread as a `/`-super-path value.
     */
    const continueMathExpression = (
        first: AbstractNode | null,
        parent?: GroupNode | ListNode | AbstractNodeDocument
    ): AbstractNode | null => {
        // Implicit multiplication — a value-like operand immediately followed by `(` on the same
        // line (`3(&~/Range)` = `3 * (&~/Range)`). The game reads the field value flat and mXparser
        // applies implied multiplication; without this the `( … )` leaks as a sibling value. Only a
        // numeric/value/expression `first` qualifies (not a group/list) and only when NOT preceded by
        // a newline (which ends the value).
        const nextIsImplicitMult = () =>
            first !== null &&
            tokens[current]?.type === TOKEN_TYPES.LEFT_PAREN &&
            !tokens[current]?.precededByNewline &&
            (first.type === 'Value' ||
                first.type === 'MathExpression' ||
                first.type === 'FunctionCall' ||
                first.type === 'Expression');
        if (!first || (tokens[current]?.type !== TOKEN_TYPES.EXPRESSION && !nextIsImplicitMult())) return first;
        const mathNode: MathExpressionNode = {
            type: 'MathExpression',
            elements: [first as ValueNode],
            parent,
            position: { ...first.position },
        };
        // Stop the math chain at an unsuppressed line break — ObjectText ends a value at the
        // newline, so `X = 1\n+ 2` is `X = 1` (the `+ 2` is not folded into the value).
        while (
            (tokens[current]?.type === TOKEN_TYPES.EXPRESSION || tokens[current]?.type === TOKEN_TYPES.LEFT_PAREN) &&
            !tokens[current]?.precededByNewline
        ) {
            const operatorToken = tokens[current];
            const isImplicitMult = operatorToken.type === TOKEN_TYPES.LEFT_PAREN;
            mathNode.elements.push({
                type: 'Expression',
                expressionType: isImplicitMult ? '*' : (operatorToken.value as '+' | '-' | '*' | '/' | '^' | '!'),
                parent,
                position: {
                    line: operatorToken.lineNumber,
                    characterStart: operatorToken.lineOffset,
                    characterEnd: operatorToken.lineOffset + 1,
                    start: operatorToken.start,
                    end: operatorToken.end ?? 0,
                },
            } as ExpressionNode);
            // For an explicit operator, consume it so the operand is not lexed as a `/`-path; for an
            // implicit `*` there is no operator token, so leave `(` for `walk` to consume as a group.
            if (!isImplicitMult) current++;
            // `!` is postfix (factorial): it applies to the value already pushed, so there is no
            // right operand to consume — keep scanning for the next operator instead.
            if (!isImplicitMult && operatorToken.value === '!') {
                mathNode.position.end = operatorToken.end ?? mathNode.position.end;
                mathNode.position.characterEnd = operatorToken.lineOffset + 1;
                continue;
            }
            const operand = walk(undefined, parent);
            if (!operand) break;
            mathNode.elements.push(operand as ValueNode | MathExpressionNode | ExpressionNode);
            mathNode.position.end = operand.position.end;
            mathNode.position.characterEnd = operand.position.characterEnd;
        }
        return mathNode;
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

    let lastNode: AbstractNode | undefined = undefined;
    while (current < tokens.length) {
        // A `;` or `,` terminates a top-level field or void entry (ObjectText treats both as the
        // node terminator, see OTGroupedReferenceNode: `Foo;` / `Bar = 1,`). Consume it and clear
        // `lastNode` so the completed entry is not bound to whatever follows — e.g. a void `Foo;`
        // must not become the identifier of a subsequent `Bar { … }` group.
        if (tokens[current].type === TOKEN_TYPES.SEMICOLON || tokens[current].type === TOKEN_TYPES.COMMA) {
            current++;
            lastNode = undefined;
            continue;
        }
        const nextNode = walk(lastNode, ast);
        if (errors.length > MAX_NUMBER_OF_PROBLEMS) {
            break;
        }
        if (!nextNode) {
            continue;
        }
        if (lastNode?.type === 'Identifier' && nextNode.type === 'List') {
            (nextNode as ListNode).identifier = lastNode as IdentifierNode;
        }
        if (lastNode?.type === 'Identifier' && nextNode.type === 'Group') {
            (nextNode as GroupNode).identifier = lastNode as IdentifierNode;
        }
        lastNode = nextNode;
        ast.elements.push(nextNode);
    }

    return { value: ast, parserErrors: errors };
};

export type ParserError = {
    message: string;
    token: Token;
    additionalInfo?: Pick<ParserError, 'message' | 'token'>[];
};

export interface TokenParserResult {
    value: AbstractNodeDocument;
    parserErrors: ParserError[];
}

// Hoisted out of inferValueType, which runs for every value token of every parsed file — building
// the pattern there compiled a fresh RegExp per token.
const IS_SOUND = new RegExp(ALLOWED_AUDIO_EXTENSIONS.join('|').replaceAll('.', '\\.'));

function inferValueType(IS_NUMBER: RegExp, token: Token): ValueNodeTypes {
    if (typeof token.value === 'undefined') throw new Error('Token value is undefined');
    let value: ValueNodeTypes['value'] = token.value;
    let valueType: ValueNodeTypes['type'] = IS_NUMBER.test(token.value) ? 'Number' : 'String';
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
        // A reference sigil must be FOLLOWED by a path/name — a lone `~`, `/`, `^`, `&`, or `..`
        // (no member) is not a resolvable reference, it is a literal value (the keyboard key-name
        // strings `TildeBacktick = ~`, `SlashQuestion = /` in cosmoteer `strings/*.rules`). Typing
        // those as references produced spurious "Reference should start with an ampersand" errors.
        (token.value.startsWith('&') && token.value.length > 1) ||
        (token.value.startsWith('^') && token.value.length > 1) ||
        (token.value.startsWith('..') && token.value.length > 2) ||
        (token.value.startsWith('/') && token.value.length > 1) ||
        (token.value.startsWith('~') && token.value.length > 1) ||
        (token.value.startsWith('<') && token.value.includes('.rules')) ||
        (token.value.startsWith('<') && !token.value.includes('>'))
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
