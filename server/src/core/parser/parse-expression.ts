import { Token, TOKEN_TYPES } from '../lexer/lexer';
import {
    AbstractNode,
    AbstractNodeDocument,
    ExpressionNode,
    GroupNode,
    ListNode,
    MathExpressionNode,
    ValueNode,
    isExpressionNode,
    MX_ASSEMBLED_OPERATORS,
    MxAssembledOperator,
} from '../ast/ast';
import { IS_NUMBER, inferValueType } from './infer-value-type';
import { ParserState } from './parser.types';

/** Matches a bare identifier, a name or a dotted name, with no reference sigil in front of it. */
const IDENTIFIER_VALUE = /^[A-Za-z_][\w.]*$/;

/** Matches a token that opens with a name character, so a `/` before it reads as a path segment. */
const STARTS_WITH_NAME_CHAR = /^[A-Za-z_]/;

// A numeric literal carrying a unit suffix: percent `%`, degrees `d`, radians `r` (mXparser /
// Cosmoteer expression suffixes). The lexer keeps the suffix inside the value token, so `40%`
// lexes as one String value. Used so a leading sign (`-40%`) folds into that value instead of
// leaking the sign as a lone Expression and desyncing the parse.
const NUMBER_WITH_UNIT = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[%dr]$/;

// An arithmetic run the lexer glued into one token because `-` and `.` are value characters
// (`0.38-0.015`). Only digits, dots and operators, so a word or a reference never matches.
const GLUED_ARITHMETIC = /^[\d.]+(?:[-+*/][\d.]+)+$/;

// Set form of the assembled-operator spellings for the O(1) lookups in `matchAssembledOperator`,
// plus every proper prefix of a spelling so a non-viable token run is abandoned on its first
// token. This keeps the matcher O(1) on ordinary values ("Guns" is not a prefix, done), which
// matters because it runs once per math-chain step of every parse.
const MX_ASSEMBLED_OPERATOR_SET: ReadonlySet<string> = new Set(MX_ASSEMBLED_OPERATORS);
const MX_ASSEMBLED_OPERATOR_PREFIXES: ReadonlySet<string> = new Set(
    MX_ASSEMBLED_OPERATORS.flatMap((op) => Array.from({ length: op.length }, (_, i) => op.slice(0, i + 1)))
);

/**
 * Folds a sign into the number that follows it, so `-5` is one numeric value rather than an
 * operator beside a number.
 *
 * @param state the parse state, positioned on the number token.
 * @param token the sign token.
 * @param tokenValue the number token's text.
 * @param parent the container the node belongs to.
 * @returns the signed number as one value node.
 */
const signedNumberValue = (
    state: ParserState,
    token: Token,
    tokenValue: string,
    parent?: GroupNode | ListNode | AbstractNodeDocument
): ValueNode => {
    const { tokens } = state;
    const value = token.value === '-' ? -tokenValue : Number(tokenValue);
    state.current++;
    return {
        type: 'Value',
        valueType: {
            type: 'Number',
            value: value,
        },
        parent,
        position: {
            // The span covers the sign and the digits as they are written, which a rendering of
            // the folded number does not: `-.5` renders as -0.5 and used to paint one character
            // too many, and `-1e3` ran past the end of the line.
            characterEnd:
                token.lineOffset +
                (token.value as string).length +
                String(tokens[state.current - 1]?.value ?? '').length,
            characterStart: token.lineOffset,
            // The number token was just consumed (now `tokens[state.current - 1]`). Read its end,
            // not `tokens[state.current]` which is undefined when the negative number is the last
            // token in the file (`X = -5` at EOF) and would throw.
            end: tokens[state.current - 1]?.end ?? token.end ?? 0,
            line: token.lineNumber,
            start: token.start,
        },
    } as ValueNode;
};

/**
 * Folds a sign into a value the numeric fold cannot take: a unit-suffixed number (`-40%`, `-1.5r`,
 * `-2d`) or a bare-word numeric constant (`-Infinity`, `-pi`). The suffix and the letters keep the
 * token out of {@link IS_NUMBER}, so without this the sign is returned as a lone Expression and the
 * operand leaks as a sibling value, silently desyncing the parse. It then swallows the following
 * named group or list's identifier (seen on vanilla `BaseValue = -0.6%` stealing the next
 * `Modifiers` list, and `MinIntensity = -Infinity`). The result is a single String value, mirroring
 * the positive form (`40%` and `Infinity` also lex as plain Strings), and the downstream
 * percent/unit regexes already accept a leading `-`.
 *
 * @param state the parse state, positioned on the operand token.
 * @param token the sign token.
 * @param tokenValue the operand token's text.
 * @param parent the container the node belongs to.
 * @returns the signed operand as one string value node.
 */
