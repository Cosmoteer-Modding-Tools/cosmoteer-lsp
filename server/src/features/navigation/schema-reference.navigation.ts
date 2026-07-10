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
import { classOfGroup, listSlotType, registryForContainer } from '../../document/schema/schema-context';
import { fieldOf, registryOf, scalarReferenceTargetOf } from '../../document/schema/schema';

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
    const targetName = componentReferenceIdOf(node);
    if (targetName === undefined) return undefined;

    // A component id written in a tuple slot (a network router's `Routes [ [A, B, 0] ]`): the engine
    // resolves the id part-wide, so search the whole document for the named group (cross-file bases
    // are out of this sync resolver's scope; the async part-wide resolver covers them).
    const list = node!.parent;
    if (list && isListNode(list)) return findComponentInDocument(node!, targetName);

    // The value text is a sibling component's identifier, so find that group in the same container.
    // Case-folded with exact preference, matching the game's case-insensitive node lookup.
    const container = node!.parent?.parent;
    if (!container || !isGroupNode(container)) return undefined;
    const named = container.elements.filter(
        (element): element is GroupNode | ListNode => (isGroupNode(element) || isListNode(element)) && !!element.identifier
    );
    return (
        named.find((element) => element.identifier!.name === targetName) ??
        named.find((element) => element.identifier!.name.toLowerCase() === targetName.toLowerCase())
    );
};

/**
 * The written id when `node` is a component `ID<…>` reference value: a same-registry reference field
 * of a component group (`OperationalToggle = IsOperational`) or a part-component tuple slot (a
 * router's `Routes [ [from, to, cost] ]`). Carries the gates only, shared by the sync resolvers here
 * and the async part-wide resolution in the sibling validator.
 *
 * @param node the value node under the cursor.
 * @returns the written component id, or undefined when the node is not a component reference.
 */
export const componentReferenceIdOf = (node: AbstractNode | null | undefined): string | undefined => {
    if (!node || !isValueNode(node) || node.valueType.type !== 'String') return undefined;

    const list = node.parent;
    if (list && isListNode(list)) {
        if (list.inheritance?.length) return undefined;
        const slot = listSlotType(list);
        const element = slot?.kind === 'tuple' ? slot.elements[list.elements.indexOf(node)] : undefined;
        if (element?.kind === 'reference' && registryOf(element.target)?.name === 'PartComponentRules') {
            return String(node.valueType.value);
        }
        return undefined;
    }

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
    // A same-registry reference field, or a scalar-form group field whose scalar payload is such a
    // reference (`FireTrigger = Turret` reads into ComponentTriggerReferenceRules.ID).
    const target =
        field?.valueType.kind === 'reference'
            ? field.valueType.target
            : field?.valueType.kind === 'group'
              ? scalarReferenceTargetOf(field.valueType.ref)
              : undefined;
    if (!target || registryOf(target) !== registry) return undefined;
    return String(node.valueType.value);
};

/**
 * The named group/list called `targetName` anywhere in `node`'s document, exact case preferred, the
 * document-wide mirror of the same-container sibling search for part-wide component ids.
 *
 * @param node any node of the document to search.
 * @param targetName the component id to find.
 * @returns the declaring group/list node, or undefined when the document declares none.
 */
const findComponentInDocument = (node: AbstractNode, targetName: string): AbstractNode | undefined => {
    let root: AbstractNode | undefined = node;
    while (root.parent) root = root.parent;
    let caseInsensitive: AbstractNode | undefined;
    const stack: AbstractNode[] = [root];
    while (stack.length) {
        const current = stack.pop()!;
        if ((isGroupNode(current) || isListNode(current)) && current.identifier) {
            if (current.identifier.name === targetName) return current;
            if (!caseInsensitive && current.identifier.name.toLowerCase() === targetName.toLowerCase()) {
                caseInsensitive = current;
            }
        }
        const children: AbstractNode[] =
            isGroupNode(current) || isListNode(current) || isDocumentNode(current)
                ? current.elements
                : isAssignmentNode(current)
                  ? (current.right ? [current.right] : [])
                  : [];
        for (const child of children) stack.push(child);
    }
    return caseInsensitive;
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
            if (current.right) stack.push(current.right);
        } else if (isValueNode(current) && current.valueType.type === 'String') {
            values.push(current);
        }
    }
    stringValueNodesMemo.set(node, values);
    return values;
}
