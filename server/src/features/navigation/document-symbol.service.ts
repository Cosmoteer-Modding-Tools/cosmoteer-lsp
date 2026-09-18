import { DocumentSymbol, Range, SymbolKind } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    ListNode,
    AstPosition,
    isListNode,
    isAssignmentNode,
    isFunctionCallNode,
    isMathExpressionNode,
    isGroupNode,
    isValueNode,
    GroupNode,
    ValueNode,
} from '../../core/ast/ast';
import { resolveGroupClass } from '../../document/schema/schema-context';
import { enclosingRange, orderRange, unionRange } from './ast-range';

/**
 * The symbol kind a plain value is outlined as, by what it spells.
 *
 * @param node the value node.
 * @returns the kind, a field for a value kind the outline has no closer match for.
 */
export const valueSymbolKind = (node: ValueNode): SymbolKind => {
    switch (node.valueType.type) {
        case 'String':
            return SymbolKind.String;
        case 'Number':
            return SymbolKind.Number;
        case 'Boolean':
            return SymbolKind.Boolean;
        case 'Reference':
            return SymbolKind.Variable;
        case 'Sprite':
        case 'Sound':
        case 'Shader':
            return SymbolKind.File;
        default:
            return SymbolKind.Field;
    }
};

/** An group/list and the assignment that introduces it, if any. */
type Container = GroupNode | ListNode;

const posToRange = (position: AstPosition): Range =>
    Range.create(position.line, position.characterStart, position.line, position.characterEnd);

/**
 * Builds the hierarchical document outline (`textDocument/documentSymbol`).
 *
 * Walks the cached AST and emits a {@link DocumentSymbol} tree mirroring the
 * `Group`/`List`/`key = value` nesting. This drives the breadcrumb bar and the
 * Outline view for the deeply nested `Part`/`Components`/… trees these files grow
 * into. Needs no cross-file resolution: it's a pure structural projection of one
 * document, which is why it's the cheapest navigation primitive to ship.
 */
export const getDocumentSymbols = (document: AbstractNodeDocument): DocumentSymbol[] => {
    return symbolsFromElements(document.elements).map(normalizeSymbol);
};

const symbolsFromElements = (elements: AbstractNode[]): DocumentSymbol[] => {
    const symbols: DocumentSymbol[] = [];
    elements.forEach((element, index) => {
        const symbol = symbolFromElement(element, index);
        if (symbol) symbols.push(symbol);
    });
    return symbols;
};

const symbolFromElement = (element: AbstractNode, index: number): DocumentSymbol | null => {
    // `key = value` / `key : value` name it by the left identifier. When the value
    // is itself a container, fold the two into one outline node (`Key { … }`) instead
    // of nesting an anonymous group under the assignment.
    if (isAssignmentNode(element)) {
        const name = element.left.name;
        const right = element.right;
        if (isGroupNode(right) || isListNode(right)) {
            return containerSymbol(name, posToRange(element.left.position), element, right);
        }
        return {
            name,
            detail: detailOf(right),
            kind: kindOfValue(right),
            range: enclosingRange(element),
            selectionRange: posToRange(element.left.position),
        };
    }
    // An identified `Foo { … }` / `Bar [ … ]`, or an anonymous container/value that is
    // a positional list element (e.g. the entries of a `Components` list).
    if (isGroupNode(element) || isListNode(element)) {
        const name = element.identifier?.name ?? `[${index}]`;
        const nameRange = posToRange((element.identifier ?? element).position);
        return containerSymbol(name, nameRange, element, element);
    }
    // A math run folded into one node is a positional element like any other, so it is outlined
    // by its index. Without this a list of computed values shows no children at all.
    if (isValueNode(element) || isMathExpressionNode(element)) {
        return {
            name: `[${index}]`,
            detail: detailOf(element),
            kind: kindOfValue(element),
            range: isMathExpressionNode(element) ? enclosingRange(element) : posToRange(element.position),
            selectionRange: isMathExpressionNode(element) ? enclosingRange(element) : posToRange(element.position),
        };
    }
    return null;
};

const containerSymbol = (
    name: string,
    selectionRange: Range,
    outer: AbstractNode,
    content: Container
): DocumentSymbol => {
    return {
        name,
        detail: containerDetail(content),
        kind: isListNode(content) ? SymbolKind.Array : SymbolKind.Object,
        range: enclosingRange(outer),
        selectionRange,
        children: symbolsFromElements(content.elements),
    };
};

/**
 * Outline detail for a container: what it extends (`: Base`) and/or the schema class it resolves
 * to (`TurretWeaponRules`), so the deeply nested `Part`/`Components` tree reads as typed nodes.
 * Both, one, or neither: `Turret { Type=TurretWeapon }` → `TurretWeaponRules`. `X : Base` → `: Base`.
 */
const containerDetail = (content: Container): string | undefined => {
    const inheritance = inheritanceDetail(content);
    const cls = isGroupNode(content) ? resolveGroupClass(content) : undefined;
    const className = cls?.split('.').pop();
    if (inheritance && className) return `${inheritance} · ${className}`;
    return className ?? inheritance;
};

/** Surface what a container extends (`: Base`) as the outline detail. */
const inheritanceDetail = (node: Container): string | undefined => {
    if (!node.inheritance?.length) return undefined;
    // Inheritance values are stored with their `&` sigil (`&Base`); drop it for a
    // cleaner outline detail (`: Base`).
    return ': ' + node.inheritance.map((ref) => String(ref.valueType.value).replace(/^&/, '')).join(', ');
};

const kindOfValue = (node: AbstractNode | null): SymbolKind => {
    if (!node) return SymbolKind.Field;
    if (isFunctionCallNode(node)) return SymbolKind.Function;
    if (isMathExpressionNode(node)) return SymbolKind.Number;
    if (isValueNode(node)) return valueSymbolKind(node);
    return SymbolKind.Field;
};

const detailOf = (node: AbstractNode | null): string | undefined => {
    if (!node) return undefined;
    if (isValueNode(node)) return String((node as ValueNode).valueType.value);
    if (isFunctionCallNode(node)) return `${node.name}(…)`;
    return undefined;
};

/**
 * Guarantee the LSP invariant that a symbol's `range` encloses its `selectionRange` and every child
 * range. Our `range` is derived from a node's descendant positions, but the particle/effect files
 * carry bare keys and empty values whose positions are missing or degenerate, so the envelope can
 * fall short of the name range, which makes the client reject the whole outline. Ordering each
 * range (malformed input can leave a reversed selectionRange) and then expanding `range` to the
 * union (depth-first, children first) keeps it valid without losing any node.
 */
const normalizeSymbol = (symbol: DocumentSymbol): DocumentSymbol => {
    symbol.children = symbol.children?.map(normalizeSymbol);
    symbol.selectionRange = orderRange(symbol.selectionRange);
    let range = unionRange(orderRange(symbol.range), symbol.selectionRange);
    for (const child of symbol.children ?? []) range = unionRange(range, child.range);
    symbol.range = range;
    return symbol;
};
