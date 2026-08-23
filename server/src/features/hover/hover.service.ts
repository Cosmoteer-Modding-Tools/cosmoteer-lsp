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
import { evaluateNumericValueTraced } from '../../semantics/value-evaluator';
import { formatWithUnit, unitForValue } from '../../semantics/value-units';
import { FileWithPath, isFile } from '../../workspace/cosmoteer-workspace.service';
import { schemaDiscriminatorHover, schemaFieldHover } from './schema-hover';
import { resolveClassThroughInheritance } from '../completion/inheritance-resolution';
import { decompilerHoverLink } from './decompiler-link';
import { shaderConstantHover } from '../shader/shader-hover';
import { localizationKeyHover } from './localization-key-hover';
import { substitutionTraceMarkdown } from './substitution-trace';
import { modifierTraceMarkdown } from './modifier-trace';
import { provenanceMarkdown } from './provenance-trace';
import { describeTargetMarkdown } from './target-preview';

/**
 * Hover (`textDocument/hover`) showing what a node resolves to. The single biggest
 * pain in `.rules` is that you can't see a value's effective result without tracing references
 * and inheritance by hand. Over a value (or the key whose value it is) this shows its
 * computed number, if it evaluates (math, or a reference chain ending in a number), and,
 * for a reference, what it points at (the target's literal value or group). Under the number it
 * also lists what each reference the evaluation substituted stood for and where that number was
 * read from, the step the game's own evaluator performs before it does the arithmetic. Over a
 * modifiable value it lists the modifiers folded onto the base number and the parts supplying the
 * buffs that drive them.
 *
 * Reuses the shared {@link evaluateNumericValueTraced} (which already follows inheritance), so an
 * inherited / overridden field hovers as its effective value. Under that it says where the
 * declaration stands in its group's chain: the value it replaces, and for a group how much of its
 * member set its bases supply.
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

        const traced = await evaluateNumericValueTraced(node, cancellationToken).catch(() => ({
            value: null,
            substitutions: [],
            omitted: 0,
        }));
        if (traced.value !== null) {
            const unit = await unitForValue([node], cancellationToken).catch(() => undefined);
            lines.push(`**= ${formatWithUnit(traced.value, unit)}**`);
            // Pushed right after the number, so the references it substituted read as its working.
            const trace = substitutionTraceMarkdown(document.uri, traced);
            if (trace) lines.push(trace);
        }

        // For a modifiable value, the rest of its working: what each modifier does to the base
        // number, and which part supplies the buff driving it. The file shows the base value alone,
        // and the supplying component usually lives in a different part entirely.
        const modifiers = await modifierTraceMarkdown(node, folderPaths, cancellationToken).catch(() => null);
        if (modifiers) lines.push(modifiers);

        // For a reference, also surface what it points at (useful when the target isn't numeric).
        if (isReferenceValue(node)) {
            const target = await DefinitionService.instance
                .resolveReferenceTarget(document, node, cancellationToken)
                .catch(() => null);
            // A whole-file target is named rather than skipped: `Bullet = &<…/bullet_med.rules>` is
            // one of the commonest references there is, and it used to hover with nothing at all.
            const described = target ? describeTargetMarkdown(target as AbstractNode | FileWithPath) : null;
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

        // Where this declaration stands in its group's inheritance chain: the value it replaces, and
        // for a group how much of its member set comes from its bases. The last fact about this
        // particular line, before the generic schema tail below.
        const provenance = await provenanceMarkdown(node, document.uri, cancellationToken).catch(() => null);
        if (provenance) lines.push(provenance);

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
const describeTarget = (node: AbstractNode): string | null => describeTargetMarkdown(node);
