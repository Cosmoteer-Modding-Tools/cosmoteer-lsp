import { CancellationToken, Location, Range } from 'vscode-languageserver';
import { AbstractNode, AbstractNodeDocument, isValueNode, ValueNode } from '../../core/ast/ast';
import { getStartOfAstNode } from '../../utils/ast.utils';
import { FileTree, FileWithPath, isFile } from '../../workspace/cosmoteer-workspace.service';
import { navigate } from '../../semantics/navigate-reference';
import { isInheritanceEntry } from '../../document/reference-resolver';
import { filePathToUri } from '../../document/reference-path';
import { definitionLocationOf } from '../../document/reference-location';
import { isModRules } from '../../document/document-kind';
import { parseModActions } from '../../mod/action-parser';
import { normalizeTargetPath } from '../../mod/action-target-resolver';
import { resolveFromModContextOnly, resolveWithModContext } from '../../mod/mod-context';

/** The range a whole-file target is reported at, since a file has no position of its own. */
export const ZERO_RANGE = Range.create(0, 0, 0, 0);

export const isReferenceValue = (node: AbstractNode | null | undefined): node is ValueNode =>
    !!node && isValueNode(node) && node.valueType.type === 'Reference';

/**
 * True if `node` is a mod-action target value the `OverrideIn` / `AddTo` / `Replace`
 * / … path of an entry in a manifest's `Actions` list. Targets resolve against the
 * game Data root (with the mod's additions), unlike sources/normal refs which resolve
 * relative to the manifest, so they need the canonical-path + mod-context resolution.
 *
 * @param document the document the node is written in.
 * @param node the reference value node.
 * @returns true when the value is an action target path.
 */
const isActionTarget = (document: AbstractNodeDocument, node: ValueNode): boolean => {
    if (!isModRules(document.uri)) return false;
    return parseModActions(document).some((action) => action.targets.includes(node));
};

/**
 * Resolve a reference, falling back to its longest resolvable prefix when the full
 * path doesn't resolve. This makes go-to-definition land somewhere useful for
 * inherit-and-extend references whose final member is virtual e.g.,
 * `Toggles : ^/0/Toggles` has no concrete Toggles target, so we jump to what `^/0`
 * points at (the base being extended). A reference reached via a prefix is
 * dereferenced once to its concrete base group rather than the `^/N/X` text.
 *
 * The fallback is for inheritance bases only. Everywhere else a path that does not resolve is a
 * broken reference, and answering it with its parent hides that: a typo lands the reader on the
 * container it was written under and looks like it worked.
 *
 * @param node the reference value node.
 * @param uri the file the reference is written in.
 * @param cancellationToken stops the resolution.
 * @returns the target node or file, or null.
 */
const resolveWithPrefixFallback = async (
    node: ValueNode,
    uri: string,
    cancellationToken: CancellationToken
): Promise<AbstractNode | FileWithPath | null> => {
    const value = String(node.valueType.value);
    // Full path against vanilla first.
    let target = (await navigate(value, node, uri, cancellationToken).catch(() => null)) as
        AbstractNode | FileWithPath | null;
    // Then the mod's effective tree, for a member the mod merges into a vanilla file the
    // reference reaches through a vanilla global (`&/INDICATORS/SWX` → the mod's indicators
    // override). Done before the prefix walk below, which would otherwise stop at the global's
    // own file (the prefix `/INDICATORS`) and land go-to-def on the vanilla file, not the member.
    if (!target) {
        const modTarget = await resolveFromModContextOnly(value, node, cancellationToken).catch(() => null);
        if (modTarget) return modTarget;
    }
    // The mod's effective tree has already been tried above, so an unresolved reference that is
    // not an inheritance base is simply broken and answers nothing.
    if (!target && !isInheritanceEntry(node)) return null;
    let path = value;
    while (!target) {
        const lastSlash = path.lastIndexOf('/');
        const prefix = lastSlash > 0 ? path.slice(0, lastSlash) : '';
        // Dead-end: no meaningful prefix is left. What remains is empty, or only a sigil
        // (`&`, `/`, `&/`). A bare `&` would spuriously resolve to the bearer's own scope
        // and mask the real target, so we must stop before that. Vanilla navigation is
        // exhausted. Inside a mod, a super-path / file ref (`&/SW_COLORS/Lime/RGBA`,
        // `<cosmoteer.rules>/SW_X`) may point at a global the mod itself inserts, which
        // exists only in its effective tree. Resolve the full reference there, mirroring
        // how the value validator resolves `&/SW_X/…`.
        if (!prefix || /^[&/]+$/.test(prefix)) {
            return await resolveFromModContextOnly(value, node, cancellationToken).catch(() => null);
        }
        path = prefix;
        target = (await navigate(path, node, uri, cancellationToken).catch(() => null)) as
            AbstractNode | FileWithPath | null;
    }
    if (path !== value && isReferenceValue(target as AbstractNode)) {
        const ref = target as ValueNode;
        const deref = await navigate(
            String(ref.valueType.value),
            ref,
            getStartOfAstNode(ref).uri,
            cancellationToken
        ).catch(() => null);
        if (deref && !isFile(deref as FileTree)) target = deref as AbstractNode;
    }
    return target;
};

/**
 * Resolve a reference value node to its target: the AST node it points at, or the
 * {@link FileWithPath} for a whole-file reference, or `null`. The node-level core
 * shared by go-to-definition, the reference index, and rename.
 *
 * @param document the document the reference is written in.
 * @param node the reference value node.
 * @param cancellationToken stops the resolution.
 * @returns the target node or file, or null.
 */
export const resolveReferenceTarget = async (
    document: AbstractNodeDocument,
    node: ValueNode,
    cancellationToken: CancellationToken
): Promise<AbstractNode | FileWithPath | null> => {
    // A mod-action target (e.g. the `<cosmoteer.rules>/SW_COLORS` of an `OverrideIn`)
    // names a location in the effective game tree, not a path relative to the manifest:
    // it must be normalized to the canonical `<./Data/…>` form and resolved with the
    // mod's own additions layered on (so globals the mod inserts resolve). This mirrors
    // how the mod-action validator checks the same targets.
    return isActionTarget(document, node)
        ? await resolveWithModContext(normalizeTargetPath(String(node.valueType.value)), node, cancellationToken).catch(
              () => null
          )
        : await resolveWithPrefixFallback(node, document.uri, cancellationToken);
};

/**
 * Resolve a single reference value node to the {@link Location} of its definition
 * target the node-level core of go-to-definition, shared with the reference index
 * so that find-all-references buckets referrers under the same location go-to-def
 * would jump to.
 *
 * @param document the document the reference is written in.
 * @param node the reference value node.
 * @param cancellationToken stops the resolution.
 * @returns the location of the target, or null.
 */
export const resolveReferenceLocation = async (
    document: AbstractNodeDocument,
    node: ValueNode,
    cancellationToken: CancellationToken
): Promise<Location | null> => {
    const target = await resolveReferenceTarget(document, node, cancellationToken);
    if (!target) return null;

    if (isFile(target as FileTree)) {
        return { uri: filePathToUri((target as FileWithPath).path), range: ZERO_RANGE };
    }
    return definitionLocationOf(target as AbstractNode);
};
