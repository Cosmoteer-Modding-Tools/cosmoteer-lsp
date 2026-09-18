import { Token, TOKEN_TYPES } from '../lexer/lexer';
import {
    AbstractNode,
    AbstractNodeDocument,
    FunctionCallNode,
    GroupNode,
    ListNode,
    MathExpressionNode,
    ValueNode,
    isExpressionNode,
    isMathExpressionNode,
    isValueNode,
} from '../ast/ast';
import * as l10n from '@vscode/l10n';
import { inferValueType, IS_NUMBER } from './infer-value-type';
import { ParserError, ParserState } from './parser.types';

/**
 * Reads the simple first argument of a call, which is `VALUE` or `( VALUE )`, and appends it. Only
 * that shape is built directly. Anything more complex (nested parens or math such as
 * `ceil(((&a)*4+(&b))/3)`) is left to the general argument loop, which `walk`s each argument and
 * already resolves nested parens. Without the guard the next token after the consumed `(` could be
 * another `(`, and `inferValueType` would throw on a LEFT_PAREN, aborting the whole file's parse.
 *
 * The exact shape `( VALUE )` needs the closing `)` right after the value. Anything larger, a
 * nested call `(name(...))` or an expression `( VALUE op … )` such as the `(1 / (&X))` in
 * `ceil((1 / (&X)))`, must fall through to the general loop, which `walk`s it as a proper
 * parenthesized math group. Taking the shortcut for `( VALUE op …` wrongly demanded a `)` right
 * after VALUE and reported a bogus "Expected right paren for reference", which then desynced paren
 * matching and corrupted the rest of the file.
 *
 * @param state the parse state, positioned on the first argument.
 * @param token the call's name token, which the errors are reported on.
 * @param parent the container the call belongs to.
 * @param args the argument list the value is appended to.
 */
const readSimpleFirstArgument = (
    state: ParserState,
    token: Token,
    parent: GroupNode | ListNode | AbstractNodeDocument | undefined,
    args: ValueNode[]
): void => {
    const { tokens, errors } = state;
    let startWithParens = false;
    if (
        tokens[state.current]?.type === TOKEN_TYPES.LEFT_PAREN &&
        tokens[state.current + 1]?.type === TOKEN_TYPES.VALUE &&
        tokens[state.current + 2]?.type === TOKEN_TYPES.RIGHT_PAREN
    ) {
        state.current++;
        startWithParens = true;
    }
    if (
        tokens[state.current]?.type !== TOKEN_TYPES.VALUE ||
        // …but not when that first value is itself a nested function call (a non-numeric name
        // immediately followed by `(`, e.g. the `sqrt` in `floor(sqrt(&A) * 2)`). Building it as a
        // bare value here would split the nested call into a string + parenthesized args. Instead
        // fall through to the loop, whose `walk` parses it as a proper FunctionCall (the same way a
        // `(`-first argument is handled).
        (!IS_NUMBER.test(tokens[state.current].value as string) &&
            tokens[state.current + 1]?.type === TOKEN_TYPES.LEFT_PAREN)
    ) {
        return;
    }
    const currentToken = tokens[state.current];
    args.push({
        type: 'Value',
        valueType: inferValueType(currentToken),
        parent,
        position: {
            characterEnd: currentToken.lineOffset + (currentToken.value as string).length,
            characterStart: currentToken.lineOffset,
            end: currentToken.end ?? 0,
            line: currentToken.lineNumber,
            start: currentToken.start,
        },
    });
    state.current++;
    if (startWithParens && tokens[state.current]?.type === TOKEN_TYPES.RIGHT_PAREN) {
        args[0].parenthesized = true;
        state.current++;
    } else if (startWithParens) {
        errors.push({
            message: l10n.t('Expected right paren for reference'),
            token,
        } as ParserError);
    }
    state.lastNode = args[0];
};

/**
 * Reads a call whose argument list has begun, up to and including its closing `)`.
 *
 * @param state the parse state, positioned on the first argument.
 * @param token the call's name token.
 * @param name the called function's name.
 * @param parent the container the call belongs to.
 * @returns the call, even when its closing paren never came.
 */
