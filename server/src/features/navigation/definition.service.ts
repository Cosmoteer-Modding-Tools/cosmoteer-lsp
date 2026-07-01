import { CancellationToken, Location, Position, Range } from 'vscode-languageserver';
import { AbstractNode, AbstractNodeDocument, isValueNode, ValueNode } from '../../core/ast/ast';
import { findNodeAtPosition, getStartOfAstNode } from '../../utils/ast.utils';
import { FileTree, FileWithPath, isFile } from '../../workspace/cosmoteer-workspace.service';
import { FullNavigationStrategy } from './full.navigation-strategy';
import { isAssetValue, resolveAssetPath } from './asset-resolver';
import { filePathToUri } from './navigation-strategy';
import { definitionLocationOf } from './reference-location';
import { resolveSchemaSiblingReference } from './schema-reference.navigation';
import {
    resolveSchemaIdReference,
    mapKeyReferenceAt,
    resolveIdReferenceTarget,
} from './schema-id-reference.navigation';
import { particleChannelAt, channelDefinitionSite } from './particle-channel';
import { isModRules } from '../../document/document-kind';
import { parseModActions } from '../../mod/action-parser';
import { normalizeTargetPath } from '../../mod/action-target-resolver';
import { resolveFromModContextOnly, resolveWithModContext } from '../../mod/mod-context';

const ZERO_RANGE = Range.create(0, 0, 0, 0);

export const isReferenceValue = (node: AbstractNode | null | undefined): node is ValueNode =>
    !!node && isValueNode(node) && node.valueType.type === 'Reference';

/**
 * Resolves go-to-definition (`textDocument/definition`) for reference values.
 *
 * The cursor's node is looked up in the cached AST. If it is a reference value
 * (`&Name`, `&../…`, `&<…>`, `/…`, inheritance refs, …) it is resolved with the
 * shared {@link FullNavigationStrategy} and the target is mapped to an LSP
 * {@link Location}. Cross-file targets carry an on-disk path, converted to a
 * `file://` URI via {@link filePathToUri}.
 */
export class DefinitionService {
    private static _instance: DefinitionService;
    private readonly navigation = new FullNavigationStrategy();

    private constructor() {}

    public static get instance(): DefinitionService {
        if (!DefinitionService._instance) {
            DefinitionService._instance = new DefinitionService();
        }
        return DefinitionService._instance;
    }

    public async getDefinition(
        document: AbstractNodeDocument,
        position: Position,
        cancellationToken: CancellationToken,
        folderPaths: string[] = []
    ): Promise<Location | null> {
        const node = findNodeAtPosition(document, position);
        if (isReferenceValue(node)) return this.resolveReferenceLocation(document, node, cancellationToken);
        // An asset value (`Sprite`/`Sound`/`Shader`) points at an on-disk file, not an AST node —
        // resolve it (relative to the file or any inherited asset base) and jump to that file.
        if (isAssetValue(node)) {
            const path = await resolveAssetPath(node, document.uri, cancellationToken).catch(() => null);
            return path ? { uri: filePathToUri(path), range: ZERO_RANGE } : null;
        }
        // A schema `ID<…>` sibling reference (e.g. `OperationalToggle = IsOperational`) is a bare
        // identifier, not a `&`-reference — resolve it via the schema to the sibling component group.
        const sibling = resolveSchemaSiblingReference(node);
        if (sibling) return definitionLocationOf(sibling);
        // A particle data channel use (`BIn = rot_vel`) jumps to where the channel is written
        // (`DataOut = rot_vel`) in the same file. A built-in channel with no in-file writer falls through.
        const channel = particleChannelAt(document, position);
        if (channel) {
            const site = channelDefinitionSite(document, channel.name);
            if (site) return definitionLocationOf(site.node);
        }
        // A cross-file `ID<X>` reference (e.g. `ResourceType = battery`) → the whole-file root that
        // declares it elsewhere in the project (the file whose root class is X with `ID = battery`).
        const idTarget = await resolveSchemaIdReference(node, folderPaths, cancellationToken).catch(() => null);
        if (idTarget) return idTarget;
        // A map-key reference (`MaxBuffValues = { Engine = … }`, `StatusResistances { fire = … }`):
        // the key identifier is an `ID<X>` reference. Detected by position (it is not a value node).
        const mapKey = mapKeyReferenceAt(document, position);
        return mapKey
            ? await resolveIdReferenceTarget(mapKey.targetClass, mapKey.value, folderPaths, cancellationToken).catch(
                  () => null
              )
            : null;
    }