const signedUnitValue = (
    state: ParserState,
    token: Token,
    tokenValue: string,
    parent?: GroupNode | ListNode | AbstractNodeDocument
): ValueNode => {
    const numberToken = state.tokens[state.current];
    state.current++;
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
};

/**
 * Reads a sign applied to a parenthesized group, e.g. `-(&A/B)` or `-(5)`. A parenthesized operand
 * is not a bare number, so without this the sign would be returned as a lone Expression node and the
 * `( … )` left unconsumed. It then leaks out as sibling fields and swallows the following group's
 * identifier (a silent desync seen on vanilla `ION_ENERGY = -(&Part/…)`). The operand is parsed and
 * wrapped as a MathExpression `[sign, operand]`, mirroring how the game reads a unary-negated
 * parenthesized value.
 *
 * @param state the parse state, positioned on the `(`.
 * @param token the sign token.
 * @param parent the container the node belongs to.
 * @returns the negated group, or the bare sign when the group carried no operand.
 */
const negatedParenGroup = (
    state: ParserState,
    token: Token,
    parent?: GroupNode | ListNode | AbstractNodeDocument
): AbstractNode => {
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
    const operand = state.walk(state, undefined, parent);
    // Nothing to negate (e.g. an empty `()` already reported). Leave the bare sign rather than
    // fabricate an operand.
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
};

/**
 * Reads a super-path reference the `/` opens, like `/SW_X` or `/Foo/Bar`.
 *
 * @param state the parse state, positioned on the segment token.
 * @param token the `/` token.
 * @param tokenValue the segment token's text.
 * @param parent the container the node belongs to.
 * @returns the reference as one value node.
 */
const superPathValue = (
    state: ParserState,
    token: Token,
    tokenValue: string,
    parent?: GroupNode | ListNode | AbstractNodeDocument
): ValueNode => {
    const value = '/' + tokenValue;
    state.current++;
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
            // The segment token was just consumed (it is now `tokens[state.current - 1]`). Read its
            // end, not `tokens[state.current]` which may be undefined at EOF (`X = /Ref` as the last
            // line) and would throw.
            end: state.tokens[state.current - 1]?.end ?? token.end ?? 0,
            line: token.lineNumber,
            start: token.start,
        },
    } as ValueNode;
};

/**
 * The operator as its own node, the reading left when no fold above applies.
 *
 * @param token the operator token.
 * @param parent the container the node belongs to.
 * @returns the expression node.
 */
const operatorNode = (token: Token, parent?: GroupNode | ListNode | AbstractNodeDocument): ExpressionNode =>
    ({
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
    }) as ExpressionNode;

/**
 * Reads an operator token. It is a sign folded into the value that follows it, the `/` of a
 * super-path reference, or the bare operator itself.
 *
 * @param state the parse state, positioned on the operator.
 * @param token the operator token.
 * @param _lastNode the node read before the operator, which decides whether it is a sign or binary.
 * @param parent the container the node belongs to.
 * @returns the folded value, the negated group, or the operator as its own node.
 */
