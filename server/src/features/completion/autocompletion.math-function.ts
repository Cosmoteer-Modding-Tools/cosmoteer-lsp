import { CancellationToken, CompletionItemKind } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    ValueNode,
    isAssignmentNode,
    isDocumentNode,
    isFunctionCallNode,
    isGroupNode,
    isListNode,
    isMathExpressionNode,
    isValueNode,
} from '../../core/ast/ast';
import { CONSTANTS, MATH_FUNCTIONS } from '../../semantics/math-function-registry';
import { activeCallAt, paramsOf } from '../signature/signature-help.service';
import { AutoCompletion, Completion, CompletionSuggestion } from './autocompletion.service';
import { fieldOfValueNode } from './autocompletion.schema';
import { findEnclosingGroup, resolveGroupClass } from '../../document/schema/schema-context';
import { documentRootClass } from '../../document/schema/document-root';
import { fieldOf } from '../../document/schema/schema';
import { ValueType } from '../../document/schema/schema.types';
import { resolveClassThroughInheritance } from './inheritance-resolution';

/**
 * Builds the completion items for every math function the registry knows, plus the bare constants
 * (`pi`, `e`). A function inserts as a `name($0)` snippet so the cursor lands between the
 * parentheses, its detail is the same signature that signature help renders. Curated entries (the
 * ones with documentation) sort above the plain mXparser vocabulary, which is large and obscure.
 *
 * @returns the full, position-independent item list (built once, the registry is static).
 */
const buildItems = (): CompletionSuggestion[] => {
    const items: CompletionSuggestion[] = Object.entries(MATH_FUNCTIONS).map(([name, spec]) => ({
        label: name,
        kind: CompletionItemKind.Function,
        detail: `${name}(${paramsOf(spec).join(', ')})`,
        documentation: spec.doc,
        insertText: `${name}($0)`,
        isSnippet: true,
        sortText: `${spec.doc ? '0' : '1'}_${name}`,
    }));
    for (const [name, value] of Object.entries(CONSTANTS)) {
        items.push({
            label: name,
            kind: CompletionItemKind.Constant,
            detail: `${name} ≈ ${value.toFixed(5)}`,
            sortText: `0_${name}`,
        });
    }
    return items;
};

let cachedItems: CompletionSuggestion[] | undefined;
const mathItems = (): CompletionSuggestion[] => (cachedItems ??= buildItems());

/**
 * Whether `node` sits inside `root` when `root` is a math expression or function call. The parser
 * links an operand's `parent` to the enclosing group rather than the expression, so containment is
 * established by walking the expression tree down from the assignment's right-hand side.
 *
 * @param root the candidate expression tree.
 * @param node the value node under the cursor.
 * @returns true when `node` is an operand or argument anywhere inside `root`.
 */
const expressionContains = (root: AbstractNode, node: AbstractNode): boolean => {
    if (root === node) return true;
    if (isMathExpressionNode(root)) return root.elements.some((element) => expressionContains(element, node));
    if (isFunctionCallNode(root)) return root.arguments.some((argument) => expressionContains(argument, node));
    return false;
};

/** The result of finding the expression that holds the cursor: the field it is assigned to, if any. */
interface ExpressionContext {
    /** The assignment's field name, undefined for a loose expression element (e.g. inside a list). */
    fieldName?: string;
}

/**
 * Finds the math expression or function call among the container's elements that holds `node`,
 * together with the field name it is assigned to.
 *
 * @param container the node's parent, which holds the assignments and loose elements to scan.
 * @param node the value node under the cursor.
 * @returns the expression context, or undefined when the value is not part of an expression.
 */
const enclosingExpression = (
    container: { elements: AbstractNode[] },
    node: AbstractNode
): ExpressionContext | undefined => {
    for (const element of container.elements) {
        const root = isAssignmentNode(element) ? element.right : element;
        if ((isMathExpressionNode(root) || isFunctionCallNode(root)) && expressionContains(root, node)) {
            return { fieldName: isAssignmentNode(element) ? element.left.name : undefined };
        }
    }
    return undefined;
};

/**
 * Whether a schema value type can hold a computed number, so a math function makes sense in it.
 * On any other resolved type (string, enum, bool, reference, ...) the game reads the call text
 * literally, so offering function names there would only invite a broken file.
 *
 * @param valueType the resolved schema type of the field being assigned.
 * @returns true for the numeric kinds.
 */
const allowsMath = (valueType: ValueType): boolean => valueType.kind === 'number' || valueType.kind === 'int';

/**
 * Resolves the schema type of `fieldName` in `container` (a group's class through inheritance, or
 * the whole-file root class at document level).
 *
 * @param container the group or document holding the assignment.
 * @param fieldName the field being assigned.
 * @param cancellationToken cancellation for the inheritance walk.
 * @returns the field's value type, or undefined when the container's class is unknown.
 */
