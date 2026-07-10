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

/** An group/list and the assignment that introduces it, if any. */
type Container = GroupNode | ListNode;

const posToRange = (position: AstPosition): Range =>
    Range.create(position.line, position.characterStart, position.line, position.characterEnd);

/**
 * Builds the hierarchical document outline (`textDocument/documentSymbol`).
 *
 * Walks the cached AST and emits a {@link DocumentSymbol} tree mirroring the
 * `Group`/`List`/`key = value` nesting — this drives the breadcrumb bar and the
 * Outline view for the deeply nested `Part`/`Components`/… trees these files grow
 * into. Needs no cross-file resolution: it's a pure structural projection of one
 * document, which is why it's the cheapest navigation primitive to ship.
 */
export class DocumentSymbolService {
    private static _instance: DocumentSymbolService;
    private constructor() {}

    public static get instance(): DocumentSymbolService {
        if (!DocumentSymbolService._instance) {
            DocumentSymbolService._instance = new DocumentSymbolService();
        }
        return DocumentSymbolService._instance;
    }

    public getDocumentSymbols(document: AbstractNodeDocument): DocumentSymbol[] {
        return this.symbolsFromElements(document.elements).map(normalizeSymbol);
    }

    private symbolsFromElements(elements: AbstractNode[]): DocumentSymbol[] {
        const symbols: DocumentSymbol[] = [];
        elements.forEach((element, index) => {
            const symbol = this.symbolFromElement(element, index);
            if (symbol) symbols.push(symbol);
        });
        return symbols;
    }

    private symbolFromElement(element: AbstractNode, index: number): DocumentSymbol | null {
        // `key = value` / `key : value` name it by the left identifier. When the value
        // is itself a container, fold the two into one outline node (`Key { … }`) instead
        // of nesting an anonymous group under the assignment.
        if (isAssignmentNode(element)) {
            const name = element.left.name;
            const right = element.right;
            if (isGroupNode(right) || isListNode(right)) {
                return this.containerSymbol(name, posToRange(element.left.position), element, right);
            }
            return {
                name,
                detail: this.detailOf(right),
                kind: this.kindOfValue(right),
                range: enclosingRange(element),
                selectionRange: posToRange(element.left.position),
            };
        }
        // An identified `Foo { … }` / `Bar [ … ]`, or an anonymous container/value that is
        // a positional list element (e.g. the entries of a `Components` list).
        if (isGroupNode(element) || isListNode(element)) {
            const name = element.identifier?.name ?? `[${index}]`;
            const nameRange = posToRange((element.identifier ?? element).position);
            return this.containerSymbol(name, nameRange, element, element);
        }
        if (isValueNode(element)) {
            return {
                name: `[${index}]`,
                detail: this.detailOf(element),
                kind: this.kindOfValue(element),
                range: posToRange(element.position),
                selectionRange: posToRange(element.position),
            };
        }
        return null;
    }

    private containerSymbol(
        name: string,
        selectionRange: Range,
        outer: AbstractNode,
        content: Container
    ): DocumentSymbol {
        return {
            name,
            detail: this.containerDetail(content),
            kind: isListNode(content) ? SymbolKind.Array : SymbolKind.Object,
            range: enclosingRange(outer),
            selectionRange,
            children: this.symbolsFromElements(content.elements),
        };
    }

    /**
     * Outline detail for a container: what it extends (`: Base`) and/or the schema class it resolves
     * to (`TurretWeaponRules`), so the deeply nested `Part`/`Components` tree reads as typed nodes.
     * Both, one, or neither — `Turret { Type=TurretWeapon }` → `TurretWeaponRules`; `X : Base` → `: Base`.
     */
    private containerDetail(content: Container): string | undefined {
        const inheritance = this.inheritanceDetail(content);
        const cls = isGroupNode(content) ? resolveGroupClass(content) : undefined;
        const className = cls?.split('.').pop();
        if (inheritance && className) return `${inheritance} · ${className}`;
        return className ?? inheritance;
    }

