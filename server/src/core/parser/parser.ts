import { DocumentUri } from 'vscode-languageserver';
import { Token, TOKEN_TYPES } from '../lexer/lexer';
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
    MX_ASSEMBLED_OPERATORS,
    MxAssembledOperator,
    ValueNode,
    ValueNodeTypes,
} from '../ast/ast';
import * as l10n from '@vscode/l10n';

// Set form of the assembled-operator spellings for the O(1) lookups in `matchAssembledOperator`,
// plus every proper prefix of a spelling so a non-viable token run is abandoned on its first
// token. This keeps the matcher O(1) on ordinary values ("Guns" is not a prefix, done), which
// matters because it runs once per math-chain step of every parse.
const MX_ASSEMBLED_OPERATOR_SET: ReadonlySet<string> = new Set(MX_ASSEMBLED_OPERATORS);
const MX_ASSEMBLED_OPERATOR_PREFIXES: ReadonlySet<string> = new Set(
    MX_ASSEMBLED_OPERATORS.flatMap((op) => Array.from({ length: op.length }, (_, i) => op.slice(0, i + 1)))
);
// A file this broken carries no usable tree past this point, so parsing stops to bound the work.
// Deliberately not the user's `maxNumberOfProblems`: the parse result is cached and persisted by
// content, so it must not vary with a setting, and both diagnostic sites truncate on the setting
// anyway.
const MAX_PARSER_ERRORS = 100;

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
    [TOKEN_TYPES.TRUE]: 'true',
    [TOKEN_TYPES.FALSE]: 'false',
};

/**
 * The text a token reads as in an error message, preferring its literal value.
 *
 * @param token the token to describe.
 * @returns the token's source text, punctuation spelling, or type name.
 */
const tokenDisplayText = (token: Token): string => token.value ?? TOKEN_DISPLAY[token.type] ?? token.type;

/**
 * The tokens the game accepts directly after a member name: an assignment, an inheritance colon, a
 * `{`/`[` body, or one of the terminators that end the member. A line break ends the member too and
 * leaves a void node behind, which is why it is handled separately from this set.
 */
const NAME_FOLLOWERS: ReadonlySet<TOKEN_TYPES> = new Set([
    TOKEN_TYPES.EQUALS,
    TOKEN_TYPES.COLON,
    TOKEN_TYPES.LEFT_BRACE,
    TOKEN_TYPES.LEFT_BRACKET,
    TOKEN_TYPES.SEMICOLON,
    TOKEN_TYPES.COMMA,
    TOKEN_TYPES.RIGHT_BRACE,
    TOKEN_TYPES.RIGHT_BRACKET,
]);

/**
 * The tokens a bare run between two quoted segments of one value may hold. An unescaped `"` inside a
 * quoted value splits it into segments with bare source between them, and the game reads that whole
 * run as one value, so everything in it belongs to the string. Prose punctuation the lexer has no
 * grammar for arrives as UNEXPECTED (`?`, `#`, `@`), and the run also carries brackets, a colon and
 * the boolean words, all of which the game keeps in the value (verified against `OTFile`).
 *
 * The value terminators stay out: a `,` or `;` in such a run makes the game refuse the file, and a
 * `}`/`]` closes the parent, so absorbing either would hide a real error. `=`, `{` and `[` stay out
 * too: they carry no meaning inside a quoted value, and swallowing them could silently eat the
 * structure of a following member.
 */
const IN_STRING_RUN: ReadonlySet<TOKEN_TYPES> = new Set([
    TOKEN_TYPES.VALUE,
    TOKEN_TYPES.EXPRESSION,
    TOKEN_TYPES.UNEXPECTED,
    TOKEN_TYPES.LEFT_PAREN,
    TOKEN_TYPES.RIGHT_PAREN,
    TOKEN_TYPES.COLON,
    TOKEN_TYPES.TRUE,
    TOKEN_TYPES.FALSE,
]);

