// Part component ids, as the features that follow one need to see them.
//
// A component is declared as a named member of a part's `Components` container and is named from
// anywhere in that part by its plain id. The engine resolves that id part-wide, so the four spellings
// below all point at the same declaration and a rename has to rewrite every one of them:
//   `SignificanceToggle = ScorchedToggle`          a part-level `ID<>` field
//   `OperationalToggle = IsOperational`            a field of another component
//   `Toggles = [PowerToggle, ScorchedToggle]`      a bare list element
//   `Toggles = [ { Toggle = ScorchedToggle } ]`    a group written as a list element
// The sibling resolver behind go-to-definition types only some of those, which is why the collection
// here goes by the slot's target registry instead: every slot whose target is the component registry
// counts, and the search is bounded to the one part the declaration belongs to so a file holding two
// parts never has one part's rename reach into the other.

import {
    AbstractNode,
    GroupNode,
    ValueNode,
    childNodesOf,
    isDocumentNode,
    isGroupNode,
    isListNode,
    isValueNode,
} from '../../core/ast/ast';
import { assignmentNameOf } from '../../utils/ast.utils';
import { registryForContainer, resolveGroupClass } from '../../document/schema/schema-context';
import { registryOf } from '../../document/schema/schema';
import { sameId } from '../../document/schema/entity-schema';
import { isSameOrSubclass, schemaReferenceFieldOf } from './schema-id-reference.navigation';
import { componentReferenceIdOf, stringValueNodesOf } from './schema-reference.navigation';
import { NON_SIBLING_FIELDS } from '../diagnostics/validator.schema-sibling';
import { BUFF_PROXY_CLASS, targetsAnotherPart } from '../../semantics/part-components';

/** The registry every part component belongs to, which is what makes an `ID<>` slot a component slot. */
const COMPONENT_REGISTRY = 'PartComponentRules';

/**
 * Whether a slot names a component of some part other than the one it is written in, which is what
 * makes the id under the caret unanswerable from this part.
 *
 * A proxy that names another cell's part through `PartLocation` or `PartCriteria`, a chainable proxy
 * and a buff-pooled group all read their ids against the part they reach into, so the same-named
 * component next door is the wrong node to point a reader at. The sibling validator gates on the
 * same three signals, which is why it reports nothing inside such a group either.
 *
 * @param node the value node the slot is written with.
 * @returns true when the slot reads its id against another part.
 */
const reachesOutsideThisPart = (node: AbstractNode): boolean => {
    for (let current: AbstractNode | undefined = node; current; current = current.parent) {
        if (!isGroupNode(current)) continue;
        if (targetsAnotherPart(current)) return true;
        const cls = resolveGroupClass(current);
        if (cls && isSameOrSubclass(cls, BUFF_PROXY_CLASS)) return true;
    }
    return false;
};

/**
 * The component id a value node writes, when the node sits in a component `ID<>` slot.
 *
 * @param node the value node under the caret, or any string value being collected.
 * @returns the written id, or undefined when the node is no component reference.
 */
export const componentIdSlotOf = (node: AbstractNode | null | undefined): string | undefined => {
    if (!node || !isValueNode(node) || node.valueType.type !== 'String') return undefined;
    // The typed sibling resolution first, so the shapes go-to-definition already follows answer the
    // same here, then the slot's declared target for the shapes it does not type.
    const sibling = componentReferenceIdOf(node);
    if (sibling !== undefined) return sibling;
    const reference = schemaReferenceFieldOf(node);
    if (!reference) return undefined;
    return registryOf(reference.targetClass)?.name === COMPONENT_REGISTRY ? reference.value : undefined;
};

/**
 * The component declaration the slot under the caret names, found inside the part the slot sits in.
 *
 * The engine resolves a component id part-wide, so every slot of the part reaches every component of
 * it, whichever container the slot is written in. Nothing here reads another file, which is what lets
 * the read-only features answer a cursor move without waiting for the project scan.
 *
 * The two gates the sibling validator carries hold here as well, because pointing a reader at a
 * same-named component of the wrong part reads as an answer and is harder to catch than silence.
 *
 * @param node the value node under the caret.
 * @returns the declaring node, or undefined when the caret is on no component id or the part declares none.
 */
