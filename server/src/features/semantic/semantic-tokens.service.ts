import { SemanticTokens, SemanticTokensBuilder } from 'vscode-languageserver';
import { modifierBit, TokenType, typeIndex } from './legend';
import {
    AbstractNode,
    AbstractNodeDocument,
    AstPosition,
    GroupNode,
    isAssignmentNode,
    isExpressionNode,
    isFunctionCallNode,
    isGroupNode,
    isListNode,
    isMathExpressionNode,
    isValueNode,
    ListNode,
    ValueNode,
} from '../../core/ast/ast';

/**
 * Semantic-token highlighting for `.rules` (`textDocument/semanticTokens/full`).
 *
 * The TextMate grammar (`syntaxes/rules.tmLanguage.json`) stays the synchronous base layer: it
 * colours the moment a file opens and keeps colour when the server is down or no Cosmoteer path is
 * set. These tokens are the overlay the editor paints on top once the AST is parsed. They replace
 * the grammar's regex guesswork (is this word a key, a reference, an enum value, a math function?)
 * with the real parse, which the regex cannot know. The same payload drives VS Code and the native
 * IntelliJ LSP highlighter, so one implementation colours both editors.
 */

// Line splitting for the clamp below, kept out of the loop that uses them.
const LINE_BREAK = /\r?\n/;
const CARRIAGE_RETURN = /\r$/;

/** A single token before delta-encoding, captured so the whole set can be sorted by position first. */
interface RawToken {
    readonly line: number;
    readonly char: number;
    readonly length: number;
    readonly type: number;
    readonly modifiers: number;
}

/**
 * Walks the cached AST and produces the document's semantic tokens. A node's {@link AstPosition} is
 * always single-line (the parser records one line per node), so every token fits the LSP one-line
 * rule without clamping.
 *
 * @param document the parsed document to highlight.
 * @param text the document's source, used to keep a token inside the line it starts on. A value
 * that runs over several lines (a verbatim string, a continued one) carries the whole span in one
 * position, and a token reaching past its line is one the editor cannot place.
 * @returns the delta-encoded tokens for `textDocument/semanticTokens/full`.
 */
export const buildSemanticTokens = (document: AbstractNodeDocument, text?: string): SemanticTokens => {
    const collected: RawToken[] = [];
    for (const element of document.elements) collectNode(element, true, collected);

    const tokens = text === undefined ? collected : clampToLines(collected, text);

    // The builder demands tokens in document order. Node traversal is mostly ordered but a value's
    // sub-tokens (reference, operators) can interleave, so sort defensively before encoding.
    tokens.sort((a, b) => a.line - b.line || a.char - b.char);

    const builder = new SemanticTokensBuilder();
    for (const token of tokens) builder.push(token.line, token.char, token.length, token.type, token.modifiers);
    return builder.build();
};

/**
 * Cut every token back to the line it starts on.
 *
 * A value that runs over several lines, a verbatim string or one the author continued, carries the
 * whole span in a single position, and a token reaching past the end of its line is one the editor
 * cannot place.
 *
 * @param tokens the tokens the walk collected.
 * @param text the document's source.
 * @returns the tokens, each no longer than the rest of its own line.
 */
const clampToLines = (tokens: readonly RawToken[], text: string): RawToken[] => {
    const lineLengths = text.split(LINE_BREAK).map((line) => line.replace(CARRIAGE_RETURN, '').length);
    return tokens.map((token) => {
        const lineLength = lineLengths[token.line];
        if (lineLength === undefined || token.char + token.length <= lineLength) return token;
        return { ...token, length: Math.max(0, lineLength - token.char) };
    });
};

/** Pushes a token for a node's own single-line position span (start→end on its line). */
const pushSpan = (position: AstPosition, type: TokenType, modifiers: number, tokens: RawToken[]): void => {
    const length = position.characterEnd - position.characterStart;
    if (length <= 0) return;
    tokens.push({ line: position.line, char: position.characterStart, length, type: typeIndex(type), modifiers });
};

/** Pushes a token of a fixed length at a node's start (for naming the head of a wider node). */
const pushHead = (
    position: AstPosition,
    length: number,
    type: TokenType,
    modifiers: number,
    tokens: RawToken[]
): void => {
    if (length <= 0) return;
    tokens.push({ line: position.line, char: position.characterStart, length, type: typeIndex(type), modifiers });
};

