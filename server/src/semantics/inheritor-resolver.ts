import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    GroupNode,
    ListNode,
    isDocumentNode,
    isGroupNode,
    isListNode,
    isValueNode,
} from '../core/ast/ast';
import { getStartOfAstNode } from '../utils/ast.utils';
import { inheritanceBaseLeafName } from '../utils/reference.utils';
import { FileTree, isFile } from '../workspace/cosmoteer-workspace.service';
import { TemplateBaseIndex } from '../features/diagnostics/template-base.index';
import { FullNavigationStrategy } from '../features/navigation/full.navigation-strategy';
import { definitionLocationOf, locationKey } from '../features/navigation/reference-location';
import { uriToFsPath } from '../features/navigation/workspace-files';
import { cachedParseFilePath } from '../workspace/fs-cache';

/** The shared resolver, used to confirm a candidate inheritor by resolving its base back to the target. */
const navigation = new FullNavigationStrategy();

/** A named group or list: the only nodes a `:` base can be, since the base is addressed by name. */
type NamedContainer = GroupNode | ListNode;

/**
 * Collects every group/list node in a document whose inheritance references a base whose leaf name
 * matches `baseName` (case-insensitively), together with the reference node the match was found on.
 * A superset of the real inheritors: the same leaf name can name a different base in another chain, so
 * the caller confirms each by resolving the reference back to the target base node.
 *
 * @param document the parsed document to scan.
 * @param baseName the base group's leaf name to match.
 * @param out collects the `(deriver, reference)` candidates.
 */
const collectCandidates = (
    document: AbstractNode,
    baseName: string,
    out: Array<{ deriver: NamedContainer; reference: AbstractNode }>
): void => {
    const lower = baseName.toLowerCase();
    const visit = (node: AbstractNode): void => {
        if (isGroupNode(node) || isListNode(node)) {
            for (const reference of node.inheritance ?? []) {
                if (!isValueNode(reference) || reference.valueType.type !== 'Reference') continue;
                const leaf = inheritanceBaseLeafName(String(reference.valueType.value));
                if (leaf && leaf.toLowerCase() === lower) out.push({ deriver: node, reference });
            }
        }
        if (isGroupNode(node) || isListNode(node) || isDocumentNode(node)) {
            for (const child of node.elements) visit(child);
        }
    };
    visit(document);
};

/**
 * The concrete inheritors of a virtual-inheritance base: every group/list in the workspace that
 * inherits from `base` (the node a `&…/:` path resolves its `:` against). The reverse edge in
 * {@link TemplateBaseIndex} narrows the search to the files that inherit the base's name, and each
 * candidate is then confirmed by resolving its inheritance reference back to `base`, so a same-named
 * base in an unrelated chain is not mistaken for an inheritor.
 *
 * The list is a static approximation of the game's late binding: at runtime `:` selects whichever one
 * of these is the instance being built, so every override is an equally valid target. A base that no
 * file inherits yet (a template a mod is expected to complete) returns an empty list.
 *
 * @param base the base group/list a `:` segment resolves against.
 * @param cancellationToken cancels the candidate-file re-parses and reference resolutions.
 * @returns the confirmed inheritor nodes, in no particular order.
 */
export const findInheritorsOf = async (
    base: AbstractNode,
    cancellationToken: CancellationToken
): Promise<NamedContainer[]> => {
    if (!(isGroupNode(base) || isListNode(base)) || !base.identifier) return [];
    const baseName = base.identifier.name;
    // Identity by location, not object reference: a candidate's inheritance reference may resolve the
    // base through a different parse-cache layer than the one `base` came from, so two distinct node
    // instances can denote the same declaration. Their definition location (uri + identifier range) is
    // the stable identity.
    const baseKey = locationKey(definitionLocationOf(base));
    const uris = TemplateBaseIndex.instance.documentsForBaseName(baseName);
    const inheritors: NamedContainer[] = [];
    const seen = new Set<AbstractNode>();
    for (const uri of uris) {
        if (cancellationToken.isCancellationRequested) break;
        const document = await cachedParseFilePath(uriToFsPath(uri), cancellationToken).catch(() => null);
        if (!document) continue;
        const candidates: Array<{ deriver: NamedContainer; reference: AbstractNode }> = [];
        collectCandidates(document, baseName, candidates);
        for (const { deriver, reference } of candidates) {
            if (seen.has(deriver) || !isValueNode(reference)) continue;
            const resolved = await navigation
                .navigate(String(reference.valueType.value), reference, getStartOfAstNode(reference).uri, cancellationToken)
                .catch(() => null);
            if (resolved && !isFile(resolved as FileTree) &&
                locationKey(definitionLocationOf(resolved as AbstractNode)) === baseKey) {
                seen.add(deriver);
                inheritors.push(deriver);
            }
        }
    }
    return inheritors;
};

/**
 * Resolves a virtual-inheritance member path (`&Base/:/Member`) against every concrete inheritor of the
 * base, returning the override each defines. This is the "go to the most-derived version" target set: a
 * member declared virtual on the base and given a value by each deriver resolves to those values, not to
 * the base's own (default) declaration.
 *
 * @param base the base group/list the `:` resolves against (the node before `:` in the path).
 * @param memberPath the path after `:` (the member, or a deeper path into each inheritor), no leading slash.
 * @param cancellationToken cancels the inheritor search and the per-inheritor member resolutions.
 * @returns the resolved override nodes, deduplicated, or an empty array when no inheritor defines the member.
 */
export const resolveVirtualInheritanceTargets = async (
    base: AbstractNode,
    memberPath: string,
    cancellationToken: CancellationToken
): Promise<AbstractNode[]> => {
    if (!memberPath) return [];
    const inheritors = await findInheritorsOf(base, cancellationToken);
    const targets: AbstractNode[] = [];
    const seen = new Set<AbstractNode>();
    for (const inheritor of inheritors) {
        if (cancellationToken.isCancellationRequested) break;
        const target = await navigation
            .navigate(memberPath, inheritor, getStartOfAstNode(inheritor).uri, cancellationToken)
            .catch(() => null);
        // Skip a whole-file/FileWithPath result: a `:` member always lands inside a deriving group.
        if (target && !isFile(target as FileTree) && !seen.has(target as AbstractNode)) {
            seen.add(target as AbstractNode);
            targets.push(target as AbstractNode);
        }
    }
    return targets;
};
