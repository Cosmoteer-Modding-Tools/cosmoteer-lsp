import { CancellationToken, Position } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    isListNode,
    isAssignmentNode,
    isDocumentNode,
    isFunctionCallNode,
    isGroupNode,
    isIdentifierNode,
    isMathExpressionNode,
} from '../core/ast/ast';
import { FileWithPath } from '../workspace/cosmoteer-workspace.service';
import { readFile } from 'fs/promises';
import { lexer } from '../core/lexer/lexer';
import { parser } from '../core/parser/parser';
import { CancellationError } from './cancellation';

/**
 * The named members of a group/list/document: each `key = value` assignment
 * (name -> its right-hand value), each identified `{}`/`[]` (identifier -> itself), and each
 * bare valueless field (`ScaleIn` on its own line, a legal ObjectText member the game reads as
 * present with an empty value, which the parser leaves as a lone identifier). Bare words inside a
 * list are values, not identifiers, so list elements are unaffected. The single definition of
 * "named member" shared by the action parser, mod-context, and completion.
 * @param node the group, list, or document whose elements are scanned
 * @returns the name/node pairs for each named member, in document order
 */
export const namedMembersOf = (node: { elements: AbstractNode[] }): [string, AbstractNode][] => {
    const members: [string, AbstractNode][] = [];
    for (const element of node.elements) {
        // An in-progress empty assignment (`Type = ` with no value yet) counts like a bare valueless
        // field: the name is present, and its identifier stands in as the member node.
        if (isAssignmentNode(element)) members.push([element.left.name, element.right ?? element.left]);
        else if ((isGroupNode(element) || isListNode(element)) && element.identifier)
            members.push([element.identifier.name, element]);
        else if (isIdentifierNode(element)) members.push([element.name, element]);
    }
    return members;
};

/**
 * The nodes a whole-document walk descends into: a container's elements, an assignment's value.
 * The single definition of "child" the diagnostic and schema passes walk documents by. Inheritance
 * lists, function-call arguments and math operands are deliberately left out of it.
 * @param node the node a walk has reached
 * @returns the nodes to visit below it, in document order, empty when it holds none
 */
export const childNodesOf = (node: AbstractNode): AbstractNode[] =>
    isGroupNode(node) || isListNode(node) || isDocumentNode(node)
        ? node.elements
        : isAssignmentNode(node) && node.right
          ? [node.right]
          : [];

/** Per-container lookup table from an assignment's right-hand node to its field name. Built once per
 *  container instead of rescanning its elements for every candidate node, which made a string-heavy
 *  group quadratic. Keyed weakly so a table dies with its AST. */
const namesByRight: WeakMap<object, Map<unknown, string>> = new WeakMap();

/**
 * The field name whose `Key = value` right-hand side is `node`, read from the enclosing group or
 * document. Every pass that names a value node by the field it was written for reads it from here,
 * so they share one table per container.
 *
 * @param node the node to name.
 * @returns the assignment's field name, or undefined when `node` is not an assignment value.
 */
export const assignmentNameOf = (node: AbstractNode): string | undefined => {
    const parent = node.parent;
    if (!parent || !(isGroupNode(parent) || isDocumentNode(parent))) return undefined;
    return assignmentKeyIn(node, parent);
};

/**
 * The same lookup as {@link assignmentNameOf}, against a container the caller names itself. A walk
 * that also descends lists shares the table this way, since it decides which container kinds count
 * rather than inheriting the group and document guard.
 *
 * @param node the node to name.
 * @param container the group, list, or document whose assignments are searched.
 * @returns the assignment's field name, or undefined when `node` is not an assignment value.
 */
export const assignmentKeyIn = (node: AbstractNode, container: { elements: AbstractNode[] }): string | undefined => {
    let table = namesByRight.get(container);
    if (!table) {
        table = new Map();
        for (const element of container.elements) {
            if (isAssignmentNode(element)) table.set(element.right, element.left.name);
        }
        namesByRight.set(container, table);
    }
    return table.get(node);
};

/**
 * The member name a node belongs to, resolved from the container holding it. A hover or a lookup
 * lands on a value, on a key, or on the container a group- or list-form member is written as, and
 * all three answer for the same member.
 *
 * @param node the node to name.
 * @param container the group, list, or document holding it.
 * @returns the member name, or undefined when the node is not a named member of the container.
 */
export const memberNameAt = (node: AbstractNode, container: { elements: AbstractNode[] }): string | undefined => {
    // A group- or list-form member (`_centerColor { … }`, `TypeCategories [ … ]`, or an overriding
    // `TypeCategories : ^/0/TypeCategories [ … ]`) is written without an `=`, so its key resolves to
    // the container node itself and carries its name on its identifier. A valueless field written as
    // a bare key (`Scale2In` with no `= value`, common for optional particle-channel bindings) parses
    // to a standalone identifier. Neither has a sibling assignment to match.
    if ((isGroupNode(node) || isListNode(node)) && node.identifier) return node.identifier.name;
    if (isIdentifierNode(node)) return node.name;
    for (const element of container.elements) {
        if (isAssignmentNode(element) && (element.right === node || element.left === node)) return element.left.name;
    }
    return undefined;
};

export const parseFile = async (file: FileWithPath): Promise<AbstractNodeDocument> => {
    const data = await readFile(file.path, { encoding: 'utf-8' });
    const document = parser(lexer(data), file.path).value;
    return document;
};

export const parseFilePath = async (path: string, cancellationToken?: CancellationToken) => {
    const data = await readFile(path, { encoding: 'utf-8' });
    if (cancellationToken?.isCancellationRequested) throw new CancellationError();
    return parseText(data, path);
};