    /**
     * Resolve a single reference value node to the {@link Location} of its definition
     * target the node-level core of go-to-definition, shared with the reference index
     * so that find-all-references buckets referrers under the same location go-to-def
     * would jump to.
     */
    public async resolveReferenceLocation(
        document: AbstractNodeDocument,
        node: ValueNode,
        cancellationToken: CancellationToken
    ): Promise<Location | null> {
        const target = await this.resolveReferenceTarget(document, node, cancellationToken);
        if (!target) return null;

        if (isFile(target as FileTree)) {
            return { uri: filePathToUri((target as FileWithPath).path), range: ZERO_RANGE };
        }
        return definitionLocationOf(target as AbstractNode);
    }

    /**
     * Resolve a reference value node to its target — the AST node it points at, or the
     * {@link FileWithPath} for a whole-file reference, or `null`. The node-level core
     * shared by go-to-definition, the reference index, and rename.
     */
    public async resolveReferenceTarget(
        document: AbstractNodeDocument,
        node: ValueNode,
        cancellationToken: CancellationToken
    ): Promise<AbstractNode | FileWithPath | null> {
        // A mod-action target (e.g. the `<cosmoteer.rules>/SW_COLORS` of an `OverrideIn`)
        // names a location in the effective game tree, not a path relative to the manifest:
        // it must be normalized to the canonical `<./Data/…>` form and resolved with the
        // mod's own additions layered on (so globals the mod inserts resolve). This mirrors
        // how the mod-action validator checks the same targets.
        return this.isActionTarget(document, node)
            ? await resolveWithModContext(
                  normalizeTargetPath(String(node.valueType.value)),
                  node,
                  cancellationToken
              ).catch(() => null)
            : await this.resolveWithPrefixFallback(node, document.uri, cancellationToken);
    }

    /**
     * True if `node` is a mod-action target value the `OverrideIn` / `AddTo` / `Replace`
     * / … path of an entry in a manifest's `Actions` list. Targets resolve against the
     * game Data root (with the mod's additions), unlike sources/normal refs which resolve
     * relative to the manifest, so they need the canonical-path + mod-context resolution.
     */
    private isActionTarget(document: AbstractNodeDocument, node: ValueNode): boolean {
        if (!isModRules(document.uri)) return false;
        return parseModActions(document).some((action) => action.targets.includes(node));
    }

    /**
     * Resolve a reference, falling back to its longest resolvable prefix when the full
     * path doesn't resolve. This makes go-to-definition land somewhere useful for
     * inherit-and-extend references whose final member is virtual e.g.,
     * `Toggles : ^/0/Toggles` has no concrete Toggles target, so we jump to what `^/0`
     * points at (the base being extended). A reference reached via a prefix is
     * dereferenced once to its concrete base group rather than the `^/N/X` text.
     */
    private async resolveWithPrefixFallback(
        node: ValueNode,
        uri: string,
        cancellationToken: CancellationToken
    ): Promise<AbstractNode | FileWithPath | null> {
        const value = String(node.valueType.value);
        // Full path against vanilla first.
        let target = (await this.navigation.navigate(value, node, uri, cancellationToken).catch(() => null)) as
            AbstractNode | FileWithPath | null;
        // Then the mod's effective tree, for a member the mod merges into a vanilla file the
        // reference reaches through a vanilla global (`&/INDICATORS/SWX` → the mod's indicators
        // override). Done before the prefix walk below, which would otherwise stop at the global's
        // own file (the prefix `/INDICATORS`) and land go-to-def on the vanilla file, not the member.
        if (!target) {
            const modTarget = await resolveFromModContextOnly(value, node, cancellationToken).catch(() => null);
            if (modTarget) return modTarget;
        }
        let path = value;
        while (!target) {
            const lastSlash = path.lastIndexOf('/');
            const prefix = lastSlash > 0 ? path.slice(0, lastSlash) : '';
            // Dead-end: no meaningful prefix is left — empty, or only a sigil (`&`, `/`,
            // `&/`). A bare `&` would spuriously resolve to the bearer's own scope and mask
            // the real target, so we must stop before that. Vanilla navigation is exhausted;
            // inside a mod, a super-path / file ref (`&/SW_COLORS/Lime/RGBA`,
            // `<cosmoteer.rules>/SW_X`) may point at a global the mod itself inserts, which
            // exists only in its effective tree. Resolve the full reference there, mirroring
            // how the value validator resolves `&/SW_X/…`.
            if (!prefix || /^[&/]+$/.test(prefix)) {
                return await resolveFromModContextOnly(value, node, cancellationToken).catch(() => null);
            }
            path = prefix;
            target = (await this.navigation.navigate(path, node, uri, cancellationToken).catch(() => null)) as
                AbstractNode | FileWithPath | null;
        }
        if (path !== value && isReferenceValue(target as AbstractNode)) {
            const ref = target as ValueNode;
            const deref = await this.navigation
                .navigate(String(ref.valueType.value), ref, getStartOfAstNode(ref).uri, cancellationToken)
                .catch(() => null);
            if (deref && !isFile(deref as FileTree)) target = deref as AbstractNode;
        }
        return target;
    }
}
