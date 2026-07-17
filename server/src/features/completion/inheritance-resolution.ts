import { CancellationToken } from 'vscode-languageserver';
import { AbstractNode, AbstractNodeDocument, GroupNode, ValueNode, isDocumentNode, isGroupNode } from '../../core/ast/ast';
import { getStartOfAstNode } from '../../utils/ast.utils';
import { groupDiscriminator, registryHintFromContainer, resolveGroupClass } from '../../document/schema/schema-context';
import { documentRootClass } from '../../document/schema/document-root';
import { classByDiscriminator } from '../../document/schema/schema';
import { DefinitionService, isReferenceValue } from '../navigation/definition.service';
import { FileWithPath, isFile } from '../../workspace/cosmoteer-workspace.service';
import { getParsedFileDocument } from '../../workspace/parsed-file-cache';

/**
 * The schema class a group represents, resolving through inheritance when needed.
 *
 * Cosmoteer part files lean on inheritance: `MyTurret : ^/0/Turret { … }` or
 * `Cannon : &<…/base.rules>/Part { … }`. The deriving group often doesn't redeclare its `Type`, so
 * the plain (synchronous) {@link resolveGroupClass}, which keys off the group's own `Type`/slot,
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
        let target = await DefinitionService.instance
            .resolveReferenceTarget(document, reference, cancellationToken)
            .catch(() => null);
        // A base that lands on a macro's reference value (`: /BASE_SHAKE` → the `&<file>` value of
        // `BASE_SHAKE = &<…>` in cosmoteer.rules) is not the base body yet: dereference it (bounded,
        // a macro can alias another macro) until a group, a file, or a dead end.
        for (let hops = 0; target && !isFile(target as FileWithPath) && isReferenceValue(target as AbstractNode) && hops < 8; hops++) {
            const ref = target as ValueNode;
            target = await DefinitionService.instance
                .resolveReferenceTarget(getStartOfAstNode(ref), ref, cancellationToken)
                .catch(() => null);
        }
        if (!target) continue;
        // A whole-file base (`: /BASE_SHAKE` → `BASE_SHAKE = &<common_effects/base_shake.rules>`,
        // a rootless fragment whose top level IS the group body): classify the parsed document.
        // The resolver hands back either the file node or its already-parsed document, depending
        // on which resolution path answered.
        const fragment = isFile(target as FileWithPath)
            ? await getParsedFileDocument(target as FileWithPath).catch(() => null)
            : isDocumentNode(target as AbstractNode)
              ? (target as AbstractNodeDocument)
              : null;
        if (fragment) {
            const cls = classOfWholeFileBase(fragment, group);
            if (cls) return cls;
            continue;
        }
        const base = target as AbstractNode;
        if (isGroupNode(base)) {
            const cls = await resolveClassThroughInheritance(base, cancellationToken, seen);
            if (cls) return cls;
        }
    }
    return undefined;
};

/**
 * The schema class a whole-file inheritance base represents: the fragment's rooted class when the
 * file roots (an aliased-in fragment), else the class its top-level `Type=` discriminator selects.
 * The discriminator is disambiguated by the deriving group's slot registry. The fragment file
 * itself is rootless, so its own context can't tell colliding discriminators apart, but the
 * deriver's slot (`MediaEffects [ : /BASE_SHAKE { … } ]`) can.
 *
 * @param fragment the parsed document of the base file.
 * @param deriver the group inheriting the file.
 * @returns the class FullName, or undefined when the fragment carries no classifiable root.
 */
const classOfWholeFileBase = (fragment: AbstractNodeDocument, deriver: GroupNode): string | undefined => {
    const rooted = documentRootClass(fragment);
    if (rooted) return rooted;
    const disc = groupDiscriminator(fragment);
    return disc ? classByDiscriminator(disc, registryHintFromContainer(deriver)) : undefined;
};
