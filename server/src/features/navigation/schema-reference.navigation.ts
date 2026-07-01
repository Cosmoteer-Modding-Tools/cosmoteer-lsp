import { Range } from 'vscode-languageserver';
import {
    AbstractNode,
    isAssignmentNode,
    isDocumentNode,
    isGroupNode,
    isListNode,
    isValueNode,
    ValueNode,
} from '../../core/ast/ast';
import { classOfGroup, registryForContainer } from '../../document/schema/schema-context';
import { fieldOf, registryOf } from '../../document/schema/schema';

/**
 * Resolve a schema-driven `ID<…>` sibling reference to its definition node.
 *
 * Cosmoteer's `ID<X>` fields (e.g. `OperationalToggle = IsOperational`, `AutoFireToggle = …`) name a
 * sibling component in the same container by its plain identifier — they are not `&`-prefixed
 * references, so go-to-definition's reference path skips them. The schema's value oracle knows the
 * field is a reference whose target registry is the one the container holds, so the value text is the
 * id of a sibling group. This mirrors the sibling-reference completion in `autocompletion.schema.ts`,
 * but resolves a written id to the concrete sibling instead of listing candidates.
 *
 * Returns the sibling group node, or `undefined` when the value isn't such a reference / no sibling
 * matches (callers then fall through to other navigation strategies).
 */
export const resolveSchemaSiblingReference = (node: AbstractNode | null | undefined): AbstractNode | undefined => {
    if (!node || !isValueNode(node) || node.valueType.type !== 'String') return undefined;

    const group = node.parent;
    if (!group || !isGroupNode(group)) return undefined;

    // The field name is the sibling assignment whose right-hand value is this node (the parser links
    // a value's `parent` to the enclosing group, not its assignment).
    let fieldName: string | undefined;
    for (const element of group.elements) {
        if (isAssignmentNode(element) && element.right === node) {
            fieldName = element.left.name;
            break;
        }
    }
    if (!fieldName) return undefined;

    const container = group.parent;
    if (!container || !isGroupNode(container)) return undefined;
    const registry = registryForContainer(container);
    if (!registry) return undefined;

    const cls = classOfGroup(group, registry.name);
    const field = cls ? fieldOf(cls, fieldName) : undefined;
    if (!field || field.valueType.kind !== 'reference' || registryOf(field.valueType.target) !== registry) {
        return undefined;
    }

    // The value text is a sibling component's identifier — find that group in the same container.
    const targetName = String((node as ValueNode).valueType.value);
    return container.elements.find(
        (element) => (isGroupNode(element) || isListNode(element)) && element.identifier?.name === targetName
    );
};

/** The document range covering a bare-string value node's whole text (a single-segment id). */
export const valueTextRange = (node: ValueNode): Range => {
    const { line, characterStart, characterEnd } = node.position;
    return Range.create(line, characterStart, line, characterEnd);
};

/**
 * Every bare-string value node in a document — the candidate sites for a schema `ID<>` sibling
 * reference. Callers pre-filter by text (cheap) then confirm with {@link resolveSchemaSiblingReference}.
 * Schema sibling refs are always same-file (a sibling lives in the same container), so scanning the
 * one document is complete — no cross-file/workspace walk needed.
 */
export function* stringValueNodesOf(node: AbstractNode | null | undefined): Generator<ValueNode> {
    if (!node) return;
    if (isGroupNode(node) || isListNode(node)) {
        for (const child of node.elements) yield* stringValueNodesOf(child);
    } else if (isDocumentNode(node)) {
        for (const child of node.elements) yield* stringValueNodesOf(child);
    } else if (isAssignmentNode(node)) {
        yield* stringValueNodesOf(node.right);
    } else if (isValueNode(node) && node.valueType.type === 'String') {
        yield node;
    }
}