export const parseExpression = (
    state: ParserState,
    token: Token,
    _lastNode: AbstractNode | undefined,
    parent?: GroupNode | ListNode | AbstractNodeDocument
): AbstractNode => {
    const { tokens } = state;
    state.current++;
    // case for negative numbers last token is not a value and next token is a value and is a number
    const tokenValue = tokens[state.current]?.value;
    // Whether the preceding node already produced a complete value, which makes the operator
    // that follows binary (e.g. the `*` in `sqrt(x) * 2`) rather than a unary sign on the next
    // number. A plain value, a function call, and a parenthesized math group all qualify, as
    // does a postfix `!` (factorial) which completes the value before it (e.g. `4! / 7`).
    const lastCompletesValue =
        _lastNode?.type === 'Value' ||
        _lastNode?.type === 'FunctionCall' ||
        _lastNode?.type === 'MathExpression' ||
        (!!_lastNode && isExpressionNode(_lastNode) && (_lastNode as ExpressionNode).expressionType === '!');
    const isSign = token.value === '-' || token.value === '+';
    if (
        tokenValue &&
        tokens[state.current - 2] &&
        tokens[state.current]?.type === TOKEN_TYPES.VALUE &&
        IS_NUMBER.test(tokenValue) &&
        // Defensive guard: only fold values JS can actually coerce, anything else falls
        // through to the unit-suffix branch below rather than folding to a NaN value.
        !Number.isNaN(Number(tokenValue)) &&
        // Only a sign folds into the number. Reading any operator as a minus turned `+3`
        // into -3 and even `* 3` into -3, so a hint showed a number of the wrong sign and
        // the stray operator the game refuses went unreported.
        isSign &&
        !lastCompletesValue
    ) {
        return signedNumberValue(state, token, tokenValue, parent);
    }
    if (
        tokenValue &&
        tokens[state.current - 2] &&
        tokens[state.current]?.type === TOKEN_TYPES.VALUE &&
        // The operand must be on the same line as the sign: a bare `-`/`+` that is itself the
        // whole value (vanilla ru.rules key names `MinusUnderscore = -`, `PlusEquals = +`) is
        // followed by the next line's field. Folding across the newline would steal that
        // field's identifier and desync the parse.
        !tokens[state.current]?.precededByNewline &&
        isSign &&
        (NUMBER_WITH_UNIT.test(tokenValue) || IDENTIFIER_VALUE.test(tokenValue) || GLUED_ARITHMETIC.test(tokenValue)) &&
        !lastCompletesValue
    ) {
        return signedUnitValue(state, token, tokenValue, parent);
    }
    if (isSign && !lastCompletesValue && tokens[state.current]?.type === TOKEN_TYPES.LEFT_PAREN) {
        return negatedParenGroup(state, token, parent);
    }
    // A super-path segment must be on the same line as the `/`: references are always written
    // contiguously, and the lexer drops newlines, so without this guard a bare `/` value
    // (`SlashQuestion = /` in cosmoteer `strings/*.rules`) would swallow the next line's identifier
    // as its segment. The segment is also a name (`/SW_X`, `/BASE_SOUNDS`): one starting with a
    // digit is really math the lexer glued through a value-char `-`, since `166/64-0.6` lexes as
    // `166`, `/`, `64-0.6`, and folding that would build a bogus reference `/64-0.6` instead of
    // reading the `/` as division.
    if (
        tokenValue &&
        token.value === '/' &&
        tokens[state.current]?.type === TOKEN_TYPES.VALUE &&
        tokens[state.current]?.lineNumber === token.lineNumber &&
        !IS_NUMBER.test(tokenValue) &&
        STARTS_WITH_NAME_CHAR.test(tokenValue)
    ) {
        return superPathValue(state, token, tokenValue, parent);
    }
    return operatorNode(token, parent);
};

/**
 * Whether the value just read is followed by an implicit multiplication.
 *
 * Implicit multiplication: a value-like operand immediately followed by `(` on the same line
 * (`3(&~/Range)` = `3 * (&~/Range)`). The game reads the field value flat and mXparser applies
 * implied multiplication. Without this the `( … )` leaks as a sibling value. Only a
 * numeric/value/expression `first` qualifies (not a group/list) and only when not preceded by a
 * newline (which ends the value).
 *
 * @param state the parse state, positioned after the value.
 * @param first the value the chain continues from.
 * @returns true when the `(` that follows multiplies the value before it.
 */
const nextIsImplicitMult = (state: ParserState, first: AbstractNode | null): boolean =>
    first !== null &&
    state.tokens[state.current]?.type === TOKEN_TYPES.LEFT_PAREN &&
    !state.tokens[state.current]?.precededByNewline &&
    (first.type === 'Value' ||
        first.type === 'MathExpression' ||
        first.type === 'FunctionCall' ||
        first.type === 'Expression');

/**
 * The source text a token contributes to an assembled operator.
 *
 * @param token the token to read.
 * @returns its source text, or null when the token cannot be part of an operator.
 */