const callWithArguments = (
    state: ParserState,
    token: Token,
    name: string | undefined,
    parent?: GroupNode | ListNode | AbstractNodeDocument
): FunctionCallNode => {
    const { tokens, errors } = state;
    const args: ValueNode[] = [];
    readSimpleFirstArgument(state, token, parent, args);
    while (
        tokens[state.current] &&
        tokens[state.current].type !== TOKEN_TYPES.RIGHT_PAREN &&
        // Stop at an unsuppressed line break: ObjectText terminates a value at the
        // newline, so an unclosed `(`/call must not consume the next line's field.
        !tokens[state.current].precededByNewline
    ) {
        const nextNode = state.walk(state, state.lastNode, parent);
        if (!nextNode) {
            break;
        }
        state.lastNode = nextNode;
        if (
            nextNode.type === 'Value' ||
            nextNode.type === 'Expression' ||
            nextNode.type === 'FunctionCall' ||
            // A parenthesized math group is a valid argument too, e.g.
            // `ceil(((&a)*4+(&b))/3)`. Its inner `((…)*4+(…))` walks to
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
                        message: l10n.t('Values can be a number or a reference, expressions can be +, -, *, /'),
                    },
                ],
            } as ParserError);
            state.current++;
        }
        if (tokens[state.current]?.type === TOKEN_TYPES.COMMA) {
            state.current++;
        }
        if (tokens[state.current] === undefined) {
            break;
        }
    }
    // Remember the closing `)` so the node's end position spans the whole call,
    // not just its name: callers (e.g. inlay hints) place markers after it. A
    // function call that is never closed (`X = ceil(5`) is reported here.
    const closeParen = tokens[state.current]?.type === TOKEN_TYPES.RIGHT_PAREN ? tokens[state.current] : undefined;
    if (closeParen) {
        state.current++;
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
            end: closeParen?.end ?? tokens[state.current - 1]?.start ?? 0,
            line: closeParen?.lineNumber ?? token.lineNumber,
            start: token.start,
        },
        parent,
    } as FunctionCallNode;
};

/**
 * Reads a call whose `(` opened and whose line then ended, the state a half-typed `Foo = cos(` is
 * in. It is still a call, so it is built as one with no arguments: reading the name as a plain
 * identifier instead let the next line's member be absorbed as its value, and that member vanished
 * from the tree.
 *
 * @param state the parse state, positioned after the `(`.
 * @param token the call's name token.
 * @param name the called function's name.
 * @param parent the container the call belongs to.
 * @returns the argument-less call.
 */
const unclosedCall = (
    state: ParserState,
    token: Token,
    name: string | undefined,
    parent?: GroupNode | ListNode | AbstractNodeDocument
): FunctionCallNode => {
    state.errors.push({
        message: l10n.t('Expected right paren'),
        token,
    } as ParserError);
    return {
        type: 'FunctionCall',
        name,
        arguments: [],
        position: {
            characterEnd: token.lineOffset + (name?.length ?? 0) + 1,
            characterStart: token.lineOffset,
            end: state.tokens[state.current - 1]?.end ?? token.end ?? 0,
            line: token.lineNumber,
            start: token.start,
        },
        parent,
    } as FunctionCallNode;
};

/**
 * Reads a function call, `name( … )`. The name and its `(` have been recognised by the caller.
 *
 * @param state the parse state, positioned on the name.
 * @param token the name token.
 * @param parent the container the call belongs to.
 * @returns the call, even when its closing paren never came.
 */
export const parseFunctionCall = (
    state: ParserState,
    token: Token,
    parent?: GroupNode | ListNode | AbstractNodeDocument
): FunctionCallNode => {
    const { tokens } = state;
    const name = token.value;
    state.current += 2;
    if (
        // A value ends at an unsuppressed line break, so a call left open at the end of
        // its line takes no argument from the line below. Without this, typing `Foo =
        // cos(` read the next line's member as the argument and reported an error on a
        // line the author had not touched.
        !tokens[state.current]?.precededByNewline &&
        (tokens[state.current]?.type === TOKEN_TYPES.VALUE ||
            tokens[state.current]?.type === TOKEN_TYPES.LEFT_PAREN ||
            // A quoted-string argument, e.g. the Cosmoteer `db2vol("&~/…")` audio
            // function. The general loop `walk`s it (its STRING branch yields a Value node).
            tokens[state.current]?.type === TOKEN_TYPES.STRING ||
            // A signed first argument, as in `round(-2.5, 0)`. The sign is an EXPRESSION
            // token, so without this the whole call fell back to a bare string and
            // neither evaluated nor offered signature help.
            (tokens[state.current]?.type === TOKEN_TYPES.EXPRESSION &&
                (tokens[state.current].value === '-' || tokens[state.current].value === '+')))
    ) {
        return callWithArguments(state, token, name, parent);
    }
    return unclosedCall(state, token, name, parent);
};

/**
 * The literal `(` the game reads where a parenthesized group turned out not to be one. The real OT
 * parser (OTFieldNode) reads a bare `(` as the string "(", which is what `LeftBracket = (` in
 * cosmoteer's `strings/ja.rules` and `ru.rules` means.
 *
 * @param token the opening paren.
 * @param parent the container the value belongs to.
 * @returns the `(` as a plain string value.
 */
const literalParenValue = (token: Token, parent?: GroupNode | ListNode | AbstractNodeDocument): ValueNode =>
    ({
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
    }) as ValueNode;

/**
 * Reads the rest of a parenthesized math chain, from the node already parsed up to the closing `)`.
 *
 * @param state the parse state, positioned after the chain's first element.
 * @param token the opening paren, which the errors are reported on.
 * @param node the chain's first element.
 * @param parent the container the chain belongs to.
 * @returns the whole chain as one math node.
 */
