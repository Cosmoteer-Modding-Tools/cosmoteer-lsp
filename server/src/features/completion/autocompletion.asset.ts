import { CancellationToken } from 'vscode-languageserver';
import { AbstractNode, isAssignmentNode, isDocumentNode, isGroupNode, isValueNode, ValueNode } from '../../core/ast/ast';
import { AutoCompletion, Completion } from './autocompletion.service';
import { AssetAutoCompletionStrategy, AssetType } from './strategy/asset.autocompletion-strategy';
import { resolveGroupClass } from '../../document/schema/schema-context';
import { documentRootClass } from '../../document/schema/document-root';
import { fieldOf } from '../../document/schema/schema';

const assetAutoCompletionStrategy = new AssetAutoCompletionStrategy();

/** The asset value-type kind a schema `assetKind` maps to (for the strategy's extension filter). */
const ASSET_TYPE_BY_KIND: Record<string, AssetType> = { image: 'Sprite', sound: 'Sound', shader: 'Shader' };

/**
 * The schema asset type of the field a value fills, when the schema knows it independently of the
 * value text. This is what lets completion offer same-folder assets while the path is still being
 * typed (a bare `particle_l` with no extension yet). Two shapes are recognised:
 *  - a direct asset field (`Shader = …`, a sprite's `File = …`), and
 *  - the dual-form group: a `File` inside a `Shader { … }` / `Texture { … }` group whose own slot is
 *    an asset (the group form of a `Shader`/`Texture` asset field) — so `File` there inherits the
 *    group's asset kind even though the group itself carries no schema class for it.
 */
const schemaAssetType = (node: ValueNode): AssetType | undefined => {
    const classOf = (n: AbstractNode | null | undefined): string | undefined =>
        n && isDocumentNode(n) ? documentRootClass(n) : n && isGroupNode(n) ? resolveGroupClass(n) : undefined;

    // The value's parent is its containing group (the parser links values to the group, not the
    // assignment), so recover the field name from the assignment whose value this is.
    const container = node.parent;
    if (!container || !(isGroupNode(container) || isDocumentNode(container))) return undefined;
    const owner = container.elements.find((element) => isAssignmentNode(element) && element.right === node);
    const fieldName = owner && isAssignmentNode(owner) ? owner.left.name : undefined;
    if (!fieldName) return undefined;

    const direct = classOf(container) ? fieldOf(classOf(container)!, fieldName)?.valueType : undefined;
    if (direct?.kind === 'asset') return ASSET_TYPE_BY_KIND[direct.assetKind];

    // Group form: `File` inside a `Shader { … }` / `Texture { … }` group standing in an asset slot.
    if (fieldName === 'File' && isGroupNode(container) && container.identifier) {
        const slot = classOf(container.parent)
            ? fieldOf(classOf(container.parent)!, container.identifier.name)?.valueType
            : undefined;
        if (slot?.kind === 'asset') return ASSET_TYPE_BY_KIND[slot.assetKind];
    }
    return undefined;
};

/**
 * A still-extension-less String that already looks like a path (contains a `/`, or starts a
 * relative/`./Data` path), worth offering asset completions for only when quoted — the look-alike
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
 * field is an asset (so same-folder files are offered mid-typing, before the extension is present —
 * filtered to that asset's kind), or when the value itself already looks like an asset path (an
 * already-classified `.shader`/`.png`/`.wav` extension, or a quoted relative path).
 */
export class AutoCompletionAsset implements AutoCompletion<ValueNode> {
    public async getCompletions(node: ValueNode, cancellationToken: CancellationToken): Promise<Completion[]> {
        if (!isValueNode(node)) return [];
        const assetType = schemaAssetType(node);
        if (assetType) {
            return await assetAutoCompletionStrategy.complete({ node, cancellationToken, assetType }).catch(() => []);
        }
        if (looksLikeAssetPath(node)) {
            return await assetAutoCompletionStrategy.complete({ node, cancellationToken }).catch(() => []);
        }
        return [];
    }
}