/**
 * Emits the tokens for one AST node.
 *
 * @param node the node to classify.
 * @param topLevel whether the node is a direct child of the document (a top-level entity declaration).
 * @param tokens the accumulator.
 */
const collectNode = (node: AbstractNode | null | undefined, topLevel: boolean, tokens: RawToken[]): void => {
    if (!node) return;

    if (isGroupNode(node) || isListNode(node)) {
        collectContainer(node, topLevel, tokens);
        return;
    }

    if (isAssignmentNode(node)) {
        // `Key = value` / `Key : value`: the left identifier is a field name. Recurse the value.
        pushSpan(node.left.position, 'property', 0, tokens);
        collectNode(node.right, false, tokens);
        return;
    }

    if (isFunctionCallNode(node)) {
        // The call's position spans the whole `name( … )`. Colour just the name as a built-in function.
        pushHead(node.position, node.name.length, 'function', modifierBit('defaultLibrary'), tokens);
        for (const argument of node.arguments) collectNode(argument, false, tokens);
        return;
    }

    if (isMathExpressionNode(node)) {
        for (const element of node.elements) collectNode(element, false, tokens);
        return;
    }

    if (isExpressionNode(node)) {
        pushSpan(node.position, 'operator', 0, tokens);
        return;
    }

    if (isValueNode(node)) {
        pushSpan(spanOfValue(node), valueTokenType(node), 0, tokens);
        return;
    }
};

/**
 * The span to colour for a value.
 *
 * A parenthesized operand carries the closing `)` in its own span, which the expression code relies
 * on to know where the operand ends. Colouring it would paint the parenthesis as part of the value,
 * so `(&A) * 2` showed `&A)` as one variable and the bracket changed colour as soon as the server
 * answered. The written value is what gets coloured instead.
 *
 * @param node the value node to colour.
 * @returns the span of the value's own text.
 */
const spanOfValue = (node: ValueNode): AstPosition => {
    if (!node.parenthesized) return node.position;
    const written = String(node.valueType.value);
    const length = node.quoted ? written.length + 2 : written.length;
    const characterEnd = node.position.characterStart + length;
    return characterEnd < node.position.characterEnd ? { ...node.position, characterEnd } : node.position;
};

/** Emits tokens for a group/list: its identifier, inheritance bases, then its body. */
const collectContainer = (node: GroupNode | ListNode, topLevel: boolean, tokens: RawToken[]): void => {
    if (node.identifier) {
        // A top-level `Foo { … }` declares an entity (coloured as a defining type); a nested
        // `Texture { … }` / `Float { … }` is a field name keyed by its identifier (a property).
        if (topLevel) {
            pushSpan(node.identifier.position, 'type', modifierBit('declaration'), tokens);
        } else {
            pushSpan(node.identifier.position, 'property', 0, tokens);
        }
    }
    // `Foo : Base`: each inheritance base names another entity.
    for (const base of node.inheritance ?? []) pushSpan(base.position, 'type', 0, tokens);
    for (const element of node.elements) collectNode(element, false, tokens);
};

// A bareword that the parser types `String` but that is really a numeric literal: a percentage
// (`50%`, `-0.6%`), an angle in degrees or radians (`90d`, `1.5r`) or infinity. The parser keeps
// these `String` so the evaluator can resolve them (percent → /100, degrees → radians), but they
// read as numbers, and the TextMate grammar colours them numeric, so the semantic overlay has to
// agree or the colour flips as soon as the server catches up.
const NUMERIC_LITERAL = /^-?(?:\s*\d*\.?\d+\s*[%dr]|infinity)$/i;

/** Maps a value node's parsed kind to its token type. */
const valueTokenType = (node: ValueNode): TokenType => {
    switch (node.valueType.type) {
        case 'Number':
            return 'number';
        case 'Boolean':
            return 'keyword';
        case 'Reference':
            return 'variable';
        case 'Sprite':
        case 'Sound':
        case 'Shader':
            return 'string';
        case 'String':
            // A quoted string is a literal. A bareword numeric literal (`50%`, `Infinity`) colours as
            // a number; any other bareword (`Add`, `Normal`) is an enum-style value.
            if (!node.quoted && NUMERIC_LITERAL.test(String(node.valueType.value))) return 'number';
            return node.quoted ? 'string' : 'enumMember';
    }
};
