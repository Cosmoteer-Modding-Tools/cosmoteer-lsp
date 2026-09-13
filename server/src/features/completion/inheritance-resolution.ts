import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    GroupNode,
    ValueNode,
    isAssignmentNode,
    isDocumentNode,
    isGroupNode,
    isListNode,
} from '../../core/ast/ast';
import { getStartOfAstNode } from '../../utils/ast.utils';
import {
    groupDiscriminator,
    registryHintFromContainer,
    resolveGroupClass,
    schemaContextEpoch,
    seedGroupClass,
} from '../../document/schema/schema-context';
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
 *
 * A class found this way is seeded into the synchronous resolution, so the containers written
 * inside the group take their slot from it as well. A group with no base of its own that sits
 * inside such a deriver is answered the same way: its ancestors are resolved first, then its own
 * slot is read again.
 *
 * @param group the group whose class is wanted.
 * @param cancellationToken stops the cross-file walk.
 * @param seen the groups already on the walk, guarding an inheritance cycle.
 * @returns the class FullName, or undefined when no base classifies the group.
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

    if (await resolveAncestorsThroughInheritance(group, cancellationToken, seen)) {
        const viaAncestor = resolveGroupClass(group);
        if (viaAncestor) return viaAncestor;
    }

    const cls = await classThroughOwnBases(group, cancellationToken, seen);
    if (cls) seedGroupClass(group, cls);
    return cls;
};

/**
 * Resolves the class of every ancestor group that derives from a base and has no class yet,
 * outermost first, so that a group nested in a cross-file deriver finds its slot typed.
 *
 * @param group the group whose ancestors are resolved.
 * @param cancellationToken stops the cross-file walk.
 * @param seen the groups already on the walk.
 * @returns true when at least one ancestor was newly classified.
 */
const resolveAncestorsThroughInheritance = async (
    group: GroupNode,
    cancellationToken: CancellationToken,
    seen: Set<GroupNode>
): Promise<boolean> => {
    const pending: GroupNode[] = [];
    for (let node = group.parent; node && !isDocumentNode(node); node = node.parent) {
        if (isGroupNode(node) && node.inheritance?.length && !resolveGroupClass(node)) pending.push(node);
    }
    let seeded = false;
    for (const ancestor of pending.reverse()) {
        if (cancellationToken.isCancellationRequested) return seeded;
        if (await resolveClassThroughInheritance(ancestor, cancellationToken, seen)) seeded = true;
    }
    return seeded;
};

/**
 * The class a group takes from the bases it names itself, each followed to its definition.
 *
 * @param group the group whose bases are followed.
 * @param cancellationToken stops the cross-file walk.
 * @param seen the groups already on the walk.
 * @returns the class FullName, or undefined when no base classifies the group.
 */
const classThroughOwnBases = async (
    group: GroupNode,
    cancellationToken: CancellationToken,
    seen: Set<GroupNode>
): Promise<string | undefined> => {
    const document = getStartOfAstNode(group);
    for (const reference of group.inheritance ?? []) {
        if (cancellationToken.isCancellationRequested) return undefined;
        let target = await DefinitionService.instance
            .resolveReferenceTarget(document, reference, cancellationToken)
            .catch(() => null);
        // A base that lands on a macro's reference value (`: /BASE_SHAKE` → the `&<file>` value of
        // `BASE_SHAKE = &<…>` in cosmoteer.rules) is not the base body yet: dereference it (bounded,
        // a macro can alias another macro) until a group, a file, or a dead end.
        for (
            let hops = 0;
            target && !isFile(target as FileWithPath) && isReferenceValue(target as AbstractNode) && hops < 8;
            hops++
        ) {
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

/** The documents already warmed, with the memo epoch the warm-up ran at. */
const warmedDocuments: WeakMap<AbstractNodeDocument, number> = new WeakMap();

/**
 * Seeds the class of every group in a document that derives from a base the synchronous
 * resolution cannot reach, outermost first, so that every synchronous reader that follows, the
 * validators, hover, the list and reference completions, sees the same classes the async walk
 * does. Runs once per document tree and memo epoch, so calling it at each request entry is cheap.
 *
 * @param document the parsed document.
 * @param cancellationToken stops the cross-file walk. A cancelled warm-up is not recorded as done.
 */
export const warmInheritedClasses = async (
    document: AbstractNodeDocument,
    cancellationToken: CancellationToken
): Promise<void> => {
    const epoch = schemaContextEpoch();
    if (warmedDocuments.get(document) === epoch) return;
    for (const group of derivingGroupsOf(document)) {
        if (cancellationToken.isCancellationRequested) return;
        if (resolveGroupClass(group)) continue;
        await resolveClassThroughInheritance(group, cancellationToken).catch(() => undefined);
    }
    if (!cancellationToken.isCancellationRequested && schemaContextEpoch() === epoch)
        warmedDocuments.set(document, epoch);
};

/**
 * Every group of a document that names a base, in document order, so an outer deriver is seeded
 * before the groups written inside it are looked at.
 *
 * @param document the parsed document.
 * @returns the deriving groups, outermost first.
 */
const derivingGroupsOf = (document: AbstractNodeDocument): GroupNode[] => {
    const found: GroupNode[] = [];
    const visit = (node: AbstractNode): void => {
        if (isGroupNode(node) && node.inheritance?.length) found.push(node);
        const children = isGroupNode(node) || isListNode(node) || isDocumentNode(node) ? node.elements : [];
        for (const child of children) {
            const container = isAssignmentNode(child) ? child.right : child;
            if (container) visit(container);
        }
    };
    visit(document);
    return found;
};
