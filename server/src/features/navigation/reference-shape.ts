/**
 * What shape a reference has, in the one reading the validator and the reference trace share: what
 * it is rooted at, where the walk that resolves it starts, and when a member missing from an
 * existing base is tolerated rather than reported. Both features read these rules here so a report
 * and a diagnostic never disagree about the same reference.
 */

import { CancellationToken } from 'vscode-languageserver';
import { AbstractNode, ValueNode, isDocumentNode, isGroupNode, isListNode, isValueNode } from '../../core/ast/ast';
import { getStartOfAstNode } from '../../utils/ast.utils';
import { FileTree, isFile } from '../../workspace/cosmoteer-workspace.service';
import { navigate } from '../../semantics/navigate-reference';
import { extractSubstrings } from '../../document/reference-path';

/** The strategy the base-prefix probe navigates with. */
/**
 * True for an inheritance reference (`X : ^/0/X [...]`) whose base prefix resolves to a
 * real group/list but whose final member does not exist. Cosmoteer allows inheriting
 * from a base that doesn't define that member (it just contributes nothing), so this is
 * not an error. Only genuine inheritance refs whose base is missing are flagged.
 *
 * The reference trace says the same thing about the same reference. Without this rule the trace
 * would call one of the most common shapes in the game's own files broken.
 *
 * @param node the reference value to classify.
 * @param startNode the navigation origin.
 * @param uri the referring document's uri.
 * @param cancellationToken cancels the navigation.
 * @returns true when the reference extends a base that exists and simply lacks the member.
 */
export const inheritanceExtendsMissingMember = async (
    node: ValueNode,
    startNode: AbstractNode,
    uri: string,
    cancellationToken: CancellationToken
): Promise<boolean> => {
    const parent = node.parent;
    if (!parent || !(isListNode(parent) || isGroupNode(parent)) || !parent.inheritance?.includes(node)) return false;
    const value = String(node.valueType.value);
    const segments = extractSubstrings(value);

    // `X : ^/<N>/X [extra]` the extend-my-own-member idiom, is valid as long as the
    // container's Nth inheritance slot exists, even if the base it points at doesn't define
    // `X`, and even if the slot is itself another extend (a "virtual" base). We require the
    // final segment to equal the inheriting member's own name so a typo (`^/0/Xtypo`) or an
    // unrelated missing member is still flagged. `^` is the container (node.parent.parent).
    if (segments.length >= 3 && segments[0] === '^' && /^\d+$/.test(segments[1])) {
        const container = node.parent?.parent;
        return (
            segments[segments.length - 1] === parent.identifier?.name &&
            !!container &&
            (isGroupNode(container) || isListNode(container)) &&
            !!container.inheritance?.[Number(segments[1])]
        );
    }

    // Other inheritance forms: skip if the base prefix (everything before the last segment)
    // resolves to a real container. The member is just absent on an existing base.
    return basePrefixResolvesToContainer(value, startNode, uri, cancellationToken);
};

/**
 * Whether the base prefix of a reference (everything before its final `/segment`) resolves to a real
 * container: a group, a list, a whole-file document, or the file itself. This is what tells "the
 * member is absent on an existing base" (tolerated) apart from "nothing along the path resolves at
 * all" (a genuine dangling reference). The base prefix may itself be a `<file>` (the cross-file
 * extend-own-member idiom `X : <base.rules>/X`), which resolves to that file's Document or the File.
 *
 * @param value the full reference text, e.g. `&<base.rules>/Part/^/0`.
 * @param startNode the navigation origin.
 * @param uri the referring document's uri.
 * @param cancellationToken cancels the navigation.
 * @returns true when the base prefix resolves to a container the missing member could sit on.
 */
const basePrefixResolvesToContainer = async (
    value: string,
    startNode: AbstractNode,
    uri: string,
    cancellationToken: CancellationToken
): Promise<boolean> => {
    const lastSlash = value.lastIndexOf('/');
    if (lastSlash <= 0) return false;
    let base = await navigate(value.slice(0, lastSlash), startNode, uri, cancellationToken).catch(() => null);
    if (base && isValueNode(base as AbstractNode) && (base as ValueNode).valueType.type === 'Reference') {
        base = await navigate(
            String((base as ValueNode).valueType.value),
            base as AbstractNode,
            getStartOfAstNode(base as AbstractNode).uri,
            cancellationToken
        ).catch(() => null);
    }
    if (!base || typeof base !== 'object') return false;
    return (
        isGroupNode(base as AbstractNode) ||
        isListNode(base as AbstractNode) ||
        isDocumentNode(base as AbstractNode) ||
        isFile(base as unknown as FileTree)
    );
};

/**
 * Whether a reference is `~`-rooted (`~/…` or `&~/…`). `~` denotes the runtime root of wherever the
 * rule is instantiated, which is not knowable from the static file: a template/library group (e.g. a
 * shared sound inherited into a weapon part, `&~/EMITTER/BeamCount`) reaches members of its consuming
 * part, and parts reach runtime-assembled subtrees (`&~/Part/Components/BulletEmitterBase/Bullet/…`)
 * that simply do not exist statically. We therefore do not statically validate any `~`-rooted
 * reference. Flagging them produced hundreds of false positives on real mods, and the game resolves
 * them at instantiation regardless. (Trade-off: a typo inside a `~` path is no longer caught, but it
 * could never be told apart from a legitimate runtime member.)
 *
 * The validator and the reference trace both read this one rule rather than deriving a second one,
 * which is what keeps the report and the diagnostics in agreement.
 *
 * @param node the reference value to classify.
 * @returns true when the reference is rooted at the runtime object.
 */
export const isRuntimeRootReference = (node: ValueNode): boolean => {
    const value = node.valueType.value;
    if (typeof value !== 'string') return false;
    const withoutAmpersand = value.startsWith('&') ? value.substring(1) : value;
    return withoutAmpersand.startsWith('~');
};

/**
 * Whether a reference path contains a `:` virtual-inheritance segment (`&:/v_A`, `&../:/v_Group1`).
 * `:` jumps to the most-derived inheritor of the node, which is unknowable statically (the
 * referenced member may exist only in a child), so such references are never validated.
 *
 * Refused for the same reason as {@link isRuntimeRootReference}.
 *
 * @param value the reference text.
 * @returns true when one of the path's segments is a `:`.
 */
export const hasVirtualInheritanceSegment = (value: string): boolean => {
    if (typeof value !== 'string') return false;
    const withoutAmpersand = value.startsWith('&') ? value.substring(1) : value;
    return extractSubstrings(withoutAmpersand).some((segment) => segment.trim() === ':');
};

/**
 * Whether a reference is one of its own group's `..`-relative inheritance entries. Such a reference
 * is written from the inheriting group's container, so it is resolved from there rather than from the
 * value node itself, which is where the validator and the reference trace both start their walk.
 *
 * @param value the reference value to classify.
 * @returns true when the value is a same-file inheritance entry written with `..`.
 */
export const isInheritanceInSameFile = (value: ValueNode): boolean => {
    return !!(
        value.valueType.type === 'Reference' &&
        value.valueType.value.startsWith('..') &&
        value.parent &&
        (isListNode(value.parent) || isGroupNode(value.parent)) &&
        value.parent.inheritance &&
        value.parent.inheritance.some((inheritance) => inheritance === value)
    );
};
