import { CancellationToken, Hover, MarkupKind, Position } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    isListNode,
    isGroupNode,
    isValueNode,
    ValueNode,
} from '../../core/ast/ast';
import { DefinitionService, isReferenceValue } from '../navigation/definition.service';
import { isAssetValue, resolveAssetPath } from '../navigation/asset-resolver';
import { filePathToUri } from '../navigation/navigation-strategy';
import { findReferenceTargetAtPosition } from '../navigation/reference-index';
import { resolveSchemaSiblingReference } from '../navigation/schema-reference.navigation';
import { resolvePartComponentDeclaration } from '../diagnostics/validator.schema-sibling';
import { resolveSchemaIdReference } from '../navigation/schema-id-reference.navigation';
import { evaluateNumericValue, formatNumber } from '../../semantics/value-evaluator';
import { FileWithPath, isFile } from '../../workspace/cosmoteer-workspace.service';
import { schemaDiscriminatorHover, schemaFieldHover } from './schema-hover';
import { resolveClassThroughInheritance } from '../completion/inheritance-resolution';
import { decompilerHoverLink } from './decompiler-link';
import { shaderConstantHover } from '../shader/shader-hover';
import { localizationKeyHover } from './localization-key-hover';

/**
 * Hover (`textDocument/hover`) showing what a node resolves to. The single biggest
 * pain in `.rules` is that you can't see a value's effective result without tracing references
 * and inheritance by hand. Over a value (or the key whose value it is) this shows its
 * computed number, if it evaluates (math, or a reference chain ending in a number), and,
 * for a reference, what it points at (the target's literal value or group).
 *
 * Reuses the shared {@link evaluateNumericValue} (which already follows inheritance), so an
 * inherited / overridden field hovers as its effective value.
 */
export class HoverService {
    private static _instance: HoverService;
    private constructor() {}

    public static get instance(): HoverService {
        if (!HoverService._instance) {
            HoverService._instance = new HoverService();
        }
        return HoverService._instance;
    }

    public async getHover(
        document: AbstractNodeDocument,
        position: Position,
        cancellationToken: CancellationToken,
        folderPaths: string[] = []
    ): Promise<Hover | null> {
        const node = findReferenceTargetAtPosition(document, position);
        if (!node) return null;

        const lines: string[] = [];

        const numeric = await evaluateNumericValue(node, cancellationToken).catch(() => null);
        if (numeric !== null) lines.push(`**= ${formatNumber(numeric)}**`);

        // For a reference, also surface what it points at (useful when the target isn't numeric).
        if (isReferenceValue(node)) {
            const target = await DefinitionService.instance
                .resolveReferenceTarget(document, node, cancellationToken)
                .catch(() => null);
            const described = target && !isFile(target as FileWithPath) ? describeTarget(target as AbstractNode) : null;
            if (described) lines.push(`→ ${described}`);
        } else {
            // A schema `ID<>` reference written as a bare id: a sibling component (same file), a
            // part-wide component (an inherited base, an include, an override target) or a
            // cross-file whole-file root. Surface where it resolves, just like a `&`-reference.
            const sibling =
                resolveSchemaSiblingReference(node) ??
                (await resolvePartComponentDeclaration(node, cancellationToken).catch(() => undefined));
            if (sibling) {
                const described = describeTarget(sibling);
                if (described) lines.push(`→ ${described}`);
            } else {
                const idLocation = await resolveSchemaIdReference(node, folderPaths, cancellationToken).catch(() => null);
                if (idLocation) lines.push(`→ defined in \`${idLocation.uri.split('/').pop()}\``);
            }
        }

        // For an asset, show whether it resolves on disk and, for a sprite, a preview image.
        if (isAssetValue(node)) {
            lines.push(await describeAsset(node, document.uri, cancellationToken));
        }

        // For a localization key (`NameKey = "Parts/Foo"`), show its translated text per language.
        const localizationInfo = await localizationKeyHover(node, folderPaths, cancellationToken).catch(() => null);
        if (localizationInfo) lines.push(localizationInfo);

        // An inline shader-constant key, enriched from the referenced `.shader` (its HLSL type and
        // default). Falls back to the generic schema description below when the shader can't be read.
        const shaderInfo = await shaderConstantHover(node, document.uri, cancellationToken).catch(() => null);

        // Schema documentation for the field this node belongs to (type / required / enum / default).
        // The container's class resolves through cross-file inheritance too (`: /BASE_SOUNDS/…`
        // groups redeclare no `Type=`), which the sync resolution inside schemaFieldHover can't
        // reach. Resolve it here (the sync answer comes back first when it exists) and pass it in.
        const container = node.parent;
        const containerClass =
            container && isGroupNode(container)
                ? await resolveClassThroughInheritance(container, cancellationToken).catch(() => undefined)
                : undefined;
        const schemaInfo = shaderInfo ?? schemaFieldHover(node, containerClass);
        if (schemaInfo) lines.push(schemaInfo);

        // For a `Type = <disc>` value, show the concrete class the discriminator selects.
        const discriminatorInfo = schemaDiscriminatorHover(node);
        if (discriminatorInfo) lines.push(discriminatorInfo);

        if (lines.length === 0) return null;

        // Opt-in power-user footer: a link opening the owning C# schema class in the user's .NET
        // decompiler. Only added to a hover that already has content, so the feature never makes a
        // popup appear where there would otherwise be none.
        const decompilerLink = decompilerHoverLink(node);
        if (decompilerLink) lines.push(decompilerLink);

        return { contents: { kind: MarkupKind.Markdown, value: lines.join('\n\n') } };
    }
}

/**
 * Markdown for an asset value: its kind, whether it resolves on disk, the path, and for a
 * sprite an inline preview of the image (rendered by clients that support images in hovers).
 */
const describeAsset = async (
    node: ValueNode,
    uri: string,
    cancellationToken: CancellationToken
): Promise<string> => {
    const kind = node.valueType.type;
    const value = String(node.valueType.value);
    const path = await resolveAssetPath(node, uri, cancellationToken).catch(() => null);
    const lines = [path ? `**${kind}** ✓ found` : `**${kind}** ✗ not found`, `\`${value}\``];
    if (path && kind === 'Sprite') lines.push(`![preview](${filePathToUri(path)})`);
    return lines.join('\n\n');
};

/** A short human-readable description of a resolved target node. */
const describeTarget = (node: AbstractNode): string | null => {
    if (isValueNode(node)) {
        const value = (node as ValueNode).valueType.value;
        return `\`${String(value)}\``;
    }
    if (isGroupNode(node)) return node.identifier ? `group \`${node.identifier.name}\`` : 'group `{ … }`';
    if (isListNode(node)) return node.identifier ? `list \`${node.identifier.name}\`` : 'list `[ … ]`';
    return null;
};
