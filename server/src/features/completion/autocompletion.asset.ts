import { CancellationToken, Position } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    GroupNode,
    isAssignmentNode,
    isDocumentNode,
    isGroupNode,
    isListNode,
    isValueNode,
    ValueNode,
} from '../../core/ast/ast';
import { AutoCompletion, Completion } from './autocompletion.service';
import { AssetAutoCompletionStrategy, AssetType } from './strategy/asset.autocompletion-strategy';
import { documentScopeClass, findEnclosingContainer } from '../../document/schema/schema-context';
import { fieldOf } from '../../document/schema/schema';
import { resolveClassThroughInheritance } from './inheritance-resolution';

const assetAutoCompletionStrategy = new AssetAutoCompletionStrategy();

/** The asset value-type kind a schema `assetKind` maps to (for the strategy's extension filter). */
const ASSET_TYPE_BY_KIND: Record<string, AssetType> = { image: 'Sprite', sound: 'Sound', shader: 'Shader' };

/**
 * The schema asset type of the field a value fills, when the schema knows it independently of the
 * value text. This is what lets completion offer same-folder assets while the path is still being
 * typed (a bare `particle_l` with no extension yet). Three shapes are recognised:
 *  - a direct asset field (`Shader = …`, a sprite's `File = …`),
 *  - an element of a list of assets (`RandomSounds = ["…"]`), typed by the list's element kind, and
 *  - the dual-form group: a `File` inside a `Shader { … }` / `Texture { … }` group whose own slot is
 *    an asset (the group form of a `Shader`/`Texture` asset field), so `File` there inherits the
 *    group's asset kind even though the group itself carries no schema class for it.
 * The containing group's class is resolved through cross-file inheritance as well, since a group
 * such as `CrewEnterEffects : /BASE_SOUNDS/AudioInterior` redeclares no `Type =` of its own.
 *
 * @param node the value whose field is asked for.
 * @param cancellationToken stops the cross-file class resolution.
 * @returns the asset kind of the field, or undefined when the schema does not type it as one.
 */
const schemaAssetType = async (node: ValueNode, cancellationToken: CancellationToken): Promise<AssetType | undefined> => {
    const classOf = async (n: AbstractNode | null | undefined): Promise<string | undefined> =>
        n && isDocumentNode(n)
            ? documentScopeClass(n)
            : n && isGroupNode(n)
              ? await resolveClassThroughInheritance(n, cancellationToken).catch(() => undefined)
              : undefined;

    // An element of a list (`RandomSounds = ["…", "…"]`) fills the list's field, so the field is
    // read off the list: its owning assignment, or its own name in the `RandomSounds [ … ]` form.
    // Elsewhere the value's parent is its containing group (the parser links values to the group,
    // not the assignment), so recover the field name from the assignment whose value this is.
    const list = isListNode(node.parent) ? node.parent : undefined;
    const filler: AbstractNode = list ?? node;
    const container = filler.parent;
    if (!container || !(isGroupNode(container) || isDocumentNode(container))) return undefined;
    const owner = container.elements.find((element) => isAssignmentNode(element) && element.right === filler);
    const fieldName = owner && isAssignmentNode(owner) ? owner.left.name : list?.identifier?.name;
    if (!fieldName) return undefined;

    const containerClass = await classOf(container);
    const direct = containerClass ? fieldOf(containerClass, fieldName)?.valueType : undefined;
    if (list) {
        if (direct?.kind === 'list' && direct.element.kind === 'asset') return ASSET_TYPE_BY_KIND[direct.element.assetKind];
        return undefined;
    }
    if (direct?.kind === 'asset') return ASSET_TYPE_BY_KIND[direct.assetKind];

    // Group form: `File` inside a `Shader { … }` / `Texture { … }` group standing in an asset slot.
    if (fieldName === 'File' && isGroupNode(container) && container.identifier) {
        const outerClass = await classOf(container.parent);
        const slot = outerClass ? fieldOf(outerClass, container.identifier.name)?.valueType : undefined;
        if (slot?.kind === 'asset') return ASSET_TYPE_BY_KIND[slot.assetKind];
    }
    return undefined;
};

/** A quoted value still being typed, whose opening quote is the last one on the line. The parser
 *  produces no value node for it, so the asset path can only be completed off the written line. */
const OPEN_QUOTED_VALUE = /(?:^|[\s{;[])([A-Za-z_]\w*)\s*=\s*"([^"]*)$/;

/**
 * Asset-path completions at a value whose opening quote is not closed yet (`File = "sprites/<cursor>`).
 *
 * The node-based completer needs a value node, and an unclosed quote produces none, so an asset path
 * offered nothing until the closing quote was written. The field is typed from the line and the
 * schema instead, the same two shapes the node path recognises: a direct asset field, and the `File`
 * of a `Texture { … }` / `Shader { … }` group standing in an asset slot.
 *
 * @param document the parsed document being edited.
 * @param offset the cursor byte offset.
 * @param linePrefix the current line's text up to the cursor.
 * @param position the cursor position, for the replace range.
 * @param cancellationToken cancels the class resolution and the directory listing.
 * @returns the asset completions, or undefined when the position is no open-quoted asset value.
 */