export const componentDeclarationAt = (node: AbstractNode | null | undefined): AbstractNode | undefined => {
    if (!node) return undefined;
    // A field the engine reads as something other than a component of this part, and a group that
    // reads its ids against another part, name nothing here whatever the schema types the slot as.
    const fieldName = assignmentNameOf(node);
    if (fieldName && NON_SIBLING_FIELDS.has(fieldName.toLowerCase())) return undefined;
    if (reachesOutsideThisPart(node)) return undefined;
    const id = componentIdSlotOf(node);
    return id === undefined ? undefined : findComponentDeclaration(node, id);
};

/**
 * Whether a container holds a part's component declarations.
 *
 * The container's own name is the engine's (`Components`), and the registry check covers the
 * fragment files that write the container under another name while its members still carry the
 * `Type` discriminators of the component registry.
 *
 * @param container the candidate container node.
 * @returns true when the container's named members are component declarations.
 */
const isComponentsContainer = (container: AbstractNode): container is GroupNode => {
    if (!isGroupNode(container)) return false;
    const name = container.identifier?.name ?? assignmentNameOf(container);
    if (name?.toLowerCase() === 'components') return true;
    return registryForContainer(container)?.name === COMPONENT_REGISTRY;
};

/**
 * The component id a node declares, covering the brace form (`Toggle { … }`) and the assignment form
 * (`Toggle = { … }`), which the engine reads identically.
 *
 * @param node the candidate declaration node.
 * @returns the declared id, or undefined when the node declares no component.
 */
export const componentDeclarationIdOf = (node: AbstractNode | null | undefined): string | undefined => {
    if (!node) return undefined;
    const container = node.parent;
    if (!container || !isComponentsContainer(container)) return undefined;
    const own = (isGroupNode(node) || isListNode(node)) && node.identifier ? node.identifier.name : undefined;
    return own ?? assignmentNameOf(node);
};

/**
 * The part a node belongs to: the top-level element that encloses it, which is the `Part { … }` group
 * of an ordinary part file. A file declaring two parts gives each its own scope, so an id spelled in
 * both is renamed only where the declaration lives.
 *
 * @param node any node of the part.
 * @returns the enclosing top-level node, or the node itself when it is already one.
 */
export const partScopeOf = (node: AbstractNode): AbstractNode => {
    let scope = node;
    while (scope.parent && !isDocumentNode(scope.parent)) scope = scope.parent;
    return scope;
};

/**
 * The declaration of `id` inside the part `from` belongs to, exact case preferred, matching the
 * engine's case-insensitive component lookup.
 *
 * @param from any node of the part to search.
 * @param id the component id to find.
 * @returns the declaring group, list or assignment value, or undefined when the part declares none.
 */
export const findComponentDeclaration = (from: AbstractNode, id: string): AbstractNode | undefined => {
    let folded: AbstractNode | undefined;
    const stack: AbstractNode[] = [partScopeOf(from)];
    while (stack.length) {
        const current = stack.pop()!;
        const declared = componentDeclarationIdOf(current);
        if (declared !== undefined) {
            if (declared === id) return current;
            if (!folded && sameId(declared, id)) folded = current;
        }
        for (const child of childNodesOf(current)) stack.push(child);
    }
    return folded;
};

/**
 * Every component `ID<>` slot in the part that names `id`, which is the full set a rename of that
 * component has to rewrite beside the declaration itself.
 *
 * @param from any node of the part to search.
 * @param id the component id the sites name.
 * @returns the value nodes writing the id, in document order.
 */
export const componentIdSites = (from: AbstractNode, id: string): ValueNode[] => {
    const sites: ValueNode[] = [];
    for (const value of stringValueNodesOf(partScopeOf(from))) {
        const written = componentIdSlotOf(value);
        if (written !== undefined && sameId(written, id)) sites.push(value);
    }
    return sites;
};