const parenMathChain = (
    state: ParserState,
    token: Token,
    node: ValueNode,
    parent?: GroupNode | ListNode | AbstractNodeDocument
): MathExpressionNode => {
    const { tokens, errors } = state;
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
        tokens[state.current] &&
        tokens[state.current].type !== TOKEN_TYPES.RIGHT_PAREN &&
        // Stop at an unsuppressed line break: ObjectText terminates a value at the
        // newline, so an unclosed `(`/call must not consume the next line's field.
        !tokens[state.current].precededByNewline
    ) {
        const nextNode = state.walk(state, lastNode, parent);
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
        if (tokens[state.current] === undefined) {
            break;
        }
        lastNode = nextNode;
    }
    // Span the closing `)` so an end-of-expression marker lands after the whole
    // parenthesized group (e.g. `(6/1)` or `((&~/SIZE/0)/2)`). A missing `)`,
    // whether a stray non-paren token interrupted the group or the file ended
    // mid-expression (`X = (5 + 3`), leaves `closeParen` undefined and is reported.
    const closeParen = tokens[state.current]?.type === TOKEN_TYPES.RIGHT_PAREN ? tokens[state.current] : undefined;
    if (!closeParen) {
        errors.push({
            message: l10n.t('Expected right paren'),
            token,
        } as ParserError);
        return mathNode;
    }
    mathNode.position = {
        ...mathNode.position,
        characterEnd: closeParen.lineOffset + 1,
        end: closeParen.end ?? mathNode.position.end,
        line: closeParen.lineNumber,
    };
    // Consume the `)` only when it is actually present. When the group ended at a line break
    // (no `)`), leaving `state.current` put would skip the next line's field.
    state.current++;
    return mathNode;
};

/**
 * Reads a parenthesized group, `( … )`. It holds one value, a math chain, or, when the source turns
 * out to mean neither, the literal `(` the game reads there.
 *
 * @param state the parse state, positioned on the opening paren.
 * @param token the opening paren.
 * @param _lastNode the node read before it.
 * @param parent the container the group belongs to.
 * @returns the parenthesized value or chain, the literal `(`, or null when the parens held nothing.
 */
export const parseParenGroup = (
    state: ParserState,
    token: Token,
    _lastNode: AbstractNode | undefined,
    parent?: GroupNode | ListNode | AbstractNodeDocument
): AbstractNode | null => {
    const { tokens, errors } = state;
    const parenStartIndex = state.current;
    const errorCountBeforeParen = errors.length;
    state.current++;
    // Empty parentheses `()`: the `(` is immediately closed. Consume the `)` here and
    // report the empty group: otherwise the stray-`)` literal rule in `parseStrayRightParen`
    // would turn this closing paren into a value and desync the rest of the file.
    if (tokens[state.current]?.type === TOKEN_TYPES.RIGHT_PAREN) {
        errors.push({
            message: l10n.t('Expected value after left paren'),
            token,
        } as ParserError);
        state.current++;
        return null;
    }
    const node = state.walk(state, _lastNode, parent) as ValueNode;
    if (!node) {
        errors.push({
            message: l10n.t('Expected value after left paren'),
            token,
        } as ParserError);
        return null;
    }
    // If the parenthesized content is not a math operand (a Value, Expression,
    // MathExpression or FunctionCall) we walked past the value into the next field,
    // e.g. `LeftBracket = (` where `(` is a literal value, not the start of an expression
    // group, so `walk` returned the following `M = ""` field as an Assignment. Rewind the
    // tokens (and any errors they produced) and emit `(` as a plain value so the following
    // fields parse normally.
    const innerType = (node as AbstractNode).type;
    if (
        innerType !== 'Value' &&
        innerType !== 'Expression' &&
        innerType !== 'MathExpression' &&
        innerType !== 'FunctionCall'
    ) {
        state.current = parenStartIndex + 1;
        errors.length = errorCountBeforeParen;
        return literalParenValue(token, parent);
    }
    if (tokens[state.current] && tokens[state.current].type === TOKEN_TYPES.RIGHT_PAREN) {
        const closeParen = tokens[state.current];
        state.current++;
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
    } else if (tokens[state.current]) {
        return parenMathChain(state, token, node, parent);
    }
    // A single parenthesized value whose `)` never arrives (`X = (&A`): the value
    // parsed but the group was left open at end of file.
    errors.push({
        message: l10n.t('Expected right paren'),
        token,
    } as ParserError);
    return node;
};

/**
 * Reads a function call (`name( … )`) or a parenthesized math group (`( … )`). The two share this
 * entry because both open on a `(` and both end on the matching `)`.
 *
 * @param state the parse state, positioned on the name or on the `(`.
 * @param token the name token of the call, or the opening paren.
 * @param _lastNode the node read before it.
 * @param parent the container the node belongs to.
 * @returns the call, the parenthesized value, or null when the parens held nothing readable.
 */
export const parseCallOrParenGroup = (
    state: ParserState,
    token: Token,
    _lastNode: AbstractNode | undefined,
    parent?: GroupNode | ListNode | AbstractNodeDocument
): AbstractNode | null =>
    token.type === TOKEN_TYPES.VALUE
        ? parseFunctionCall(state, token, parent)
        : parseParenGroup(state, token, _lastNode, parent);
