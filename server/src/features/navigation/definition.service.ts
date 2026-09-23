import { CancellationToken, Location, Position } from 'vscode-languageserver';
import { AbstractNode, AbstractNodeDocument, ValueNode } from '../../core/ast/ast';
import { findNodeAtPosition } from '../../utils/ast.utils';
import { warmInheritedClasses } from '../completion/inheritance-resolution';
import { FileTree, isFile } from '../../workspace/cosmoteer-workspace.service';
import { navigate } from '../../semantics/navigate-reference';
import { isAssetValue, resolveAssetPath } from './asset-resolver';
import { filePathToUri, stripReferenceWhitespace } from '../../document/reference-path';
import { isReferenceValue, resolveReferenceLocation, ZERO_RANGE } from './reference-target';
import { dedupeLocations, definitionLocationOf } from '../../document/reference-location';
import { splitVirtualColon } from '../../utils/reference.utils';
import { resolveVirtualInheritanceTargets } from '../../semantics/inheritor-resolver';
import { resolveSchemaSiblingReference } from './schema-reference.navigation';
import { componentDeclarationAt } from './rename-component-id';
import { resolvePartComponentDeclaration } from '../diagnostics/validator.schema-sibling';
import {
    resolveSchemaIdReference,
    mapKeyReferenceAt,
    resolveIdReferenceTarget,
} from './schema-id-reference.navigation';
import { particleChannelAt, channelDefinitionSite } from './particle-channel';
import { resolveLocalizationKeyDefinition } from './localization-key.navigation';

/**
 * Resolves go-to-definition (`textDocument/definition`) for reference values.
 *
 * The cursor's node is looked up in the cached AST. If it is a reference value
 * (`&Name`, `&../…`, `&<…>`, `/…`, inheritance refs, …) it is resolved with the
 * shared {@link navigate} and the target is mapped to an LSP
 * {@link Location}. Cross-file targets carry an on-disk path, converted to a
 * `file://` URI via {@link filePathToUri}.
 */
export const getDefinition = async (
    document: AbstractNodeDocument,
    position: Position,
    cancellationToken: CancellationToken,
    folderPaths: string[] = []
): Promise<Location | Location[] | null> => {
    // An id written inside a group deriving from a base in another file is typed only once
    // that group's class is known to the synchronous schema lookups.
    await warmInheritedClasses(document, cancellationToken).catch(() => undefined);
    const node = findNodeAtPosition(document, position);
    if (isReferenceValue(node)) {
        const primary = await resolveReferenceLocation(document, node, cancellationToken);
        // A virtual-inheritance path (`&Base/:/Member`) also points at the concrete overrides, the
        // "most-derived version" the `:` selects at runtime. Offer those alongside the base's own
        // (default) declaration `primary` lands on, so go-to-definition reaches the deriving values.
        const overrides = await resolveVirtualOverrides(document, node, cancellationToken).catch(() => []);
        if (overrides.length) {
            return dedupeLocations(primary ? [primary, ...overrides] : overrides);
        }
        return primary;
    }
    // An asset value (`Sprite`/`Sound`/`Shader`) points at an on-disk file, not an AST node.
    // Resolve it relative to the file, the way the game does, and jump to that file.
    if (isAssetValue(node)) {
        const path = await resolveAssetPath(node, document.uri, cancellationToken).catch(() => null);
        return path ? { uri: filePathToUri(path), range: ZERO_RANGE } : null;
    }
    // A schema `ID<…>` sibling reference (e.g. `OperationalToggle = IsOperational`) is a bare
    // identifier, not a `&`-reference. Resolve it via the schema to the sibling component group.
    const sibling = resolveSchemaSiblingReference(node);
    if (sibling) return definitionLocationOf(sibling);
    // The same id written in a slot the sibling resolution does not type: a field of the `Part` group
    // itself, a bare list element, a group written as a list element. The engine resolves all of them
    // part-wide, so the declaration is looked for in the part the slot sits in.
    const component = componentDeclarationAt(node);
    if (component) return definitionLocationOf(component);
    // The same-file search missed: a component declared in an inherited base part, an include or
    // an override target still resolves through the part-wide walk validation and completion use.
    const partWide = await resolvePartComponentDeclaration(node, cancellationToken).catch(() => undefined);
    if (partWide) return definitionLocationOf(partWide);
    // A particle data channel use (`BIn = rot_vel`) jumps to where the channel is written
    // (`DataOut = rot_vel`) in the same file. A built-in channel with no in-file writer falls through.
    const channel = particleChannelAt(document, position);
    if (channel) {
        const site = channelDefinitionSite(document, channel.name);
        if (site) return definitionLocationOf(site.node);
    }
    // A localization key (`NameKey = "Parts/Foo"`) names a path into the strings files, so it
    // jumps to where each language declares it rather than to any rules node.
    const keyTargets = await resolveLocalizationKeyDefinition(node, folderPaths, cancellationToken).catch(() => null);
    if (keyTargets?.length) return keyTargets;
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
};

/**
 * The definition locations of the concrete overrides a virtual-inheritance reference (`&Base/:/Member`)
 * points at: the member's value in every group that inherits the base. Empty for a reference with no
 * `:` segment, an unresolvable base, or a base no file inherits yet (a template awaiting a deriver).
 *
 * @param document the document the reference lives in, the base-resolution origin.
 * @param node the reference value node under the cursor.
 * @param cancellationToken cancels the base resolution and the inheritor search.
 * @returns the override locations, or an empty array.
 */
const resolveVirtualOverrides = async (
    document: AbstractNodeDocument,
    node: ValueNode,
    cancellationToken: CancellationToken
): Promise<Location[]> => {
    const split = splitVirtualColon(stripReferenceWhitespace(String(node.valueType.value)));
    if (!split) return [];
    // Resolve the node before the `:` to the base it names. A bare `&:/…` (the group's own
    // most-derived self) has no explicit base path, so fall back to the reference's own scope.
    const base = split.basePath.replace(/^&$/, '')
        ? await navigate(split.basePath, node, document.uri, cancellationToken).catch(() => null)
        : (node.parent ?? null);
    if (!base || isFile(base as FileTree)) return [];
    const targets = await resolveVirtualInheritanceTargets(base as AbstractNode, split.memberPath, cancellationToken);
    return targets.map(definitionLocationOf);
};