    /** Surface what a container extends (`: Base`) as the outline detail. */
    private inheritanceDetail(node: Container): string | undefined {
        if (!node.inheritance?.length) return undefined;
        // Inheritance values are stored with their `&` sigil (`&Base`); drop it for a
        // cleaner outline detail (`: Base`).
        return ': ' + node.inheritance.map((ref) => String(ref.valueType.value).replace(/^&/, '')).join(', ');
    }

    private kindOfValue(node: AbstractNode | null): SymbolKind {
        if (!node) return SymbolKind.Field;
        if (isFunctionCallNode(node)) return SymbolKind.Function;
        if (isMathExpressionNode(node)) return SymbolKind.Number;
        if (isValueNode(node)) {
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
            }
        }
        return SymbolKind.Field;
    }

    private detailOf(node: AbstractNode | null): string | undefined {
        if (!node) return undefined;
        if (isValueNode(node)) return String((node as ValueNode).valueType.value);
        if (isFunctionCallNode(node)) return `${node.name}(…)`;
        return undefined;
    }
}

/** True when `position` (line, character) is at or before `other`. */
const atOrBefore = (line: number, char: number, oLine: number, oChar: number): boolean =>
    line < oLine || (line === oLine && char <= oChar);

/**
 * Return `range` with `start`/`end` swapped if they are inverted. A single AST
 * {@link AstPosition} can carry `characterEnd < characterStart` when the parser recovers from
 * malformed input (an unclosed `[` leaves the node's end column at its `0` default), which
 * produces a reversed one-line range. {@link unionRange} keys off the stored `start`/`end`, so
 * a reversed input would let the true leftmost/rightmost column escape the union. Ordering
 * first keeps the union honest.
 */
const orderRange = (range: Range): Range =>
    atOrBefore(range.start.line, range.start.character, range.end.line, range.end.character)
        ? range
        : { start: range.end, end: range.start };

/** The smallest range covering both inputs. Assumes each input is ordered ({@link orderRange}). */
const unionRange = (a: Range, b: Range): Range => ({
    start: atOrBefore(a.start.line, a.start.character, b.start.line, b.start.character) ? a.start : b.start,
    end: atOrBefore(a.end.line, a.end.character, b.end.line, b.end.character) ? b.end : a.end,
});

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

/**
 * The full span of a node, computed from the min start / max end of every descendant
 * position. {@link AstPosition} only records a single line per node, so a container's
 * own position doesn't cover its body, but the LSP requires a symbol's `range` to
 * enclose its `selectionRange` and ideally its children, so we derive the envelope.
 */
const enclosingRange = (node: AbstractNode): Range => {
    let startLine = Infinity;
    let startChar = Infinity;
    let endLine = -Infinity;
    let endChar = -Infinity;
    const consider = (position: AstPosition) => {
        if (position.line < startLine || (position.line === startLine && position.characterStart < startChar)) {
            startLine = position.line;
            startChar = position.characterStart;
        }
        if (position.line > endLine || (position.line === endLine && position.characterEnd > endChar)) {
            endLine = position.line;
            endChar = position.characterEnd;
        }
    };
    walkPositions(node, consider);
    // No descendant carried a position (shouldn't happen for a real node) — degenerate range.
    if (startLine === Infinity) return Range.create(0, 0, 0, 0);
    return Range.create(startLine, startChar, endLine, endChar);
};

/**
 * Visit the position of `node` and every descendant, across all node shapes. Some
 * structural nodes (e.g. `Assignment`) carry no own `position`, so each visit is guarded.
 */
const walkPositions = (node: AbstractNode | null | undefined, visit: (position: AstPosition) => void): void => {
    if (!node) return; // a bare key (`EmitPerOneShot`) parses to an assignment with no right value
    if (node.position) visit(node.position);
    if (isGroupNode(node) || isListNode(node)) {
        if (node.identifier) visit(node.identifier.position);
        node.inheritance?.forEach((ref) => walkPositions(ref, visit));
        node.elements.forEach((child) => walkPositions(child, visit));
    } else if (isAssignmentNode(node)) {
        visit(node.left.position);
        walkPositions(node.right, visit);
    } else if (isFunctionCallNode(node)) {
        node.arguments.forEach((argument) => walkPositions(argument, visit));
    } else if (isMathExpressionNode(node)) {
        node.elements.forEach((child) => walkPositions(child, visit));
    }
};
