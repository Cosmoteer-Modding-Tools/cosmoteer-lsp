import {
    AbstractNode,
    isListNode,
    isAssignmentNode,
    isDocumentNode,
    isGroupNode,
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
 * (parent of parent); `~` selects the document root the node belongs to; any other
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
    } else if (segment === '~') {
        return getStartOfAstNode(node);
    } else {
        if (isGroupNode(node) || isDocumentNode(node)) {
            // Member lookup is case-insensitive in Cosmoteer (like its file paths), but an
            // exact-case match is always preferred so two members differing only by case
            // still resolve precisely.
            const lower = segment.toLowerCase();
            let caseInsensitiveMatch: AbstractNode | null = null;
            for (const element of node.elements) {
                const name = isAssignmentNode(element)
                    ? element.left.name
                    : (isGroupNode(element) || isListNode(element)) && element.identifier
                      ? element.identifier.name
                      : undefined;
                if (name === undefined) continue;
                const target = isAssignmentNode(element) ? element.right : element;
                if (name === segment) return target;
                if (!caseInsensitiveMatch && name.toLowerCase() === lower) caseInsensitiveMatch = target;
            }
            return caseInsensitiveMatch;
        }
    }
    return null;
};