/**
 * True when an identifier read in `parent` is a list element. The game never names list
 * children: an identifier there is its own element (a text value, or a reference node for
 * `&…`), and a following `{`/`[`/`:` opens a separate anonymous element. The parser must
 * therefore neither turn a list identifier into the head of the next container nor let that
 * container pick it up as its name.
 *
 * @param parent the container the identifier was read in.
 * @returns whether identifiers in this container stand alone.
 */
const isListElementIdentifier = (parent: AbstractNode | undefined): boolean => parent?.type === 'List';

export const parser = (tokens: Token[], uri: DocumentUri): TokenParserResult => {
    let current = 0;
    const errors: ParserError[] = [];
    // Plain numbers: an integer/decimal mantissa, including a leading-dot decimal such as `.5`
    // or `.75` (common in Cosmoteer, e.g. `Bleed = .75 * .5`), with an optional scientific
    // exponent (`3.4028235E+38`, `1.5e10`). A `d`-suffixed number (`90d`) is not a plain number:
    // the game's ExpressionEvaluator converts it degrees-to-radians, so it must stay a String and
    // go through the suffix rules in the value evaluator (typing it `Number 90` showed 90 where
    // the game computes 1.5708). The previous pattern also put the `^` anchor mid-expression
    // (`[-.]?^…`), which made the leading `-`/`.` branch dead and typed `.5` as a String,
    // breaking value typing, math validation and resolved-value computation.
    const IS_NUMBER = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
    // A numeric literal carrying a unit suffix: percent `%`, degrees `d`, radians `r` (mXparser /
    // Cosmoteer expression suffixes). The lexer keeps the suffix inside the value token, so `40%`
    // lexes as one String value. Used so a leading sign (`-40%`) folds into that value instead of
    // leaking the sign as a lone Expression and desyncing the parse.
    const NUMBER_WITH_UNIT = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[%dr]$/;
    // An arithmetic run the lexer glued into one token because `-` and `.` are value characters
    // (`0.38-0.015`). Only digits, dots and operators, so a word or a reference never matches.
    const GLUED_ARITHMETIC = /^[\d.]+(?:[-+*/][\d.]+)+$/;
    /**
     * Whether the token continues the previous line through a `\`, which suppresses the newline. The
     * lexer only marks an unsuppressed newline, so a continued token looks like it shares the line
     * with what came before it. A continued run is part of a value the game reads as one string, and
     * the words in it are never member names.
     *
     * @param token the token to judge.
     * @param previous the token before it, or undefined at the start of the file.
     * @returns true when a suppressed newline separates the two.
     */
    const continuesPreviousLine = (token: Token, previous: Token | undefined): boolean =>
        !!previous && token.lineNumber > previous.lineNumber && !token.precededByNewline;
    
    /**
     * Reports a member name the game refuses to read in group or document position. ObjectText reads
     * the name and then requires `=`, `:`, `{`, `[`, a terminator or a line break, and it never lets a
     * number name a member. Both spellings make the game throw and drop the whole file. Our
     * unquoted-value charset holds spaces so that a value keeps its words together, which means a
     * whole sentence of prose arrives here as one name token, and the whitespace test is what
     * catches it.
     *
     * @param token the name token.
     * @param next the token following the name, undefined at the end of the file.
     */
    const reportInvalidMemberName = (token: Token, next: Token | undefined, previous: Token | undefined): void => {
        // A `\` continuation glues the next line onto this value, so nothing in the run is a name.
        if (continuesPreviousLine(token, previous)) return;
        const name = typeof token.value === 'string' ? token.value : '';
        if (IS_NUMBER.test(name)) {
            errors.push({
                message: l10n.t('A number cannot name a member'),
                token,
                additionalInfo: [
                    {
                        message: l10n.t(
                            'The game reads a number as a list element or as a path segment, never as the name of a group member. It fails to load the whole file on this.'
                        ),
                    },
                ],
            } as ParserError);
            return;
        }
        if (!/\s/.test(name) && (!next || next.precededByNewline || NAME_FOLLOWERS.has(next.type))) {
            return;
        }
        errors.push({
            message: l10n.t('A member name must be followed by "=", ":", "{", "[" or the end of the line'),
            token,
            additionalInfo: [
                {
                    message: l10n.t(
                        'The game stops at anything else and fails to load the whole file. Free text such as a note or a description has to go into a "//" comment or a quoted value.'
                    ),
                },
            ],
        } as ParserError);
    };
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
     * @param at the index of the token in question.
     * @returns true when the token opens a new member.
     */
    const startsNewMember = (at: number): boolean =>
        tokens[at]?.type === TOKEN_TYPES.VALUE &&
        (tokens[at + 1]?.type === TOKEN_TYPES.EQUALS || tokens[at + 1]?.type === TOKEN_TYPES.COLON);

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
                // An identifier element in a list never names the container that follows it
                // (the game keeps it a standalone element and the body opens a separate
                // anonymous element), so it must not be consumed as this group's identifier.
                identifier:
                    _lastNode && isIdentifierNode(_lastNode) && !isListElementIdentifier(parent)
                        ? _lastNode
                        : undefined,
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
                const before = current;
                const nextNode = walk(lastNode, node);
                if (!nextNode) {
                    // A member that read its tokens and still built nothing, an inheritance whose body
                    // never came being the one that happens while typing. The group has to keep
                    // reading, or one unfinished member costs every member after it. Guarded on the
                    // cursor having moved, so a walk that declines without consuming still ends the
                    // body instead of spinning.
                    if (current > before && tokens[current]) continue;
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
                identifier:
                    _lastNode && isIdentifierNode(_lastNode) && !isListElementIdentifier(parent)
                        ? _lastNode
                        : undefined,
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
                // A list element ends only at `,`, `;`, a line break or `]`, so an operator run
                // belongs to the element it follows: the game reads `[255*.45, 255*.45]` as two
                // elements. Folding the run into one node here is what keeps every index in the list
                // the index the game sees, which positional fields and `…/1` references depend on.
                const nextNode = continueMathExpression(walk(lastNode, node), node);
                if (nextNode === null) {
                    break;
                }
                lastNode = nextNode;
                node.elements.push(nextNode);
                if (tokens[current]?.type === TOKEN_TYPES.COMMA || tokens[current]?.type === TOKEN_TYPES.SEMICOLON) {
                    // Record the terminator on the element: a separated name before a `{`/`[` body
                    // is two legal elements, only an unseparated one merges into the body's line.
                    if (isValueNode(nextNode) || isIdentifierNode(nextNode)) {
                        nextNode.delimiter = tokens[current].type === TOKEN_TYPES.COMMA ? ',' : ';';
                    }
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
            // line-continued form `"a"\ <newline> "b"` are a single string. They lex as adjacent
            // STRING tokens. The continuation segments carry no unsuppressed newline (a `\` before
            // the newline suppresses it, or the segments share a line). Without joining them the
            // trailing segments leak as sibling values: junk nodes in localization files, and in
            // the heat_management tutorial a continued string even stole the following `Entries`
            // list's identifier. Stop at an unsuppressed newline, which genuinely ends the value.
            // An unescaped quote inside a quoted value splits it into segments with bare words
            // between them, which is how `"… the "C" symbol …"` and vanilla's `"… the "military free
            // market", though …"` lex. The game reads the whole run as one value, so those bare
            // words belong to the string. Without absorbing them they leak as sibling members and
            // invent nodes the game never sees, including bogus localization keys. Only a run of
            // bare words that leads back into another segment on the same line is taken, which keeps
            // a genuine trailing word, a reference and an operator out of the string. The run has to
            // start on a word, but everything in {@link IN_STRING_RUN} may sit inside it, since prose
            // is full of `Mod - Expansion` dashes and `pourquoi ?` question marks and none of them
            // carry meaning inside a quoted value.
            // The game separates two unquoted tokens of a value by a single space when the source
            // separates them, and concatenates a quoted token with its neighbour directly whatever
            // stands between them (`"start"   tail ?` is the value `starttail ?`). The assembled
            // text follows the same rule.
            let previousWasQuoted = true;
            let previousEnd = token.end ?? token.start;
            for (;;) {
                const next = tokens[current];
                if (!next || next.precededByNewline) break;
                if (next.type === TOKEN_TYPES.STRING) {
                    value += next.value as string;
                    previousWasQuoted = true;
                    previousEnd = next.end ?? next.start;
                    current++;
                    continue;
                }
                if (next.type !== TOKEN_TYPES.VALUE) break;
                let lookahead = current;
                for (;;) {
                    const type = tokens[lookahead]?.type;
                    if (!type || !IN_STRING_RUN.has(type) || tokens[lookahead]?.precededByNewline) break;
                    lookahead++;
                }
                const rejoins = tokens[lookahead]?.type === TOKEN_TYPES.STRING && !tokens[lookahead]?.precededByNewline;
                if (!rejoins) break;
                while (current <= lookahead) {
                    const runToken = tokens[current];
                    const quoted = runToken.type === TOKEN_TYPES.STRING;
                    if (!quoted && !previousWasQuoted && runToken.start > previousEnd) value += ' ';
                    value += tokenDisplayText(runToken);
                    previousWasQuoted = quoted;
                    previousEnd = runToken.end ?? runToken.start;
                    current++;
                }
            }
            // The quoted-string span must include the surrounding quotes (and any adjacent
            // concatenated segments), so derive the end from the last consumed token's absolute
            // offset rather than the unquoted content length, which is short by the quote characters
            // and would corrupt the file on rename and truncate every quoted-value highlight/hover.
            const lastStringToken = tokens[current - 1] ?? token;
            const endOffset = lastStringToken.end ?? token.end ?? token.start;
            // A quoted value is a string literal even when its content is all digits: the game reads
            // `SituationCode = "0000"` as the eight-character text, not the number 0. Never let the
            // numeric inference type a quoted token `Number`, or its highlight and hover read as a
            // number and the leading zeros vanish.
            const inferredType = inferValueType(IS_NUMBER, token);
            const quotedType = inferredType.type === 'Number' ? { type: 'String' as const } : inferredType;
            return {
                type: 'Value',
                // Keep the type inferred from the first segment (String/Sprite/Sound/…) but carry the
                // full concatenated text as the value, so hover/rename/goto see the whole string.
                valueType: { ...quotedType, value } as ValueNodeTypes,
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
                // Defensive guard: only fold values JS can actually coerce, anything else falls
                // through to the unit-suffix branch below rather than folding to a NaN value.
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
            // sibling value, silently desyncing the parse. It swallows the following named
            // group/list's identifier (seen on vanilla `BaseValue = -0.6%` stealing the next
            // `Modifiers` list, and `MinIntensity = -Infinity`). Fold the sign into a single String
            // value, mirroring the positive form (`40%` / `Infinity` also lex as plain Strings).
            // Downstream percent/unit regexes already accept a leading `-`. References and paths
            // (`&…`, `/…`, `<…`) are excluded: a negated reference belongs in a MathExpression.
            else if (
                tokenValue &&
                tokens[current - 2] &&
                tokens[current]?.type === TOKEN_TYPES.VALUE &&
                // The operand must be on the same line as the sign: a bare `-`/`+` that is itself the
                // whole value (vanilla ru.rules key names `MinusUnderscore = -`, `PlusEquals = +`) is
                // followed by the next line's field. Folding across the newline would steal that
                // field's identifier and desync the parse.
                !tokens[current]?.precededByNewline &&
                (token.value === '-' || token.value === '+') &&
                (NUMBER_WITH_UNIT.test(tokenValue) ||
                    /^[A-Za-z_][\w.]*$/.test(tokenValue) ||
                    GLUED_ARITHMETIC.test(tokenValue)) &&
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
            // negative-number branch above only folds `-<number>`. A parenthesized operand is not a
            // bare number, so without this the sign would be returned as a lone Expression node and the
            // `( … )` left unconsumed. It then leaks out as sibling fields and swallows the following
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
                // Nothing to negate (e.g. empty `()` already reported). Leave the bare sign rather
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
            // case for Values starting with /: a super-path reference like `/SW_X` or `/Foo/Bar`.
            // The reference segment must be on the same line as the `/`: references are always
            // written contiguously, and the lexer drops newlines, so without this guard a bare `/`
            // value (`SlashQuestion = /` in cosmoteer `strings/*.rules`) would swallow the next
            // line's identifier as its segment. OT terminates the value at the newline, leaving `/`.
            else if (
                tokenValue &&
                token.value === '/' &&
                tokens[current]?.type === TOKEN_TYPES.VALUE &&
                tokens[current]?.lineNumber === token.lineNumber &&
                !IS_NUMBER.test(tokenValue) &&
                // A super-path segment is a name (`/SW_X`, `/BASE_SOUNDS`). A segment that starts with
                // a digit is really math the lexer glued through a value-char `-`: `166/64-0.6` lexes
                // as `166`, `/`, `64-0.6`, and without this guard the `/` folds `64-0.6` into a bogus
                // reference `/64-0.6` (which then reports as an unresolved reference). Treat it as the
                // division operator instead by falling through to the Expression case below.
                /^[A-Za-z_]/.test(tokenValue)
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
                    // is built directly here. Anything more complex (nested parens or
                    // math such as `ceil(((&a)*4+(&b))/3)`) is left to the general
                    // argument loop below, which `walk`s each argument (and `walk`
                    // already resolves nested parens). Without this guard the next token
                    // after the consumed `(` could be another `(`, and inferValueType
                    // would throw on a LEFT_PAREN, aborting the whole file's parse.
                    // Only the exact shape `( VALUE )` is taken as a simple parenthesized first
                    // argument (closing `)` immediately after the value). Anything larger (a
                    // nested call `(name(...))`, or an expression `( VALUE op … )` such as the
                    // `(1 / (&X))` in `ceil((1 / (&X)))`) must fall through to the general
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
                                characterEnd: currentToken.lineOffset + (currentToken.value as string).length,
                                characterStart: currentToken.lineOffset,
                                end: currentToken.end ?? 0,
                                line: currentToken.lineNumber,
                                start: currentToken.start,
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
                    // not just its name: callers (e.g. inlay hints) place markers after it. A
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
                // Empty parentheses `()`: the `(` is immediately closed. Consume the `)` here and
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
                // MathExpression or FunctionCall) we walked past the value into the next field,
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
                    // parenthesized group (e.g. `(6/1)` or `((&~/SIZE/0)/2)`). A missing `)`,
                    // whether a stray non-paren token interrupted the group or the file ended
                    // mid-expression (`X = (5 + 3`), leaves `closeParen` undefined and is reported.
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
                // A single parenthesized value whose `)` never arrives (`X = (&A`): the value
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
                // A newline after `=` does not end the value. The game skips ahead to the next
                // significant token, so `DamageResistances =` with its `{ … }` body on the following
                // line is that field's group, `RandomSounds =` with its `[ … ]` underneath is that
                // field's list, and `OnDeath =` above a reference binds the reference.
                // Two cases deliberately stay empty instead. Both are inputs the game answers with a
                // parse error that cascades to the end of the file, so staying graceful beats
                // reproducing it. A member terminator or EOF (`X =` right before `}`) is one of them,
                // because consuming it would eat the enclosing group's closer and desync the whole
                // container, which is exactly the live-editing state right after a completion snippet
                // scaffolds the field or the user deletes a value. The head of a new member on a
                // later line (`X =` above `Y = 1`) is the other, since the game folds that whole
                // member into the value, which no shipped file relies on and no live edit ever means.
                const next = tokens[current];
                const following = tokens[current + 1];
                const nextStartsNewMember =
                    !!next.precededByNewline &&
                    (following?.type === TOKEN_TYPES.EQUALS || following?.type === TOKEN_TYPES.COLON);
                const valueIsEmpty =
                    nextStartsNewMember ||
                    next.type === TOKEN_TYPES.RIGHT_BRACE ||
                    next.type === TOKEN_TYPES.RIGHT_BRACKET ||
                    next.type === TOKEN_TYPES.SEMICOLON ||
                    next.type === TOKEN_TYPES.COMMA;
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
                    right: valueIsEmpty ? null : continueMathExpression(walk(_lastNode, parent), parent),
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
                    // Right after a `,` field separator, an identifier that heads a group/list/
                    // inheritance (`, Criterias [ … ]`, real mod gaugeincreaser.rules) is a new
                    // member, not a comma-separated value. So classify it as a value only when it is
                    // not immediately followed by `{`/`[`/`:` (else its opener is orphaned and the
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
                // The game accepts a bare `&…` reference only as a list element or a field
                // value. In group or document position it throws `Unexpected "&"` and the whole
                // file fails to load, so report it as a parse error while keeping the node for
                // navigation.
                if (typeof token.value === 'string' && token.value.startsWith('&') && parent?.type !== 'List') {
                    errors.push({
                        message: l10n.t('The game cannot read a standalone reference here'),
                        token,
                        additionalInfo: [
                            {
                                message: l10n.t(
                                    'A bare reference is only allowed as a list element or as a field value (Field = &/Path). The game fails to load the whole file on this.'
                                ),
                            },
                        ],
                    } as ParserError);
                } else if (parent?.type !== 'List') {
                    // A list element is not a member, so it carries none of the naming rules: a
                    // number and a run of words are both ordinary element values there.
                    reportInvalidMemberName(token, tokens[current], tokens[current - 2]);
                }
                if (
                    tokens[current]?.type === TOKEN_TYPES.LEFT_BRACE ||
                    tokens[current]?.type === TOKEN_TYPES.LEFT_BRACKET ||
                    tokens[current]?.type === TOKEN_TYPES.COLON
                ) {
                    // Inside a list the game never attaches a following `{`/`[`/`:` to an
                    // identifier element: the identifier stays its own element and the `{`/`:`
                    // opens a separate anonymous element, so keep it standalone instead of making
                    // it a head.
                    if (isListElementIdentifier(parent)) {
                        return node;
                    }
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
                    // A quoted base is legal: `Part : "A"` parses in the game exactly like
                    // `Part : A`, the quotes only delimit the one path (verified against
                    // Halfling.ObjectText in HalflingCore.dll).
                    tokens[current].type === TOKEN_TYPES.STRING ||
                    (tokens[current].type === TOKEN_TYPES.EXPRESSION &&
                        tokens[current + 1]?.type === TOKEN_TYPES.VALUE) ||
                    (tokens[current].type === TOKEN_TYPES.EXPRESSION && tokens[current].value === '/')) &&
                !startsNewMember(current)
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
                            token: tokens[current - 1],
                        } as ParserError);
                        break;
                    }
                } else {
                    errors.push({
                        message: l10n.t('Expected reference value after reference value but found {0}', nextNode.type),
                        token: tokens[current - 1],
                    } as ParserError);
                    break;
                }
                if (tokens[current] === undefined) {
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
            } else {
                // An inheritance describes what a body starts from, so the game demands that body
                // right after it and throws when it is missing. Without the body there is nothing to
                // hang the collected references on either, so they are dropped and the member
                // disappears from our tree.
                errors.push({
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
            }
            return right;
        }

        if (token.type === TOKEN_TYPES.SINGLE_COMMENT || token.type === TOKEN_TYPES.MULTI_COMMENT) {
            current++;
            return walk(_lastNode, parent);
        }

        if (token.type === TOKEN_TYPES.RIGHT_PAREN && _lastNode?.type !== 'Value') {
            // A `)` reaching here is unmatched. Every paren-group/function-call loop consumes its
            // own closing `)` before calling `walk`, so this is a stray paren. The real OT parser
            // (OTFieldNode) reads such a token as part of the value string, e.g. `RightBracket = )`
            // or `AsteroidGold_S = 金小惑星（S)` in cosmoteer `strings/*.rules`. When the field it
            // belongs to is still on the same line, append it there so the member keeps the one
            // value the game gives it. A full-width `（` is an ordinary value character, so only the
            // closing half reaches the parser and the value would otherwise lose it and gain a
            // sibling the game never sees.
            const previous = _lastNode?.type === 'Assignment' ? (_lastNode as AssignmentNode).right : undefined;
            if (previous && isValueNode(previous) && previous.position.line === token.lineNumber && !previous.quoted) {
                previous.valueType = {
                    ...previous.valueType,
                    value: `${previous.valueType.value})`,
                } as ValueNodeTypes;
                previous.position.characterEnd = token.lineOffset + 1;
                previous.position.end = token.end ?? previous.position.end;
                current++;
                return walk(_lastNode, parent);
            }
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
     * binary expression. Consume the whole `value (op value)*` chain as one
     * MathExpression. Without this the trailing `op value` stays orphaned at the
     * container level and can swallow the following token (e.g. `XXLChance = 1/16`
     * leaves `/16`, which then consumes the next identifier `CommonAsteroidTypes`).
     * The operator is consumed here so `/16` is not misread as a `/`-super-path value.
     */
    const continueMathExpression = (
        first: AbstractNode | null,
        parent?: GroupNode | ListNode | AbstractNodeDocument
    ): AbstractNode | null => {
        // Implicit multiplication: a value-like operand immediately followed by `(` on the same
        // line (`3(&~/Range)` = `3 * (&~/Range)`). The game reads the field value flat and mXparser
        // applies implied multiplication. Without this the `( … )` leaks as a sibling value. Only a
        // numeric/value/expression `first` qualifies (not a group/list) and only when not preceded by
        // a newline (which ends the value).
        const nextIsImplicitMult = () =>
            first !== null &&
            tokens[current]?.type === TOKEN_TYPES.LEFT_PAREN &&
            !tokens[current]?.precededByNewline &&
            (first.type === 'Value' ||
                first.type === 'MathExpression' ||
                first.type === 'FunctionCall' ||
                first.type === 'Expression');
        // The mXparser operators the lexer does not emit as one EXPRESSION token (boolean `&`,
        // `||`, relations `<=`/`==`/`<>`, modulo `#`, bitwise `@&`, tetration `^^`, …) reach us as
        // short runs of VALUE/EXPRESSION/EQUALS/UNEXPECTED/paren tokens. Assemble the longest run
        // whose concatenated source text is a known operator, requiring the tokens to be adjacent
        // in the source (mXparser reads `< =` as two tokens, never as `<=`) and the operator to be
        // followed on the same line by a `(` or a plain number, the only operand forms the game's
        // reference substitution supports. Vanilla `statuses/fire` has
        // `(&SCORCH_PER_SECOND) & (&TickInterval)`. The narrow shape keeps unquoted text values
        // such as `Guns & Roses` or `A | B` concatenating to a flat string like the game does.
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
        const matchAssembledOperator = (): { op: MxAssembledOperator; tokenCount: number } | null => {
            if (!tokens[current] || tokens[current].precededByNewline) return null;
            let text = '';
            let best: { op: MxAssembledOperator; tokenCount: number } | null = null;
            for (let count = 0; count < 3; count++) {
                const token = tokens[current + count];
                if (!token) break;
                if (count > 0) {
                    const previous = tokens[current + count - 1];
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
                const operand = tokens[current + count + 1];
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
        const firstIsMathOperand = () =>
            first !== null &&
            (first.type === 'MathExpression' ||
                first.type === 'FunctionCall' ||
                (first.type === 'Value' &&
                    ((first as ValueNode).valueType.type === 'Reference' ||
                        (first as ValueNode).valueType.type === 'Number')));
        const nextIsOperatorChain = () => firstIsMathOperand() && matchAssembledOperator() !== null;
        if (
            !first ||
            (tokens[current]?.type !== TOKEN_TYPES.EXPRESSION && !nextIsImplicitMult() && !nextIsOperatorChain())
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
            const operatorToken = tokens[current];
            if (!operatorToken || operatorToken.precededByNewline) break;
            // An assembled operator wins over the single-token reads below, so `!=` is the relation
            // rather than a factorial followed by an `=`, and `^^` is tetration rather than two
            // dangling powers.
            const assembled = matchAssembledOperator();
            if (
                !assembled &&
                operatorToken.type !== TOKEN_TYPES.EXPRESSION &&
                operatorToken.type !== TOKEN_TYPES.LEFT_PAREN
            ) {
                break;
            }
            const isImplicitMult = !assembled && operatorToken.type === TOKEN_TYPES.LEFT_PAREN;
            const operatorTokenCount = assembled?.tokenCount ?? 1;
            const lastOperatorToken = tokens[current + operatorTokenCount - 1];
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
            if (!isImplicitMult) current += operatorTokenCount;
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
            const operandToken = tokens[current];
            let operand: AbstractNode | null;
            if (
                operandToken?.type === TOKEN_TYPES.VALUE &&
                typeof operandToken.value === 'string' &&
                IS_NUMBER.test(operandToken.value) &&
                !operandToken.precededByNewline
            ) {
                operand = {
                    type: 'Value',
                    valueType: inferValueType(IS_NUMBER, operandToken),
                    parent,
                    position: {
                        characterEnd: operandToken.lineOffset + operandToken.value.length,
                        characterStart: operandToken.lineOffset,
                        end: operandToken.end ?? 0,
                        line: operandToken.lineNumber,
                        start: operandToken.start,
                    },
                } as ValueNode;
                current++;
            } else {
                operand = walk(undefined, parent);
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
        // `lastNode` so the completed entry is not bound to whatever follows, e.g. a void `Foo;`
        // must not become the identifier of a subsequent `Bar { … }` group.
        if (tokens[current].type === TOKEN_TYPES.SEMICOLON || tokens[current].type === TOKEN_TYPES.COMMA) {
            current++;
            lastNode = undefined;
            continue;
        }
        const nextNode = walk(lastNode, ast);
        if (errors.length > MAX_PARSER_ERRORS) {
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

// Hoisted out of inferValueType, which runs for every value token of every parsed file. Building
// the pattern there compiled a fresh RegExp per token.
const IS_SOUND = new RegExp(ALLOWED_AUDIO_EXTENSIONS.join('|').replaceAll('.', '\\.'), 'i');

function inferValueType(IS_NUMBER: RegExp, token: Token): ValueNodeTypes {
    if (typeof token.value === 'undefined') throw new Error('Token value is undefined');
    let value: ValueNodeTypes['value'] = token.value;
    let valueType: ValueNodeTypes['type'] = IS_NUMBER.test(token.value) ? 'Number' : 'String';
    // Every asset form below contains a dot, so one indexOf spares most strings the two regex
    // tests and the suffix check. Hot: this runs for every string value of every parse.
    // Extension matches fold case: the game resolves paths through the case-insensitive
    // Windows FS, so `Icon.PNG` or `<Foo.Rules>` load exactly like their lowercase spellings.
    const hasDot = token.value.includes('.');
    const lower = hasDot ? token.value.toLowerCase() : token.value;
    if (valueType === 'String' && hasDot && lower.includes('.png')) {
        valueType = 'Sprite';
        value = value as string;
    } else if (valueType === 'String' && hasDot && IS_SOUND.test(token.value)) {
        valueType = 'Sound';
        value = value as string;
    } else if (valueType === 'String' && hasDot && lower.endsWith('.shader')) {
        valueType = 'Shader';
        value = value as string;
    } else if (
        // A reference sigil must be followed by a path/name: a lone `~`, `/`, `^`, `&`, or `..`
        // (no member) is not a resolvable reference, it is a literal value (the keyboard key-name
        // strings `TildeBacktick = ~`, `SlashQuestion = /` in cosmoteer `strings/*.rules`). Typing
        // those as references produced spurious "Reference should start with an ampersand" errors.
        (token.value.startsWith('&') && token.value.length > 1) ||
        (token.value.startsWith('^') && token.value.length > 1) ||
        (token.value.startsWith('..') && token.value.length > 2) ||
        (token.value.startsWith('/') && token.value.length > 1) ||
        (token.value.startsWith('~') && token.value.length > 1) ||
        // Mods write rules content in `.txt` files too (the game's loader ignores the extension),
        // so `<file.txt>` paths are references exactly like `<file.rules>`.
        (token.value.startsWith('<') && (lower.includes('.rules') || lower.includes('.txt'))) ||
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
