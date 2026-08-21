import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    GroupNode,
    ValueNode,
    isGroupNode,
    isListNode,
    isValueNode,
} from '../../core/ast/ast';
import { SELF_KEYED_MAP_FIELDS } from '../../document/schema/entity-schema';
import { fieldOf } from '../../document/schema/schema';
import { declaringFieldOf, schemaReferenceFieldOf } from '../navigation/schema-id-reference.navigation';
import { stringValueNodesOf } from '../navigation/schema-reference.navigation';
import { namedMembersOf } from '../../utils/ast.utils';
import { uriToFsPath } from '../navigation/workspace-files';
import { PartLayerScope, ShipLayerContext, judgeLayer, layerScopeForPart } from '../ships/ship-layer.index';
import { ValidationError } from './validator';
import * as l10n from '@vscode/l10n';

/**
 * Whole-document pass: a sprite naming a render layer the ship that draws it does not declare.
 *
 * The game reads the layer in `ShipRenderer.GetLayerQuads`, which indexes the ship's own map,
 * `Ship.Rules.RenderLayers[layerID]`. The indexer sits inside a `try` that logs `Layer ID: <id>` and
 * rethrows, so a layer the ship has not declared is not an invisible sprite: it throws the first
 * time the part is drawn. Nothing in the file says so, which is why this check exists.
 *
 * Layers are per ship class, not one pool. The game's own classes declare 19 (terran), 2 (asteroid)
 * and 1 (megaroid), so an asteroid layer written on a terran part throws exactly like an invented
 * one. Both are reported, with different wording: an unknown layer is a typo, a foreign one names a
 * real layer of the wrong ship.
 *
 * The scope comes from {@link layerScopeForPart}, which reaches the ships through the game's
 * registry and the manifests, so a mod's own ship, its own layers, and the parts it registers by
 * action are all included. A file no ship registers is judged against the union of every ship: the
 * file alone cannot say which ship will draw it, and a base file that several parts derive from is
 * exactly that case.
 */

/** The class a layer reference targets, the anchor the fields are found by rather than by name. */
const LAYER_CLASS = 'Cosmoteer.Ships.ShipRenderLayerRules';

/**
 * Whether the value declares a layer instead of naming one: the `Key` of an entry in a ship's own
 * `RenderLayers` map, which is how both the game and a mod write a new layer. The map is self-keyed,
 * so its keys create the very ids everything else references, and judging one against the pool it
 * fills would report a mod's own new layer as unknown.
 *
 * @param node the value node to test.
 * @returns true when the value is a declaration.
 */
const declaresTheLayer = (node: ValueNode): boolean => {
    // `Key = "x"` inside `RenderLayers [ { … } ]` reads as Value -> entry Group -> the map's List, so
    // the list is looked for a couple of hops up rather than at a fixed depth.
    let current: AbstractNode | undefined = node.parent as AbstractNode | undefined;
    for (let hops = 0; current && hops < 3; hops++, current = current.parent as AbstractNode | undefined) {
        if (!isListNode(current)) continue;
        const fieldName = current.identifier?.name ?? declaringFieldOf(current).fieldName;
        if (fieldName && SELF_KEYED_MAP_FIELDS.get(fieldName.toLowerCase()) === LAYER_CLASS) return true;
    }
    return false;
};

/** The `ID` a top-level group declares, which names the part a copy of it stands in for. */
const declaredIdOf = (group: GroupNode): string | undefined => {
    for (const [name, member] of namedMembersOf(group)) {
        if (name.toLowerCase() !== 'id' || !isValueNode(member)) continue;
        const written = String(member.valueType.value).trim();
        if (written) return written;
    }
    return undefined;
};

/** The top-level group a node sits in, which is the part or the ship the layer belongs to. */
const owningTopLevelGroup = (node: AbstractNode): GroupNode | undefined => {
    let current: AbstractNode | undefined = node;
    let group: GroupNode | undefined;
    while (current) {
        if (isGroupNode(current) && current.identifier) group = current;
        current = current.parent as AbstractNode | undefined;
    }
    return group;
};

/**
 * Reports every layer id the ship drawing it does not declare.
 *
 * @param document the parsed document to judge.
 * @param context the workspace inputs the ship index is built from.
 * @param cancellationToken cancels the ship and manifest reads.
 * @returns one error per layer the ship refuses, empty when every layer is in scope.
 */
export const validateRenderLayers = async (
    document: AbstractNodeDocument,
    context: ShipLayerContext,
    cancellationToken: CancellationToken
): Promise<ValidationError[]> => {
    const errors: ValidationError[] = [];
    const fsPath = uriToFsPath(document.uri);
    if (!fsPath) return errors;

    // Collected first so the scope, which reads the ship files, is only built for a document that
    // really writes a layer. Layer ids are written quoted everywhere the game and the mods do it,
    // and the schema types the field, so the shared string-value collector finds them all.
    const written: Array<{ node: ValueNode; layer: string }> = [];
    for (const value of stringValueNodesOf(document)) {
        const reference = schemaReferenceFieldOf(value);
        if (reference?.targetClass !== LAYER_CLASS) continue;
        // A field the game's code never reads names no layer, whatever its type says. The game's own
        // `IndicatorSprites` components write one, and the ignored-field hint already covers them.
        if (reference.ownerClass && reference.fieldName && fieldOf(reference.ownerClass, reference.fieldName)?.dead) {
            continue;
        }
        if (declaresTheLayer(value)) continue;
        const layer = reference.value.trim();
        if (layer) written.push({ node: value, layer });
    }
    if (written.length === 0) return errors;

    const scopeByGroup = new Map<string, PartLayerScope | undefined>();
    const scopeFor = async (group: GroupNode): Promise<PartLayerScope | undefined> => {
        const groupName = group.identifier!.name;
        if (!scopeByGroup.has(groupName)) {
            scopeByGroup.set(
                groupName,
                await layerScopeForPart(fsPath, groupName, context, cancellationToken, declaredIdOf(group)).catch(
                    () => undefined
                )
            );
        }
        return scopeByGroup.get(groupName);
    };

    for (const { node, layer } of written) {
        if (cancellationToken.isCancellationRequested) break;
        const group = owningTopLevelGroup(node);
        if (!group?.identifier) continue;
        const scope = await scopeFor(group);
        if (!scope) continue;
        const verdict = judgeLayer(scope, layer);
        if (verdict === 'accepted') continue;
        const shipNames = scope.ships.map((ship) => ship.shipName).join(', ');
        errors.push({
            node,
            message:
                verdict === 'foreign'
                    ? l10n.t(
                          "The {0} ship does not draw on the layer '{1}'. It belongs to another ship, so the game throws when it draws this.",
                          shipNames,
                          layer
                      )
                    : l10n.t(
                          "No ship declares the render layer '{0}', so the game throws when it draws this.",
                          layer
                      ),
            severity: 'warning',
        });
    }
    return errors;
};