const fieldTypeIn = async (
    container: AbstractNode | { elements: AbstractNode[] },
    fieldName: string,
    cancellationToken: CancellationToken
): Promise<ValueType | undefined> => {
    const asNode = container as AbstractNode;
    if (isDocumentNode(asNode)) {
        const cls = documentRootClass(asNode);
        return cls ? fieldOf(cls, fieldName)?.valueType : undefined;
    }
    if (isGroupNode(asNode)) {
        const cls = await resolveClassThroughInheritance(asNode, cancellationToken);
        return cls ? fieldOf(cls, fieldName)?.valueType : undefined;
    }
    return undefined;
};

/** A bare partial identifier, the only value shape that can be the start of a function name. */
const PARTIAL_IDENTIFIER = /^[A-Za-z_]\w*$/;

/**
 * Math-function name completion. While a partial name is typed it lexes as an unquoted String
 * value node, so this completer offers the registry's function names (and `pi`/`e`) when that node
 * is in a context where a function call is legal:
 *  - an operand of a math expression (`X = 2 * sq`) or an argument of a call (`X = ceil(2 + sq)`),
 *    as long as the field is not resolvable to a non-numeric schema type,
 *  - a whole value on a schema field typed numeric (`Damage = sq`), where a formula may be starting.
 * A quoted string, a reference, an inheritance base and any field the schema types as string,
 * enum, bool or reference never take a function, so they stay silent.
 */
export class AutoCompletionMathFunction implements AutoCompletion<ValueNode> {
    public async getCompletions(node: ValueNode, cancellationToken: CancellationToken): Promise<Completion[]> {
        if (!isValueNode(node) || node.quoted) return [];
        if (node.valueType.type !== 'String') return [];
        const written = String(node.valueType.value);
        if (!PARTIAL_IDENTIFIER.test(written)) return [];
        const container = node.parent;
        if (!container || !('elements' in container)) return [];
        // The value after a `:` is an inheritance base, a reference by definition.
        if ((isGroupNode(container) || isListNode(container)) && container.inheritance?.includes(node)) return [];
        const expression = enclosingExpression(container as { elements: AbstractNode[] }, node);
        if (expression) {
            // Inside an expression a function is legal unless the schema says the field cannot
            // hold a number at all. An unresolvable field (unrooted fragment, unknown class)
            // stays permissive: the written math syntax is itself strong evidence of intent.
            if (!expression.fieldName) return mathItems();
            const fieldType = await fieldTypeIn(container, expression.fieldName, cancellationToken);
            return fieldType === undefined || allowsMath(fieldType) ? mathItems() : [];
        }
        const fieldType = (await fieldOfValueNode(node, cancellationToken))?.valueType;
        return fieldType !== undefined && allowsMath(fieldType) ? mathItems() : [];
    }
}

/**
 * Offset-based fallback for the mid-edit states where the AST has no leaf under the cursor, most
 * commonly an unclosed call (`Damage = ceil(sq`). Reuses signature help's raw-text scan: when the
 * cursor sits inside a named function call, a function name is legal, so the same items are
 * offered, with the same schema gate as the node path (nothing on a field resolved non-numeric).
 * The scan is confined to the current line because a value expression never spans lines, while an
 * unclosed `(` would otherwise leak the call context into the lines below it.
 *
 * @param document the parsed document, used to resolve the field's schema type.
 * @param offset the cursor byte offset, used to find the enclosing group.
 * @param linePrefix the current line's text from its start to the cursor.
 * @returns the math items when the cursor is inside a function call, otherwise nothing.
 */
export const mathFunctionCompletionsAtLinePrefix = (
    document: AbstractNodeDocument,
    offset: number,
    linePrefix: string
): Completion[] => {
    // Nothing inside a line comment: only the code before a `//` counts as call context.
    const code = linePrefix.split('//')[0];
    if (!activeCallAt(code, code.length)) return [];
    // The field the call is being written into is the last `Name =` before the cursor. Class
    // resolution is the sync variant here (no inheritance walk): a wrongly-permissive edge case
    // mid-keystroke is preferable to an async chain in the fallback path.
    const fieldName = /([A-Za-z_]\w*)\s*=\s*[^=]*$/.exec(code)?.[1];
    if (!fieldName) return mathItems();
    const group = findEnclosingGroup(document, offset);
    const cls = group ? resolveGroupClass(group) : documentRootClass(document);
    const fieldType = cls ? fieldOf(cls, fieldName)?.valueType : undefined;
    return fieldType === undefined || allowsMath(fieldType) ? mathItems() : [];
};
