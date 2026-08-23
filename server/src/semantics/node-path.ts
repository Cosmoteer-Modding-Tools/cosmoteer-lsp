import { AbstractNode, isAssignmentNode, isDocumentNode, isGroupNode, isListNode } from '../core/ast/ast';
import { memberNameOf, memberValueOf } from './reference-resolver';

/**
 * Why a node has no member path the game could address it by.
 *
 * `listElement` is the important one: an element of a `[ … ]` can only be named by its index, and an
 * index is load-order-dependent, because a `Remove` or an `Index`-inserting action of a mod that
 * loads earlier renumbers every element behind it. A path carrying one may silently name a different
 * element on somebody else's machine, so it is refused rather than emitted.
 *
 * `indexName` is the same hazard reached from the other side: a group member may be written with a
 * digit for a name, which the game reads as a position rather than as a name, so a path through one
 * means the same load-order-dependent thing even though no list is involved.
 */
export type NodePathRefusal =
    | 'listElement'
    | 'indexName'
    | 'unnamed'
    | 'shadowedName'
    | 'detached';

/** The member path of a node, or the reason it has none. */
interface NodePathResult {
    /** The member names from the file root down to the node, outermost first. */
    segments?: string[];
    /** Set when no path can be emitted, and then `segments` is absent. */
    refusal?: NodePathRefusal;
}

/**
 * The name the node's own container keys it by, together with the container to continue from.
 *
 * The parser gives an assignment's right-hand side the containing group as its parent, skipping the
 * assignment itself, so the owning element has to be found by scanning the container rather than by
 * reading the node's own identifier. Reading `identifier` instead would silently drop every
 * `X = { … }` member and every scalar member, which is exactly the trap the report builder fell into.
 *
 * @param node the node to name.
 * @returns the member name, or undefined when the container keys the node by nothing.
 */
const nameInContainer = (node: AbstractNode): string | undefined => {
    const container = node.parent;
    if (!container) return undefined;
    for (const element of container.elements) {
        if (element === node) return memberNameOf(element);
        if (isAssignmentNode(element) && element.right === node) return element.left.name;
    }
    return undefined;
};

/**
 * Whether `name` reaches `node` in `container`, rather than an earlier member of the same name.
 *
 * A reference path resolves a name to the first member declaring it, so a later duplicate is
 * unreachable by name. Emitting a path through one would hand the caller a path that resolves to
 * somebody else's node, which is worse than emitting nothing.
 *
 * @param container the group, list or document holding the member.
 * @param name the member name.
 * @param node the node the name is meant to reach.
 * @returns true when the first member of that name is the node itself.
 */
const nameReaches = (container: AbstractNode & { elements: AbstractNode[] }, name: string, node: AbstractNode): boolean => {
    for (const element of container.elements) {
        if (memberNameOf(element) !== name) continue;
        return element === node || memberValueOf(element) === node;
    }
    return false;
};

/**
 * The path of member names that addresses `node` from its file root, the way a reference path or a
 * mod action target addresses it.
 *
 * Every hop is keyed with the same naming rule references resolve by, so a path this returns is
 * exactly a path `stepIntoNode` walks back to the node it was built from. Anything that cannot be
 * addressed that way is refused rather than approximated.
 *
 * @param node the node to address.
 * @returns the member names outermost first, or the reason there is no path.
 */
export const memberPathOf = (node: AbstractNode): NodePathResult => {
    const segments: string[] = [];
    let current: AbstractNode = node;
    while (current.parent) {
        const container = current.parent;
        if (isListNode(container)) return { refusal: 'listElement' };
        const name = nameInContainer(current);
        if (name === undefined) return { refusal: 'unnamed' };
        if (/^\d+$/.test(name)) return { refusal: 'indexName' };
        if (!nameReaches(container, name, current)) return { refusal: 'shadowedName' };
        segments.unshift(name);
        if (isDocumentNode(container)) return { segments };
        current = container;
    }
    // A node with no parent is either the document itself, whose path is empty, or a node that was
    // built outside a document and never attached to one.
    return isDocumentNode(current) ? { segments } : { refusal: 'detached' };
};

/**
 * The member path of `node` as a slash-joined string.
 *
 * @param node the node to address.
 * @returns the joined path, or undefined when the node has no addressable path.
 */
export const memberPathStringOf = (node: AbstractNode): string | undefined => {
    const path = memberPathOf(node);
    return path.segments ? path.segments.join('/') : undefined;
};

/**
 * The nearest ancestor of `node` that a mod action can target, which is the innermost enclosing
 * group, since the game refuses an `Overrides` target that is not a group or a whole file.
 *
 * @param node the node the caret sits on.
 * @returns the enclosing group or document, or undefined when the node sits inside a list.
 */
export const targetableContainerOf = (node: AbstractNode): AbstractNode | undefined => {
    let current: AbstractNode | undefined = node;
    while (current) {
        if (isGroupNode(current) || isDocumentNode(current)) return current;
        if (isListNode(current)) return undefined;
        current = current.parent;
    }
    return undefined;
};
