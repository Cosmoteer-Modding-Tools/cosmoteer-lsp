import { CancellationToken } from 'vscode-languageserver';
import { AbstractNode, ListNode, isListNode, isGroupNode, GroupNode } from '../core/ast/ast';
import { getStartOfAstNode } from '../utils/ast.utils';
import { FileWithPath, FileTree, isFile } from '../workspace/cosmoteer-workspace.service';
import { getParsedFileDocument } from '../workspace/parsed-file-cache';
import { stepIntoNode } from './reference-resolver';

/**
 * A reference-resolution function (e.g. FullNavigationStrategy.navigate) used to
 * resolve an inheritance reference to the node it points at.
 */
export type ResolveReferenceFn = (
    path: string,
    startNode: AbstractNode,
    currentLocation: string,
    cancellationToken: CancellationToken,
    // The inheritance-cycle guard, forwarded so a reference that re-enters inheritance
    // resolution (an inheritance ref whose own path needs an inheritance lookup) shares
    // the same `visited` set. Otherwise a cyclic chain recurses until the stack overflows.
    inheritanceVisited?: Set<AbstractNode>
) => Promise<AbstractNode | null | { readonly type: string } | undefined>;

/**
 * Resolve a named member of `node` by walking its inheritance chain, without
 * mutating the AST.
 *
 * This replaces the previous approach (`addInhertinaceToNode`) which flattened
 * inherited members into `node.elements` in place. That mutation persisted across
 * calls (causing duplicated/injected nodes) and guarded cycles only with a depth
 * counter. Here nothing is mutated and the matching member is returned directly,
 * cycles are detected with an explicit `visited` set (no arbitrary depth limit),
 * and per-node lookup reuses the canonical {@link stepIntoNode}, so a found member
 * has exactly the same shape as a direct lookup would.
 */
export const findMemberThroughInheritance = async (
    node: GroupNode | ListNode,
    segment: string,
    resolveReference: ResolveReferenceFn,
    cancellationToken: CancellationToken,
    visited: Set<AbstractNode> = new Set()
): Promise<AbstractNode | null | undefined> => {
    if (visited.has(node)) return null;
    visited.add(node);
    if (!node.inheritance) return null;

    for (const inheritance of node.inheritance) {
        if (inheritance.valueType.type !== 'Reference') continue;
        // Resolve the inheritance reference from the value node's own scope, not the
        // group's. Relative refs (`^/0/…`, `&Name`, `..`) are written relative to the
        // inheritance node, whose parent is the inheriting group. Passing the group
        // instead would shift `^`/`&` up by one level and resolve in the wrong scope.
        const resolved = await resolveReference(
            inheritance.valueType.value,
            inheritance,
            getStartOfAstNode(node).uri,
            cancellationToken,
            // Carry this lookup's `visited` set into the reference resolution so that, if it
            // loops back into inheritance, the same already-seen nodes terminate it.
            visited
        ).catch(() => null);
        if (!resolved) continue;

        // A whole-file base (`Comp : <shot_file.rules>`, no `/member` suffix) resolves to a File.
        // Its inherited members are the file's root-level fields (`HitInterval`, `Range`, …), so
        // descend into the parsed document and look the segment up there, rather than skipping the
        // base, which left every `&<file>`-inherited member unresolvable (false "unknown reference").
        let parent = resolved as AbstractNode;
        if (isFile(resolved as unknown as FileTree)) {
            const document = await getParsedFileDocument(resolved as unknown as FileWithPath).catch(() => null);
            if (!document) continue;
            parent = document;
        }

        const direct = stepIntoNode(parent, segment);
        if (direct) return direct;

        // A document root (whole-file base) has no inheritance chain of its own to walk further, so
        // the direct lookup above is exhaustive for it. Only recurse through group/list bases.
        if (isGroupNode(parent) || isListNode(parent)) {
            const inherited = await findMemberThroughInheritance(
                parent,
                segment,
                resolveReference,
                cancellationToken,
                visited
            );
            if (inherited) return inherited;
        }
    }
    return null;
};
