import { CancellationToken } from 'vscode-languageserver';
import { AbstractNode, GroupNode, isGroupNode } from '../../core/ast/ast';
import { getStartOfAstNode } from '../../utils/ast.utils';
import { resolveGroupClass } from '../../document/schema/schema-context';
import { DefinitionService } from '../navigation/definition.service';
import { FileWithPath, isFile } from '../../workspace/cosmoteer-workspace.service';

/**
 * The schema class a group represents, resolving through inheritance when needed.
 *
 * Cosmoteer part files lean on inheritance: `MyTurret : ^/0/Turret { … }` or
 * `Cannon : &<…/base.rules>/Part { … }`. The deriving group often doesn't redeclare its `Type`, so
 * the plain (synchronous) {@link resolveGroupClass} — which keys off the group's own `Type`/slot,
 * can't classify it, and completion goes silent. This follows each `: base` reference (via the same
 * resolver go-to-definition uses, so cross-file bases resolve too) to the base group and classifies
 * that, recursively. Async because resolving a base may read another file.
 */
export const resolveClassThroughInheritance = async (
    group: GroupNode,
    cancellationToken: CancellationToken,
    seen: Set<GroupNode> = new Set()
): Promise<string | undefined> => {
    const direct = resolveGroupClass(group);
    if (direct) return direct;
    if (seen.has(group)) return undefined; // guard inheritance cycles
    seen.add(group);

    const document = getStartOfAstNode(group);
    for (const reference of group.inheritance ?? []) {
        if (cancellationToken.isCancellationRequested) return undefined;
        const target = await DefinitionService.instance
            .resolveReferenceTarget(document, reference, cancellationToken)
            .catch(() => null);
        if (!target || isFile(target as FileWithPath)) continue;
        const base = target as AbstractNode;
        if (isGroupNode(base)) {
            const cls = await resolveClassThroughInheritance(base, cancellationToken, seen);
            if (cls) return cls;
        }
    }
    return undefined;
};