const assembledText = (token: Token): string | null => {
    switch (token.type) {
        case TOKEN_TYPES.VALUE:
        case TOKEN_TYPES.EXPRESSION:
        case TOKEN_TYPES.UNEXPECTED:
            return typeof token.value === 'string' ? token.value : null;
        case TOKEN_TYPES.EQUALS:
            return '=';
        case TOKEN_TYPES.LEFT_PAREN:
            return '(';
        case TOKEN_TYPES.RIGHT_PAREN:
            return ')';
        default:
            return null;
    }
};

/**
 * The longest operator spelled by the token run the cursor sits on.
 *
 * The mXparser operators the lexer does not emit as one EXPRESSION token (boolean `&`, `||`,
 * relations `<=`/`==`/`<>`, modulo `#`, bitwise `@&`, tetration `^^`, …) reach us as short runs of
 * VALUE/EXPRESSION/EQUALS/UNEXPECTED/paren tokens. Assemble the longest run whose concatenated
 * source text is a known operator, requiring the tokens to be adjacent in the source (mXparser
 * reads `< =` as two tokens, never as `<=`) and the operator to be followed on the same line by a
 * `(` or a plain number, the only operand forms the game's reference substitution supports. Vanilla
 * `statuses/fire` has `(&SCORCH_PER_SECOND) & (&TickInterval)`. The narrow shape keeps unquoted
 * text values such as `Guns & Roses` or `A | B` concatenating to a flat string like the game does.
 *
 * @param state the parse state, positioned on the first token of the run.
 * @returns the operator and how many tokens spell it, or null when the run spells none.
 */
const matchAssembledOperator = (state: ParserState): { op: MxAssembledOperator; tokenCount: number } | null => {
    const { tokens } = state;
    if (!tokens[state.current] || tokens[state.current].precededByNewline) return null;
    let text = '';
    let best: { op: MxAssembledOperator; tokenCount: number } | null = null;
    for (let count = 0; count < 3; count++) {
        const token = tokens[state.current + count];
        if (!token) break;
        if (count > 0) {
            const previous = tokens[state.current + count - 1];
            const previousText = assembledText(previous) ?? '';
            const adjacent =
                token.lineNumber === previous.lineNumber &&
                token.lineOffset === previous.lineOffset + previousText.length;
            if (!adjacent) break;
        }
        const part = assembledText(token);
        if (part === null) break;
        text += part;
        if (!MX_ASSEMBLED_OPERATOR_PREFIXES.has(text)) break;
        if (!MX_ASSEMBLED_OPERATOR_SET.has(text)) continue;
        const operand = tokens[state.current + count + 1];
        const operandQualifies =
            operand &&
            !operand.precededByNewline &&
            (operand.type === TOKEN_TYPES.LEFT_PAREN ||
                (operand.type === TOKEN_TYPES.VALUE &&
                    typeof operand.value === 'string' &&
                    IS_NUMBER.test(operand.value)));
        if (operandQualifies) best = { op: text as MxAssembledOperator, tokenCount: count + 1 };
    }
    return best;
};

/**
 * Whether the value just read can stand on the left of a math operator.
 *
 * @param first the value the chain would continue from.
 * @returns true when an operator after it reads as math.
 */
const firstIsMathOperand = (first: AbstractNode | null): boolean =>
    first !== null &&
    (first.type === 'MathExpression' ||
        first.type === 'FunctionCall' ||
        (first.type === 'Value' &&
            ((first as ValueNode).valueType.type === 'Reference' || (first as ValueNode).valueType.type === 'Number')));

/**
 * After a value, a math operator at the same level (not inside parens) starts a
 * binary expression. Consume the whole `value (op value)*` chain as one
 * MathExpression. Without this the trailing `op value` stays orphaned at the
 * container level and can swallow the following token (e.g. `XXLChance = 1/16`
 * leaves `/16`, which then consumes the next identifier `CommonAsteroidTypes`).
 * The operator is consumed here so `/16` is not misread as a `/`-super-path value.
 *
 * @param state the parse state, positioned after the value the chain continues from.
 * @param first the value the chain continues from.
 * @param parent the container the chain belongs to.
 * @returns the whole chain as one node, or `first` unchanged when no operator followed it.
 */
