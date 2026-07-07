import { Range } from 'vscode-languageserver';
import {
    AbstractNode,
    GroupNode,
    isAssignmentNode,
    isDocumentNode,
    isGroupNode,
    isListNode,
    isValueNode,
    ListNode,
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
    // Case-folded with exact preference, matching the game's case-insensitive node lookup.
    const targetName = String((node as ValueNode).valueType.value);
    const named = container.elements.filter(
        (element): element is GroupNode | ListNode => (isGroupNode(element) || isListNode(element)) && !!element.identifier
    );
    return (
        named.find((element) => element.identifier!.name === targetName) ??
        named.find((element) => element.identifier!.name.toLowerCase() === targetName.toLowerCase())
    );
};

/** The document range covering a bare-string value node's whole text (a single-segment id). */
export const valueTextRange = (node: ValueNode): Range => {
    const { line, characterStart, characterEnd } = node.position;
    return Range.create(line, characterStart, line, characterEnd);
};

// Several validators and index builders walk the same document for its string values within one
// validation pass, so the collected list is memoized per AST node. A re-parse produces new node
// identities, which keeps stale entries unreachable without any explicit invalidation.
const stringValueNodesMemo = new WeakMap<AbstractNode, readonly ValueNode[]>();

/**
 * Every bare-string value node in a document — the candidate sites for a schema `ID<>` sibling
 * reference. Callers pre-filter by text (cheap) then confirm with {@link resolveSchemaSiblingReference}.
 * Schema sibling refs are always same-file (a sibling lives in the same container), so scanning the
 * one document is complete — no cross-file/workspace walk needed.
 */
export function stringValueNodesOf(node: AbstractNode | null | undefined): readonly ValueNode[] {
    if (!node) return [];
    const cached = stringValueNodesMemo.get(node);
    if (cached) return cached;
    const values: ValueNode[] = [];
    const stack: AbstractNode[] = [node];
    while (stack.length) {
        const current = stack.pop()!;
        if (isGroupNode(current) || isListNode(current) || isDocumentNode(current)) {
            for (let i = current.elements.length - 1; i >= 0; i--) stack.push(current.elements[i]);
        } else if (isAssignmentNode(current)) {
            stack.push(current.right);
        } else if (isValueNode(current) && current.valueType.type === 'String') {
            values.push(current);
        }
    }
    stringValueNodesMemo.set(node, values);
    return values;
}
