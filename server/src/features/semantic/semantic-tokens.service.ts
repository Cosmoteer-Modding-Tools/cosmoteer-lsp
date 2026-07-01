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
 * set. These tokens are the overlay the editor paints on top once the AST is parsed — they replace
 * the grammar's regex guesswork (is this word a key, a reference, an enum value, a math function?)
 * with the real parse, which the regex cannot know. The same payload drives VS Code and the native
 * IntelliJ LSP highlighter, so one implementation colours both editors.
 */

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
 * @returns the delta-encoded tokens for `textDocument/semanticTokens/full`.
 */
export const buildSemanticTokens = (document: AbstractNodeDocument): SemanticTokens => {
    const tokens: RawToken[] = [];
    for (const element of document.elements) collectNode(element, true, tokens);

    // The builder demands tokens in document order. Node traversal is mostly ordered but a value's
    // sub-tokens (reference, operators) can interleave, so sort defensively before encoding.
    tokens.sort((a, b) => a.line - b.line || a.char - b.char);

    const builder = new SemanticTokensBuilder();
    for (const token of tokens) builder.push(token.line, token.char, token.length, token.type, token.modifiers);
    return builder.build();
};

/** Pushes a token for a node's own single-line position span (start→end on its line). */
const pushSpan = (position: AstPosition, type: TokenType, modifiers: number, tokens: RawToken[]): void => {
    const length = position.characterEnd - position.characterStart;
    if (length <= 0) return;
    tokens.push({ line: position.line, char: position.characterStart, length, type: typeIndex(type), modifiers });
};

/** Pushes a token of a fixed length at a node's start (for naming the head of a wider node). */
const pushHead = (position: AstPosition, length: number, type: TokenType, modifiers: number, tokens: RawToken[]): void => {
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
        // `Key = value` / `Key : value` — the left identifier is a field name. Recurse the value.
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
        pushSpan(node.position, valueTokenType(node), 0, tokens);
        return;
    }
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
    // `Foo : Base` — each inheritance base names another entity.
    for (const base of node.inheritance ?? []) pushSpan(base.position, 'type', 0, tokens);
    for (const element of node.elements) collectNode(element, false, tokens);
};

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
            // A quoted string is a literal. A bareword (`Add`, `Normal`) is an enum-style value.
            return node.quoted ? 'string' : 'enumMember';
    }
};