/** Parse already-read source text into a document (avoids re-reading when the text is in hand). */
export const parseText = (text: string, path: string): AbstractNodeDocument => parser(lexer(text), path).value;

export const findNodeAtPosition = (document: AbstractNodeDocument, position: Position) => {
    for (const node of document.elements) {
        const foundNode = findNodeAtPositionRecursive(node, position);
        if (foundNode) {
            return foundNode;
        }
    }
};

const findNodeAtPositionRecursive = (node: AbstractNode, position: Position): AbstractNode | undefined => {
    if (isGroupNode(node) || isListNode(node)) {
        // Inheritance is checked before (and independently of) the members: an empty inheriting
        // group (`Components : ^/0/Components { }`) has no elements, so a check nested in the
        // member loop would never see the cursor on the inheritance reference.
        for (const inheritance of node.inheritance ?? []) {
            const foundNode = findNodeAtPositionRecursive(inheritance, position);
            if (foundNode) {
                return foundNode;
            }
        }
        for (const element of node.elements) {
            const foundNode = findNodeAtPositionRecursive(element, position);
            if (foundNode) {
                return foundNode;
            }
        }
    } else if (isMathExpressionNode(node)) {
        // A math expression (`(&A) * (&B)`) flattens its operands into `elements`. Descend so the
        // cursor lands on the specific embedded value (e.g. a `&`-reference inside the math), the
        // same way the hover/reference finder does, instead of stopping at the whole expression.
        for (const element of node.elements) {
            const foundNode = findNodeAtPositionRecursive(element, position);
            if (foundNode) {
                return foundNode;
            }
        }
    } else if (isFunctionCallNode(node)) {
        // A function call (`ceil((&A) / 2)`) carries its operands in `arguments`. Descend likewise so
        // the cursor lands on an embedded reference argument rather than the call as a whole.
        for (const argument of node.arguments) {
            const foundNode = findNodeAtPositionRecursive(argument, position);
            if (foundNode) {
                return foundNode;
            }
        }
    } else if (isAssignmentNode(node)) {
        // A container/expression value: descend so the cursor lands on the specific inner element (a
        // list-element reference `Field = [ ref ]`, or a `&`-reference embedded in a math expression
        // `Field = (&A) * (&B)`), not the whole value. Falls back to the value below when the cursor
        // is in its span but on no deeper node.
        if (
            node.right &&
            (isListNode(node.right) ||
                isGroupNode(node.right) ||
                isMathExpressionNode(node.right) ||
                isFunctionCallNode(node.right))
        ) {
            const foundNode = findNodeAtPositionRecursive(node.right, position);
            if (foundNode) {
                return foundNode;
            }
        }
        if (
            node.right?.position &&
            position.line === node.right.position.line &&
            position.character <= node.right.position.characterEnd &&
            position.character >= node.right.position.characterStart
        ) {
            return node.right;
        }
    } else {
        if (
            node.position &&
            position.line === node.position.line &&
            position.character <= node.position.characterEnd &&
            position.character >= node.position.characterStart
        ) {
            return node;
        }
    }
    return undefined;
};

/**
 * A named child of a group/document/list, by member name or list index. Like the game's node
 * lookup (and {@link stepIntoNode}) the name matches case-insensitively, with an exact-case match
 * preferred so two members differing only by case still resolve precisely.
 */
export const findNodeByIdentifier = (node: AbstractNode, identifier: string): AbstractNode | undefined => {
    if (!isGroupNode(node) && !isDocumentNode(node) && !isListNode(node)) return undefined;
    const lower = identifier.toLowerCase();
    let caseInsensitiveMatch: AbstractNode | undefined;
    for (const [i, element] of node.elements.entries()) {
        const name =
            (isListNode(element) || isGroupNode(element)) && element.identifier
                ? element.identifier.name
                : isAssignmentNode(element)
                  ? element.left.name
                  : undefined;
        if (name === identifier) return element;
        if (isListNode(node) && i.toString() === identifier) return element;
        if (!caseInsensitiveMatch && name?.toLowerCase() === lower) caseInsensitiveMatch = element;
    }
    return caseInsensitiveMatch;
};

/**
 * The document a node belongs to, by walking its parent chain. Unlike `getStartOfAstNode`, a node
 * from a detached subtree whose chain never reaches a document yields undefined instead of a
 * mis-cast top node, so callers can tell a rooted node from a loose one.
 *
 * @param node the node whose owning document is wanted.
 * @returns the owning document, or undefined when the chain reaches no document.
 */
export const documentRootOf = (node: AbstractNode): AbstractNodeDocument | undefined => {
    let current: AbstractNode | undefined = node;
    while (current && !isDocumentNode(current)) current = current.parent;
    return current && isDocumentNode(current) ? current : undefined;
};

/** Memo of each node's owning document. Resolution calls this on essentially every step, and the
 *  parent walk is O(depth) per call, so the walk is path-compressed: every node visited on the way
 *  up is cached. Keyed weakly, entries die with their AST. */
const documentOfNode: WeakMap<AbstractNode, AbstractNodeDocument> = new WeakMap();

/**
 * The document root a node belongs to, following `parent` links with path compression.
 *
 * @param node the node whose owning document is wanted.
 * @returns the owning document root.
 */
export const getStartOfAstNode = (node: AbstractNode): AbstractNodeDocument => {
    let current: AbstractNode = node;
    const path: AbstractNode[] = [];
    let root: AbstractNodeDocument | undefined;
    while (current.parent) {
        const cached = documentOfNode.get(current);
        if (cached) {
            root = cached;
            break;
        }
        path.push(current);
        current = current.parent;
    }
    root ??= current as AbstractNodeDocument;
    for (const visited of path) documentOfNode.set(visited, root);
    return root;
};
