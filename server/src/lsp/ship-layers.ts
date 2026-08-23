import { CancellationToken } from 'vscode-languageserver/node';
import { AbstractNodeDocument, isGroupNode, isValueNode } from '../core/ast/ast';
import { namedMembersOf } from '../utils/ast.utils';
import { Completion } from '../features/completion/autocompletion.service';
import { ShipLayerContext, invalidateShipLayers, judgeLayer, layerScopeForPart } from '../features/ships/ship-layer.index';
import { CosmoteerWorkspaceService } from '../workspace/cosmoteer-workspace.service';
import { basenameOf, isManifestBasename } from '../document/document-kind';
import { uriToFsPath } from '../features/navigation/workspace-files';
import { searchFolderPaths } from './workspace-folders';

/**
 * Drops the ship-layer index when the file that changed could have moved a ship's layer set: the
 * ship files themselves and the manifests that add to them. A part file cannot, and parts are what
 * an editing session touches, so the index survives ordinary typing.
 *
 * @param uri the document or watched file that changed.
 */
export const invalidateShipLayersFor = (uri: string): void => {
    const lower = uri.toLowerCase();
    if (isManifestBasename(basenameOf(lower)) || lower.includes('/ships/') || lower.endsWith('cosmoteer.rules')) {
        invalidateShipLayers();
    }
};

/** The class a layer reference targets, the one completion narrows to the drawing ship's own set. */
const SHIP_RENDER_LAYER_CLASS = 'Cosmoteer.Ships.ShipRenderLayerRules';

/**
 * Narrows render-layer suggestions to the layers the ship that draws this file declares. Layers are
 * per ship class and the game throws on one the ship does not have, so offering the whole project's
 * pool would offer values that crash. Every other reference class is handed back untouched, and so is
 * a file no ship claims, where the union is the honest answer.
 *
 * @param completions the suggestions the id index produced.
 * @param targetClass the class the field being completed references.
 * @param uri the document being edited.
 * @param parserResult that document, parsed, whose top-level group names the part or ship.
 * @param cancellationToken cancels the ship reads.
 * @returns the narrowed suggestions, or the originals when there is no scope to narrow to.
 */
export const scopedToShipLayers = async (
    completions: Completion[],
    targetClass: string | undefined,
    uri: string,
    parserResult: AbstractNodeDocument,
    cancellationToken: CancellationToken
): Promise<Completion[]> => {
    if (targetClass !== SHIP_RENDER_LAYER_CLASS || completions.length === 0) return completions;
    const fsPath = uriToFsPath(uri);
    const group = parserResult.elements.find((element) => isGroupNode(element) && !!element.identifier);
    const groupName = group && isGroupNode(group) ? group.identifier?.name : undefined;
    if (!fsPath || !group || !isGroupNode(group) || !groupName) return completions;
    // The declared id scopes a part copied out of the game data, which no ship's list names by path.
    const declaredId = namedMembersOf(group).find(([name]) => name.toLowerCase() === 'id')?.[1];
    const partId =
        declaredId && isValueNode(declaredId) ? String(declaredId.valueType.value).trim() || undefined : undefined;
    const scope = await layerScopeForPart(
        fsPath,
        groupName,
        await shipLayerContext(),
        cancellationToken,
        partId
    ).catch(() => undefined);
    if (!scope || scope.ships.length === 0) return completions;
    const narrowed = completions.filter((completion) => {
        const label = typeof completion === 'string' ? completion : completion.label;
        return judgeLayer(scope, label) === 'accepted';
    });
    // A scope that filters everything away would leave the user with nothing to pick, which is worse
    // than an unnarrowed list, so the full set stands in that case.
    return narrowed.length > 0 ? narrowed : completions;
};

/**
 * The inputs the ship-layer index is built from: the game's own root file, which holds the ship
 * registry, and the workspace folders whose mods may add ships, layers or parts.
 *
 * @returns the context, with an absent root when the game path is unset.
 */
export const shipLayerContext = async (): Promise<ShipLayerContext> => {
    const root = await CosmoteerWorkspaceService.instance.getCosmoteerRules().catch(() => undefined);
    return {
        gameRootDocument: (root?.content as { parsedDocument?: AbstractNodeDocument } | undefined)?.parsedDocument,
        gameRootPath: root?.path,
        folderPaths: await searchFolderPaths().catch(() => []),
    };
};