export const assetCompletionsAtOffset = async (
    document: AbstractNodeDocument,
    offset: number,
    linePrefix: string,
    position: Position,
    cancellationToken: CancellationToken
): Promise<Completion[] | undefined> => {
    const match = OPEN_QUOTED_VALUE.exec(linePrefix);
    if (!match) return undefined;
    const [, fieldName, typed] = match;
    const container = findEnclosingContainer(document, offset);
    if (!container || !isGroupNode(container)) return undefined;
    const assetType = await assetTypeOfField(container, fieldName, cancellationToken);
    if (!assetType) return undefined;
    const node: ValueNode = {
        type: 'Value',
        valueType: { type: 'String', value: typed },
        quoted: true,
        parent: container as ValueNode['parent'],
        position: { line: position.line, characterStart: 0, characterEnd: 0, start: offset, end: offset },
    };
    const completions = await assetAutoCompletionStrategy
        .complete({ node, cancellationToken, assetType })
        .catch(() => []);
    // The labels are one path segment, so the pick replaces the segment being typed and nothing of
    // the directories already written.
    const segment = typed.slice(typed.lastIndexOf('/') + 1);
    const range = {
        start: { line: position.line, character: Math.max(0, position.character - segment.length) },
        end: position,
    };
    return completions.map((completion) =>
        typeof completion === 'string' ? { label: completion, range } : { ...completion, range }
    );
};

/**
 * The asset kind of a field written in a group, for the offset-based path.
 *
 * @param container the group the value is written in.
 * @param fieldName the field being assigned.
 * @param cancellationToken cancels the cross-file class resolution.
 * @returns the asset kind, or undefined when the schema does not type the field as an asset.
 */
const assetTypeOfField = async (
    container: GroupNode,
    fieldName: string,
    cancellationToken: CancellationToken
): Promise<AssetType | undefined> => {
    const containerClass = await resolveClassThroughInheritance(container, cancellationToken).catch(() => undefined);
    const direct = containerClass ? fieldOf(containerClass, fieldName)?.valueType : undefined;
    if (direct?.kind === 'asset') return ASSET_TYPE_BY_KIND[direct.assetKind];
    if (direct?.kind === 'list' && direct.element.kind === 'asset') return ASSET_TYPE_BY_KIND[direct.element.assetKind];
    // Group form: `File` inside a `Shader { … }` / `Texture { … }` group standing in an asset slot.
    if (fieldName === 'File' && container.identifier) {
        const outer = container.parent;
        const outerClass = outer && isDocumentNode(outer)
            ? documentScopeClass(outer)
            : outer && isGroupNode(outer)
              ? await resolveClassThroughInheritance(outer, cancellationToken).catch(() => undefined)
              : undefined;
        const slot = outerClass ? fieldOf(outerClass, container.identifier.name)?.valueType : undefined;
        if (slot?.kind === 'asset') return ASSET_TYPE_BY_KIND[slot.assetKind];
    }
    return undefined;
};

/**
 * A still-extension-less String that already looks like a path (contains a `/`, or starts a
 * relative/`./Data` path), worth offering asset completions for only when quoted. The look-alike
 * gate keeps completion off ordinary string fields such as display names.
 */
const looksLikeAssetPath = (node: ValueNode): boolean => {
    const type = node.valueType.type;
    if (type === 'Sprite' || type === 'Sound' || type === 'Shader') return true;
    if (type !== 'String' || !node.quoted) return false;
    const value = String(node.valueType.value);
    return value.includes('/') || value.startsWith('.');
};

/**
 * Offers asset-path completions for a value that is an asset path. Fires when the schema knows the
 * field is an asset (so same-folder files are offered mid-typing, before the extension is present,
 * filtered to that asset's kind), or when the value itself already looks like an asset path (an
 * already-classified `.shader`/`.png`/`.wav` extension, or a quoted relative path).
 */
export class AutoCompletionAsset implements AutoCompletion<ValueNode> {
    public async getCompletions(node: ValueNode, cancellationToken: CancellationToken): Promise<Completion[]> {
        if (!isValueNode(node)) return [];
        const assetType = await schemaAssetType(node, cancellationToken);
        if (assetType) {
            return await assetAutoCompletionStrategy.complete({ node, cancellationToken, assetType }).catch(() => []);
        }
        if (looksLikeAssetPath(node)) {
            return await assetAutoCompletionStrategy.complete({ node, cancellationToken }).catch(() => []);
        }
        return [];
    }
}