export const continueMathExpression = (
    state: ParserState,
    first: AbstractNode | null,
    parent?: GroupNode | ListNode | AbstractNodeDocument
): AbstractNode | null => {
    const { tokens } = state;
    if (
        !first ||
        (tokens[state.current]?.type !== TOKEN_TYPES.EXPRESSION &&
            !nextIsImplicitMult(state, first) &&
            !(firstIsMathOperand(first) && matchAssembledOperator(state) !== null))
    ) {
        return first;
    }
    const mathNode: MathExpressionNode = {
        type: 'MathExpression',
        elements: [first as ValueNode],
        parent,
        position: { ...first.position },
    };
    // Stop the math chain at an unsuppressed line break: ObjectText ends a value at the
    // newline, so `X = 1\n+ 2` is `X = 1` (the `+ 2` is not folded into the value).
    for (;;) {
        const operatorToken = tokens[state.current];
        if (!operatorToken || operatorToken.precededByNewline) break;
        // An assembled operator wins over the single-token reads below, so `!=` is the relation
        // rather than a factorial followed by an `=`, and `^^` is tetration rather than two
        // dangling powers.
        const assembled = matchAssembledOperator(state);
        if (
            !assembled &&
            operatorToken.type !== TOKEN_TYPES.EXPRESSION &&
            operatorToken.type !== TOKEN_TYPES.LEFT_PAREN
        ) {
            break;
        }
        const isImplicitMult = !assembled && operatorToken.type === TOKEN_TYPES.LEFT_PAREN;
        const operatorTokenCount = assembled?.tokenCount ?? 1;
        const lastOperatorToken = tokens[state.current + operatorTokenCount - 1];
        mathNode.elements.push({
            type: 'Expression',
            expressionType: assembled
                ? assembled.op
                : isImplicitMult
                  ? '*'
                  : (operatorToken.value as ExpressionNode['expressionType']),
            parent,
            position: {
                line: operatorToken.lineNumber,
                characterStart: operatorToken.lineOffset,
                characterEnd: lastOperatorToken.lineOffset + (assembledText(lastOperatorToken)?.length ?? 1),
                start: operatorToken.start,
                end: lastOperatorToken.end ?? 0,
            },
        } as ExpressionNode);
        // For an explicit operator, consume it so the operand is not lexed as a `/`-path. For an
        // implicit `*` there is no operator token, so leave `(` for `walk` to consume as a group.
        if (!isImplicitMult) state.current += operatorTokenCount;
        // `!` is postfix (factorial): it applies to the value already pushed, so there is no
        // right operand to consume. Keep scanning for the next operator instead.
        if (!assembled && !isImplicitMult && operatorToken.value === '!') {
            mathNode.position.end = operatorToken.end ?? mathNode.position.end;
            mathNode.position.characterEnd = operatorToken.lineOffset + 1;
            continue;
        }
        // A plain-number right operand is consumed directly: handing it to `walk` misreads a
        // number followed by more operator tokens as the start of a new node (`1 + 2 == 3`
        // turned the `2` into an assignment identifier once `==` support made `=` reachable
        // inside values).
        const operandToken = tokens[state.current];
        let operand: AbstractNode | null;
        if (
            operandToken?.type === TOKEN_TYPES.VALUE &&
            typeof operandToken.value === 'string' &&
            IS_NUMBER.test(operandToken.value) &&
            !operandToken.precededByNewline
        ) {
            operand = {
                type: 'Value',
                valueType: inferValueType(operandToken),
                parent,
                position: {
                    characterEnd: operandToken.lineOffset + operandToken.value.length,
                    characterStart: operandToken.lineOffset,
                    end: operandToken.end ?? 0,
                    line: operandToken.lineNumber,
                    start: operandToken.start,
                },
            } as ValueNode;
            state.current++;
        } else if (!operandToken || operandToken.precededByNewline) {
            // The value ended at the line break, so the operator is trailing and the next line
            // is a member of its own. Walking it anyway pulled the following field into this
            // expression and made it disappear from the tree, while the missing operand went
            // unreported. Leaving it here is what lets the math check name the real mistake.
            break;
        } else {
            operand = state.walk(state, undefined, parent);
        }
        if (!operand) break;
        mathNode.elements.push(operand as ValueNode | MathExpressionNode | ExpressionNode);
        // Some recovered operands carry no own `position` (e.g. an Assignment parsed out of
        // malformed input). Keep the operand but leave the math node's span as-is.
        if (operand.position) {
            mathNode.position.end = operand.position.end;
            mathNode.position.characterEnd = operand.position.characterEnd;
        }
    }
    return mathNode;
};
