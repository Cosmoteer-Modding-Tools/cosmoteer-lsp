import {
    AbstractNode,
    isListNode,
    isAssignmentNode,
    isDocumentNode,
    isGroupNode,
    isIdentifierNode,
} from '../core/ast/ast';
import { getStartOfAstNode } from '../utils/ast.utils';
import { isNumber } from '../utils/utils';

/**
 * Canonical single-step navigation within the in-memory AST.
 *
 * Given a node and one path segment, return the node that segment points to,
 * or `null`/`undefined` if it cannot be resolved. This is the single source of
 * truth for the reference-path grammar's per-segment behavior, shared by both
 * the navigation strategy (go-to / validation) and the autocompletion strategy.
 *
 * Supported segments: a number selects a list element (or inheritance entry when
 * `isInheritance`); `..` selects the node's parent; `^` selects the node's grandparent
 * (parent of parent); `~` selects the document root the node belongs to; `:` selects the
 * most-derived inheritor (statically approximated as the node itself); any other
 * segment selects a named child (assignment value, or identified group/list).
 */
export const stepIntoNode = (
    node: AbstractNode,
    segment: string,
    isInheritance = false
): AbstractNode | null | undefined => {
    if (isNumber(segment)) {
        const index = Number(segment);
        if (isInheritance && (isListNode(node) || isGroupNode(node))) {
            return node.inheritance?.[index];
        }
        if (isListNode(node)) {
            return node.elements[index];
        }
    } else if (segment === '..') {
        return node.parent;
    } else if (segment === '^') {
        // `^` selects the current node's OWN inheritance anchor (its base list), mirroring the game's
        // `OTNode.FindAtPath`, where `^` yields the node's `InheritanceList` (the following `/N` then
        // indexes it, selecting the Nth base). For a group/list — whether reached mid-path (`../^/0/X`)
        // or as a top-level root (`~/Part/^/0/X`) — that anchor is the node itself, so return it and let
        // the `/N` isInheritance step read its `inheritance`.
        if (isGroupNode(node) || isListNode(node)) return node;
        // A value/void node — the start of an `X : ^/0/X` inheritance ref, two levels below its owning
        // group — has no inheritance of its own, so climb to that group (the grandparent) whose base the
        // `/N` then selects. (The inheriting member inherits from the same-named member of its
        // container's base, so `^/0` must resolve against the container, i.e. the grandparent.)
        if (node.parent?.parent) return node.parent.parent;
        return undefined;
    } else if (segment === ':') {
        // `:` selects the most-derived inheritor of the current node (virtual inheritance). Which
        // inheritor that is depends on the instantiation context, so statically we approximate with
        // the game's no-inheritor behavior, the node itself, which resolves the parent's own
        // (default) member. The reference validator does not flag `:` paths, since the member may
        // legitimately exist only in an inheritor.
        if (isGroupNode(node) || isListNode(node) || isDocumentNode(node)) return node;
        // A value node has no members of its own; resolve against its owning group so
        // `Sum = (&:/v_A)`-style refs land on the group the value lives in.
        return node.parent;
    } else if (segment === '~') {
        return getStartOfAstNode(node);
    } else {
        if (isGroupNode(node) || isDocumentNode(node)) {
            // Member lookup is case-insensitive in Cosmoteer (like its file paths), but an
            // exact-case match is always preferred so two members differing only by case
            // still resolve precisely. Reference paths look members up per segment, per
            // reference, so the per-container name tables are built once and reused.
            const index = memberIndexOf(node);
            if (index.exact.has(segment)) return index.exact.get(segment);
            return index.lower.get(segment.toLowerCase()) ?? null;
        }
    }
    return null;
};

/** One container's member lookup tables: first exact-cased name and first case-folded name. A
 *  member's target can be null (an in-progress empty `Key = ` assignment), preserved so an exact
 *  match on it stays unresolved like the original in-order scan. */
interface MemberIndex {
    exact: Map<string, AbstractNode | null>;
    lower: Map<string, AbstractNode | null>;
}

/** Per-container member tables, keyed weakly so they die with their AST. */
const memberIndexCache: WeakMap<AbstractNode, MemberIndex> = new WeakMap();

/**
 * The member lookup tables of a group/document, built on first use. The first element declaring a
 * name wins in each table, matching the original in-order scan.
 *
 * @param node the group or document whose members to index.
 * @returns the container's member tables.
 */
const memberIndexOf = (node: AbstractNode & { elements: AbstractNode[] }): MemberIndex => {
    const cached = memberIndexCache.get(node);
    if (cached) return cached;
    const index: MemberIndex = { exact: new Map(), lower: new Map() };
    for (const element of node.elements) {
        const name = isAssignmentNode(element)
            ? element.left.name
            : (isGroupNode(element) || isListNode(element)) && element.identifier
              ? element.identifier.name
              : // A bare `word` line in a group parses to a lone IdentifierNode: a named
                // void field (vanilla: `v_Faction // VIRTUAL; must be inherited`). The
                // game keys children by name regardless of value, so match it too.
                isIdentifierNode(element)
                ? element.name
                : undefined;
        if (name === undefined) continue;
        const target = isAssignmentNode(element) ? element.right : element;
        if (!index.exact.has(name)) index.exact.set(name, target);
        const lower = name.toLowerCase();
        if (!index.lower.has(lower)) index.lower.set(lower, target);
    }
    memberIndexCache.set(node, index);
    return index;
};
