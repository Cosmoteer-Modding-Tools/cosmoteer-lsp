import { CancellationToken, Position, Range } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    GroupNode,
    isGroupNode,
    isListNode,
    isValueNode,
} from '../../core/ast/ast';
import { findEnclosingGroup, resolveGroupClass } from '../../document/schema/schema-context';
import { classAncestry, enumDef } from '../../document/schema/schema';
import { getStartOfAstNode } from '../../utils/ast.utils';
import { findMemberThroughInheritance, ResolveReferenceFn } from '../../semantics/inheritance-resolver';
import { evaluateNumericValue } from '../../semantics/value-evaluator';
import { FullNavigationStrategy } from '../navigation/full.navigation-strategy';
import { resolveAssetPath } from '../navigation/asset-resolver';
import { filePathToUri } from '../navigation/navigation-strategy';
import {
    AstProvenance,
    CellDirectionLayerData,
    CellLayerData,
    CellPairListLayerData,
    CellRayLayerData,
    CellSetLayerData,
    CellToValuesLayerData,
    CircleLayerData,
    ComponentPointEntry,
    ComponentPointsLayerData,
    EdgeRegionLayerData,
    GridLayerData,
    GridPoint,
    PartGridData,
    PointLayerData,
    PointListLayerData,
    PolygonLayerData,
    RectLayerData,
    RectListLayerData,
    RotationBoolData,
    RotationIntListData,
    SpriteLayerData,
} from './part-grid.types';
import {
    booleanOf,
    childNamed,
    degreesOf,
    enumNameOf,
    numberOf,
    readEnumNames,
    readIntList,
    readMapEntries,
    readRect,
    readVector,
    readVectorEvaluated,
} from './vector-forms';
import { fieldOf } from '../../document/schema/schema';

/**
 * Builds the {@link PartGridData} payload the grid editor webview renders: the part's effective
 * grid size, its sprites resolved to file URIs, every grid-authorable field as a typed layer (with
 * per-value provenance so inherited values render as ghosts), and the rotation fields. All reads go
 * through inheritance resolution, so a part that overrides nothing still shows its base's geometry.
 */

const PART_RULES_CLASS = 'Cosmoteer.Ships.Parts.PartRules';
const CREW_RULES_CLASS = 'Cosmoteer.Ships.Parts.Crew.PartCrewRules';
const GRAPHICS_RULES_CLASS = 'Cosmoteer.Ships.Parts.Graphics.PartGraphicsRules';
const ADJACENCY_FLAGS_ENUM = 'Cosmoteer.Ships.Parts.AdjacencyFlags';
const TRAVEL_DIRECTION_ENUM = 'Cosmoteer.Ships.Crew.TravelDirection';

/**
 * The part-root cell-set fields, one `cellSet` layer each. Door locations name the outside cells a
 * door may connect to (the game's `AllowsDoorAt` identifies the outside cell of a door against
 * them), blocked travel cells sit inside the part rect.
 */
const CELL_SET_FIELDS: ReadonlyArray<{ readonly field: string; readonly domain: 'inside' | 'outside' | 'any' }> = [
    { field: 'AllowedDoorLocations', domain: 'outside' },
    { field: 'BlockedTravelCells', domain: 'inside' },
];

/** The part-root map fields, one `cellToValues` layer each. */
const MAP_FIELDS: ReadonlyArray<{
    readonly field: string;
    readonly valueModel: 'flags' | 'enumList';
    readonly enumRef: string;
    /** The whole-part scalar field the map overrides per cell, shown as a ghost fallback. */
    readonly fallbackField: string | null;
}> = [
    { field: 'BlockedTravelCellDirections', valueModel: 'enumList', enumRef: TRAVEL_DIRECTION_ENUM, fallbackField: null },
    { field: 'ExternalWallsByCell', valueModel: 'flags', enumRef: ADJACENCY_FLAGS_ENUM, fallbackField: 'ExternalWalls' },
    { field: 'InternalWallsByCell', valueModel: 'flags', enumRef: ADJACENCY_FLAGS_ENUM, fallbackField: 'InternalWalls' },
    {
        field: 'BlueprintExternalWallsByCell',
        valueModel: 'flags',
        enumRef: ADJACENCY_FLAGS_ENUM,
        fallbackField: 'BlueprintExternalWalls',
    },
    {
        field: 'BlueprintInternalWallsByCell',
        valueModel: 'flags',
        enumRef: ADJACENCY_FLAGS_ENUM,
        fallbackField: 'BlueprintInternalWalls',
    },
];

/** The part-root rect fields, one `rect` layer each. */
const RECT_FIELDS = ['PhysicalRect', 'SaveRect'] as const;

const navigation = new FullNavigationStrategy();

/** Adapts the shared navigation strategy to the inheritance resolver's reference-resolution shape. */
const resolveReference: ResolveReferenceFn = (path, startNode, currentLocation, token, inheritanceVisited) =>
    navigation.navigate(path, startNode, currentLocation, token, new Set(), inheritanceVisited) as ReturnType<ResolveReferenceFn>;

/** A member read that remembers whether it was found locally or through inheritance. */
interface EffectiveMember {
    readonly node: AbstractNode;
    readonly inherited: boolean;
}

/**
 * Reads a member of a group, preferring the local declaration and falling back to the group's
 * inheritance chain.
 * @param group the group to read from.
 * @param name the member name.
 * @param token cancels reference resolution.
 * @returns the member's value node with its inheritance flag, or null when absent everywhere.
 */
const effectiveMember = async (
    group: GroupNode,
    name: string,
    token: CancellationToken
): Promise<EffectiveMember | null> => {
    const local = childNamed(group, name);
    if (local) return { node: local, inherited: false };
    const inherited = await findMemberThroughInheritance(group, name, resolveReference, token).catch(() => null);
    return inherited ? { node: inherited, inherited: true } : null;
};

/**
 * The provenance of a read node: its owning file and an anchor range. Container nodes carry a
 * same-line opener/closer span (see the parser position invariants), so their anchor collapses to
 * the opener when the recorded span is not a forward range.
 * @param node the node the value was read from.
 * @param inherited whether the value came through inheritance.
 * @returns the provenance record.
 */
const provenanceOf = (node: AbstractNode, inherited: boolean): AstProvenance => {
    const uri = getStartOfAstNode(node).uri;
    const { line, characterStart, characterEnd } = node.position;
    const end = characterEnd >= characterStart ? characterEnd : characterStart;
    return {
        uri: uri.startsWith('file://') ? uri : filePathToUri(uri),
        range: Range.create(Position.create(line, characterStart), Position.create(line, end)),
        inherited,
    };
};

/**
 * Locates the Part group the request is aimed at: the enclosing group resolving to `PartRules`,
 * else the document's first top-level `Part` group (robust when the offset sits outside the group).
 * @param document the parsed document.
 * @param offset the request's byte offset.
 * @returns the part group, or null when the document declares none.
 */
export const locatePartGroup = (document: AbstractNodeDocument, offset: number): GroupNode | null => {
    for (
        let current: AbstractNode | undefined = findEnclosingGroup(document, offset);
        current;
        current = current.parent
    ) {
        if (isGroupNode(current) && resolveGroupClass(current) === PART_RULES_CLASS) return current;
    }
    for (const element of document.elements) {
        if (isGroupNode(element) && resolveGroupClass(element) === PART_RULES_CLASS) return element;
    }
    return null;
};

/**
 * The named component groups of a part whose class ancestry contains `cls`.
 * @param part the part group.
 * @param cls the component base class FullName.
 * @returns the matching components with their member names.
 */
const componentsOfClass = (part: GroupNode, cls: string): Array<{ name: string; group: GroupNode }> => {
    const components = childNamed(part, 'Components');
    if (!components || !isGroupNode(components)) return [];
    const matches: Array<{ name: string; group: GroupNode }> = [];
    for (const element of components.elements) {
        if (!isGroupNode(element) || !element.identifier) continue;
        const elementClass = resolveGroupClass(element);
        if (elementClass && classAncestry(elementClass).includes(cls)) {
            matches.push({ name: element.identifier.name, group: element });
        }
    }
    return matches;
};

/**
 * Builds one cell-set layer from a part-root list field.
 * @param part the part group.
 * @param field the field name.
 * @param token cancels inheritance resolution.
 * @returns the layer (empty with a null origin when the field is absent everywhere).
 */
const cellSetLayer = async (
    part: GroupNode,
    spec: (typeof CELL_SET_FIELDS)[number],
    token: CancellationToken
): Promise<CellSetLayerData> => {
    const member = await effectiveMember(part, spec.field, token);
    const cells: Array<{ cell: { x: number; y: number }; origin: AstProvenance }> = [];
    if (member && (isListNode(member.node) || isGroupNode(member.node))) {
        for (const element of member.node.elements) {
            const vector = readVector(element);
            if (vector) {
                cells.push({ cell: { x: vector.x, y: vector.y }, origin: provenanceOf(vector.node, member.inherited) });
            }
        }
    }
    return {
        kind: 'cellSet',
        id: spec.field,
        label: spec.field,
        fieldName: spec.field,
        fieldPath: [],
        inherited: member?.inherited ?? false,
        origin: member ? provenanceOf(member.node, member.inherited) : null,
        group: 'Part',
        domain: spec.domain,
        cells,
    };
};

/**
 * Builds one cell-to-values layer from a part-root map field.
 * @param part the part group.
 * @param spec the map field descriptor.
 * @param token cancels inheritance resolution.
 * @returns the layer.
 */
const mapLayer = async (
    part: GroupNode,
    spec: (typeof MAP_FIELDS)[number],
    token: CancellationToken
): Promise<CellToValuesLayerData> => {
    const member = await effectiveMember(part, spec.field, token);
    const entries: Array<{ cell: { x: number; y: number }; values: string[]; origin: AstProvenance }> = [];
    if (member) {
        for (const entry of readMapEntries(member.node)) {
            const values = readEnumNames(entry.value);
            if (values) {
                entries.push({
                    cell: { x: entry.key.x, y: entry.key.y },
                    values,
                    origin: provenanceOf(entry.entry, member.inherited),
                });
            }
        }
    }
    const fallbackMember = spec.fallbackField ? await effectiveMember(part, spec.fallbackField, token) : null;
    return {
        kind: 'cellToValues',
        id: spec.field,
        label: spec.field,
        fieldName: spec.field,
        fieldPath: [],
        inherited: member?.inherited ?? false,
        origin: member ? provenanceOf(member.node, member.inherited) : null,
        group: 'Part',
        valueModel: spec.valueModel,
        enumRef: spec.enumRef,
        enumNames: enumDef(spec.enumRef)?.members ?? [],
        fallback: fallbackMember ? readEnumNames(fallbackMember.node) : null,
        entries,
    };
};

/**
 * Builds one fractional-point layer per crew component's `CrewDestinations`.
 * @param part the part group.
 * @param token cancels inheritance resolution.
 * @returns the layers, one per crew component (components without the field still get an empty layer).
 */
const crewLayers = async (part: GroupNode, token: CancellationToken): Promise<PointListLayerData[]> => {
    const layers: PointListLayerData[] = [];
    for (const { name, group } of componentsOfClass(part, CREW_RULES_CLASS)) {
        const member = await effectiveMember(group, 'CrewDestinations', token);
        const points: Array<{ point: { x: number; y: number }; origin: AstProvenance }> = [];
        if (member && (isListNode(member.node) || isGroupNode(member.node))) {
            for (const element of member.node.elements) {
                const vector = readVector(element);
                if (vector) {
                    points.push({
                        point: { x: vector.x, y: vector.y },
                        origin: provenanceOf(vector.node, member.inherited),
                    });
                }
            }
        }
        layers.push({
            kind: 'pointList',
            id: `Components/${name}/CrewDestinations`,
            label: `CrewDestinations (${name})`,
            fieldName: 'CrewDestinations',
            fieldPath: ['Components', name],
            inherited: member?.inherited ?? false,
            origin: member ? provenanceOf(member.node, member.inherited) : null,
            group: 'Crew',
            points,
        });
    }
    return layers;
};

/**
 * Builds the virtual-internal-cells pair layer.
 * @param part the part group.
 * @param token cancels inheritance resolution.
 * @returns the layer.
 */
const virtualCellsLayer = async (part: GroupNode, token: CancellationToken): Promise<CellPairListLayerData> => {
    const member = await effectiveMember(part, 'VirtualInternalCells', token);
    const pairs: Array<{
        external: { x: number; y: number };
        internal: { x: number; y: number };
        origin: AstProvenance;
    }> = [];
    if (member && (isListNode(member.node) || isGroupNode(member.node))) {
        for (const element of member.node.elements) {
            if (!isGroupNode(element)) continue;
            const external = readVector(childNamed(element, 'ExternalCell'));
            const internal = readVector(childNamed(element, 'InternalCell'));
            if (external && internal) {
                pairs.push({
                    external: { x: external.x, y: external.y },
                    internal: { x: internal.x, y: internal.y },
                    origin: provenanceOf(element, member.inherited),
                });
            }
        }
    }
    return {
        kind: 'cellPairList',
        id: 'VirtualInternalCells',
        label: 'VirtualInternalCells',
        fieldName: 'VirtualInternalCells',
        fieldPath: [],
        inherited: member?.inherited ?? false,
        origin: member ? provenanceOf(member.node, member.inherited) : null,
        group: 'Part',
        pairs,
    };
};

/**
 * Builds one rect layer from a part-root rect field.
 * @param part the part group.
 * @param field the field name.
 * @param token cancels inheritance resolution.
 * @returns the layer.
 */
const rectLayer = async (part: GroupNode, field: string, token: CancellationToken): Promise<RectLayerData> => {
    const member = await effectiveMember(part, field, token);
    const rect = member ? readRect(member.node) : null;
    return {
        kind: 'rect',
        id: field,
        label: field,
        fieldName: field,
        fieldPath: [],
        inherited: member?.inherited ?? false,
        origin: member ? provenanceOf(member.node, member.inherited) : null,
        group: 'Part',
        rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
    };
};

/**
 * Reads an effective boolean rotation field.
 * @param part the part group.
 * @param field the field name.
 * @param token cancels inheritance resolution.
 * @returns the value with provenance (a null value when unset or unreadable).
 */
const rotationBool = async (part: GroupNode, field: string, token: CancellationToken): Promise<RotationBoolData> => {
    const member = await effectiveMember(part, field, token);
    return {
        value: member ? booleanOf(member.node) : null,
        origin: member ? provenanceOf(member.node, member.inherited) : null,
    };
};

/**
 * Reads an effective int-list rotation field.
 * @param part the part group.
 * @param field the field name.
 * @param token cancels inheritance resolution.
 * @returns the values with provenance, or null when absent or unreadable.
 */
const rotationIntList = async (
    part: GroupNode,
    field: string,
    token: CancellationToken
): Promise<RotationIntListData | null> => {
    const member = await effectiveMember(part, field, token);
    const values = member ? readIntList(member.node) : null;
    return member && values ? { values, origin: provenanceOf(member.node, member.inherited) } : null;
};

/**
 * The graphics component's sprite slots composited under the grid, in draw order. Each slot is a
 * `DamageLevelSprites` group whose `DamageLevels` list holds one `AtlasSprite` per damage state
 * (index 0 = undamaged). The roof starts hidden so the interior shows.
 */
const SPRITE_MEMBERS: ReadonlyArray<{ id: string; member: string; defaultVisible: boolean }> = [
    { id: 'floor', member: 'Floor', defaultVisible: true },
    { id: 'walls', member: 'Walls', defaultVisible: true },
    { id: 'roof', member: 'Roof', defaultVisible: false },
];

/**
 * The undamaged `AtlasSprite` group of a `DamageLevelSprites` slot: `DamageLevels[0]`, tolerating
 * a slot written directly as a sprite group (a `File` without the damage list).
 * @param slot the slot's value node.
 * @returns the sprite group, or null.
 */
const undamagedSprite = (slot: AbstractNode): GroupNode | null => {
    if (!isGroupNode(slot)) return null;
    const levels = childNamed(slot, 'DamageLevels');
    if (levels && (isListNode(levels) || isGroupNode(levels))) {
        const first = levels.elements.find(isGroupNode);
        if (first) return first;
    }
    return childNamed(slot, 'File') ? slot : null;
};

/**
 * Resolves the part's sprites from its graphics components to file URIs the host can inline,
 * placed with the game's quad formula: the sprite rect is centered on the component `Location`
 * plus the slot and sprite offsets, sized by the sprite's `Size` in cell units.
 * @param part the part group.
 * @param token cancels asset resolution.
 * @returns the sprite layers (empty when the part has no resolvable graphics).
 */
const collectSprites = async (part: GroupNode, token: CancellationToken): Promise<SpriteLayerData[]> => {
    const sprites: SpriteLayerData[] = [];
    const graphics = componentsOfClass(part, GRAPHICS_RULES_CLASS);
    for (const { name, group } of graphics) {
        const location = readVector(childNamed(group, 'Location'));
        for (const spec of SPRITE_MEMBERS) {
            const slot = childNamed(group, spec.member);
            if (!slot || !isGroupNode(slot)) continue;
            const sprite = undamagedSprite(slot);
            if (!sprite) continue;
            const fileNode = childNamed(sprite, 'File');
            if (!isValueNode(fileNode)) continue;
            const declaringUri = getStartOfAstNode(fileNode).uri;
            const path = await resolveAssetPath(
                fileNode,
                declaringUri.startsWith('file://') ? declaringUri : filePathToUri(declaringUri),
                token
            ).catch(() => null);
            const size = readVector(childNamed(sprite, 'Size'));
            const slotOffset = readVector(childNamed(slot, 'Offset'));
            const spriteOffset = readVector(childNamed(sprite, 'Offset'));
            const center = {
                x: (location?.x ?? 0) + (slotOffset?.x ?? 0) + (spriteOffset?.x ?? 0),
                y: (location?.y ?? 0) + (slotOffset?.y ?? 0) + (spriteOffset?.y ?? 0),
            };
            const suffix = graphics.length > 1 ? `:${name}` : '';
            sprites.push({
                id: `${spec.id}${suffix}`,
                label: graphics.length > 1 ? `${spec.member} (${name})` : spec.member,
                uri: path ? filePathToUri(path) : null,
                offset: size ? [center.x - size.x / 2, center.y - size.y / 2] : [0, 0],
                size: size ? [size.x, size.y] : null,
                defaultVisible: spec.defaultVisible,
            });
        }
    }
    return sprites;
};

const CHAINABLE_CLASS = 'Cosmoteer.Ships.Parts.ChainablePartComponentRules';
const NETWORK_PORT_CLASS = 'Cosmoteer.Ships.Networks.BasePartNetworkPortRules';
const POLYGON_COLLIDER_CLASS = 'Cosmoteer.Ships.Parts.Colliders.PolygonColliderRules';
const CIRCLE_COLLIDER_CLASS = 'Cosmoteer.Ships.Parts.Colliders.CircleColliderRules';
const RAILGUN_CLASS = 'Cosmoteer.Ships.Parts.Weapons.RailgunProjectileRules';
const TILE_LINE_CLASS = 'Cosmoteer.Ships.Parts.Logic.PartTileLineScoreValueRules';
const RESOURCE_SPRITES_CLASS = 'Cosmoteer.Ships.Parts.Graphics.PartResourceSpritesRules';
const ORTHOGONAL_ROTATION_ENUM = 'Cosmoteer.OrthogonalRotation';

/** The single-point component fields, one `point` layer each where the component's class has them. */
const COMPONENT_POINT_FIELDS: ReadonlyArray<{ readonly field: string; readonly group: string }> = [
    { field: 'PickUpLocation', group: 'Resources' },
    { field: 'DeliveryLocation', group: 'Resources' },
    { field: 'ExternalPickUpLocation', group: 'Resources' },
    { field: 'ExternalDeliveryLocation', group: 'Resources' },
    { field: 'SupplyToggleButtonOffset', group: 'Resources' },
    { field: 'ConsumptionToggleButtonOffset', group: 'Resources' },
    { field: 'EnterExitPoint', group: 'Crew' },
    { field: 'StartLocation', group: 'Components' },
    { field: 'EndLocation', group: 'Components' },
];

/**
 * The single-cell component fields. `PartLocation` is an empty-alias `ProxyRules` member written
 * flat on the proxy component, and the schema inlines its fields onto the proxy classes, so the
 * plain class/member check finds it there.
 */
const COMPONENT_CELL_FIELDS: ReadonlyArray<{ readonly field: string; readonly group: string }> = [
    { field: 'PartLocation', group: 'Logic' },
    { field: 'AdjacentCell', group: 'Logic' },
    { field: 'NewPartLocation', group: 'Logic' },
    { field: 'CellOffset', group: 'Graphics' },
];

/** The single-rect component fields. */
const COMPONENT_RECT_FIELDS: ReadonlyArray<{
    readonly field: string;
    readonly group: string;
    readonly fractional: boolean;
}> = [
    { field: 'BuffArea', group: 'Regions', fractional: false },
    { field: 'GridRect', group: 'Resources', fractional: false },
    { field: 'IdleRect', group: 'Crew', fractional: true },
    { field: 'UITileRect', group: 'Resources', fractional: true },
    { field: 'ClampLocationToRect', group: 'Components', fractional: true },
];

/** The graphics slots whose `DamageLevelSprites.Offset` gets a point layer when the slot exists. */
const GRAPHICS_OFFSET_SLOTS: readonly string[] = [
    'Floor',
    'Walls',
    'WallsStencil',
    'Roof',
    'OperationalDoodad',
    'NonOperationalDoodad',
    'ToggleOnDoodad',
    'ToggleOffDoodad',
    'OperationalLighting',
    'OperationalRoofDoodad',
    'NonOperationalRoofDoodad',
    'OperationalRoofLighting',
    'BlueprintSprite',
];

/** All named component groups of a part, whatever their class. */
const allComponents = (part: GroupNode): Array<{ name: string; group: GroupNode; cls: string | undefined }> => {
    const components = childNamed(part, 'Components');
    if (!components || !isGroupNode(components)) return [];
    const result: Array<{ name: string; group: GroupNode; cls: string | undefined }> = [];
    for (const element of components.elements) {
        if (isGroupNode(element) && element.identifier) {
            result.push({ name: element.identifier.name, group: element, cls: resolveGroupClass(element) });
        }
    }
    return result;
};

/** Whether a component carries a field, by schema class or by a locally written member. */
const hasField = (group: GroupNode, cls: string | undefined, field: string): boolean =>
    !!(cls && fieldOf(cls, field)) || !!childNamed(group, field);

/** Whether a class's ancestry contains a base class. */
const inAncestry = (cls: string | undefined, base: string): boolean => !!cls && classAncestry(cls).includes(base);

/** The shared layer-base fields for a component-owned member. */
const layerBaseOf = (
    fieldPath: readonly string[],
    fieldName: string,
    label: string,
    group: string,
    member: EffectiveMember | null
) => ({
    id: [...fieldPath, fieldName].join('/'),
    label,
    fieldName,
    fieldPath,
    inherited: member?.inherited ?? false,
    origin: member ? provenanceOf(member.node, member.inherited) : null,
    group,
});

/**
 * Rotates a vector by an arbitrary angle in y-down space (positive = clockwise on screen).
 * @param x the vector x.
 * @param y the vector y.
 * @param degrees the angle.
 * @returns the rotated vector.
 */
const rotateDegrees = (x: number, y: number, degrees: number): [number, number] => {
    const radians = (degrees * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    return [x * cos - y * sin, x * sin + y * cos];
};

/**
 * Builds the aggregated component gizmo layer: every chainable component's own `Location` and
 * `Rotation`, with `ChainedTo` transforms resolved so the marker sits where the game renders the
 * component. Network ports are excluded, they get their own cell layers.
 * @param part the part group.
 * @param token cancels evaluation of expression-valued locations.
 * @returns the gizmo layer.
 */
const componentPointsLayer = async (part: GroupNode, token: CancellationToken): Promise<ComponentPointsLayerData> => {
    const components = allComponents(part);
    const byName = new Map(components.map((entry) => [entry.name, entry]));

    /** The component's own location vector, evaluated when written as math. */
    const ownLocation = async (group: GroupNode): Promise<{ point: GridPoint | null; isRef: boolean }> => {
        const node = childNamed(group, 'Location');
        if (!node) return { point: null, isRef: false };
        const plain = readVector(node);
        if (plain) return { point: { x: plain.x, y: plain.y }, isRef: false };
        const evaluated = await readVectorEvaluated(node, token).catch(() => null);
        if (evaluated) return { point: evaluated, isRef: true };
        return { point: null, isRef: true };
    };

    /** The component's resolved rules-relative transform, following the `ChainedTo` chain. */
    const totalTransform = async (
        name: string,
        visited: Set<string>
    ): Promise<{ x: number; y: number; rotation: number } | null> => {
        if (visited.has(name)) return null;
        visited.add(name);
        const entry = byName.get(name);
        if (!entry) return null;
        const { point } = await ownLocation(entry.group);
        const own = point ?? { x: 0, y: 0 };
        const rotation = degreesOf(childNamed(entry.group, 'Rotation')) ?? 0;
        const chainedTo = enumNameOf(childNamed(entry.group, 'ChainedTo'));
        if (!chainedTo || !byName.has(chainedTo)) return { x: own.x, y: own.y, rotation };
        const parent = await totalTransform(chainedTo, visited);
        if (!parent) return { x: own.x, y: own.y, rotation };
        const [dx, dy] = rotateDegrees(own.x, own.y, parent.rotation);
        return { x: parent.x + dx, y: parent.y + dy, rotation: parent.rotation + rotation };
    };

    const entries: ComponentPointEntry[] = [];
    for (const { name, group, cls } of components) {
        if (inAncestry(cls, NETWORK_PORT_CLASS)) continue;
        const locationNode = childNamed(group, 'Location');
        if (!locationNode && !inAncestry(cls, CHAINABLE_CLASS)) continue;
        const { point, isRef } = await ownLocation(group);
        const chainedTo = enumNameOf(childNamed(group, 'ChainedTo'));
        const total = await totalTransform(name, new Set());
        entries.push({
            component: name,
            label: name,
            typeName: enumNameOf(childNamed(group, 'Type')),
            location: total && (point || chainedTo) ? { x: total.x, y: total.y } : point,
            rotationDeg: degreesOf(childNamed(group, 'Rotation')),
            chainedTo: chainedTo && byName.has(chainedTo) ? chainedTo : null,
            locationIsRef: isRef,
            origin: locationNode ? provenanceOf(locationNode, false) : null,
        });
    }
    return {
        kind: 'componentPoints',
        ...layerBaseOf([], 'ComponentLocations', 'Component locations', 'Components', null),
        entries,
    };
};

/**
 * Builds the per-component field layers of the sweep round: single points, cells, rects, network
 * ports, tile-line rays, buff circles, polygon colliders, railgun segments, and resource-level
 * sprite offsets.
 * @param part the part group.
 * @param token cancels inheritance resolution.
 * @returns the layers in a stable order.
 */
const componentFieldLayers = async (part: GroupNode, token: CancellationToken): Promise<GridLayerData[]> => {
    const layers: GridLayerData[] = [];
    for (const { name, group, cls } of allComponents(part)) {
        const path = ['Components', name];
        const label = (field: string): string => `${field} (${name})`;

        for (const spec of COMPONENT_POINT_FIELDS) {
            if (!hasField(group, cls, spec.field)) continue;
            const member = await effectiveMember(group, spec.field, token);
            const point = member ? await readVectorEvaluated(member.node, token).catch(() => null) : null;
            layers.push({
                kind: 'point',
                ...layerBaseOf(path, spec.field, label(spec.field), spec.group, member),
                point,
            } as PointLayerData);
        }

        for (const spec of COMPONENT_CELL_FIELDS) {
            if (!hasField(group, cls, spec.field)) continue;
            const member = await effectiveMember(group, spec.field, token);
            const cell = member ? readVector(member.node) : null;
            layers.push({
                kind: 'cell',
                ...layerBaseOf(path, spec.field, label(spec.field), spec.group, member),
                cell: cell ? { x: cell.x, y: cell.y } : null,
            } as CellLayerData);
        }

        for (const spec of COMPONENT_RECT_FIELDS) {
            if (!hasField(group, cls, spec.field)) continue;
            const member = await effectiveMember(group, spec.field, token);
            const rect = member ? readRect(member.node) : null;
            layers.push({
                kind: 'rect',
                ...layerBaseOf(path, spec.field, label(spec.field), spec.group, member),
                fractional: spec.fractional,
                rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
            } as RectLayerData);
            // Resource grid disable cells are 0-based within GridRect, rendered at that offset.
            if (spec.field === 'GridRect' && hasField(group, cls, 'DisableCells')) {
                const disable = await effectiveMember(group, 'DisableCells', token);
                const cells: Array<{ cell: { x: number; y: number }; origin: AstProvenance }> = [];
                if (disable && (isListNode(disable.node) || isGroupNode(disable.node))) {
                    for (const element of disable.node.elements) {
                        const vector = readVector(element);
                        if (vector) {
                            cells.push({
                                cell: { x: vector.x, y: vector.y },
                                origin: provenanceOf(vector.node, disable.inherited),
                            });
                        }
                    }
                }
                layers.push({
                    kind: 'cellSet',
                    ...layerBaseOf(path, 'DisableCells', label('DisableCells'), spec.group, disable),
                    domain: 'any',
                    baseCell: rect ? { x: rect.x, y: rect.y } : { x: 0, y: 0 },
                    cells,
                } as CellSetLayerData);
            }
        }

        if (inAncestry(cls, NETWORK_PORT_CLASS) || (childNamed(group, 'Direction') && childNamed(group, 'Location'))) {
            const member = await effectiveMember(group, 'Location', token);
            const cell = member ? readVector(member.node) : null;
            const direction = await effectiveMember(group, 'Direction', token);
            layers.push({
                kind: 'cellDirection',
                ...layerBaseOf(path, 'Location', label('Port'), 'Networks', member),
                cell: cell ? { x: cell.x, y: cell.y } : null,
                direction: direction ? enumNameOf(direction.node) : null,
                directions: enumDef(ORTHOGONAL_ROTATION_ENUM)?.members ?? ['Right', 'Down', 'Left', 'Up'],
            } as CellDirectionLayerData);
        }

        if (inAncestry(cls, TILE_LINE_CLASS) || isGroupNode(childNamed(group, 'Line'))) {
            const member = await effectiveMember(group, 'Line', token);
            const line = member && isGroupNode(member.node) ? member.node : null;
            const cell = line ? readVector(childNamed(line, 'Location')) : null;
            layers.push({
                kind: 'cellRay',
                ...layerBaseOf(path, 'Line', label('Line'), 'Regions', member),
                cell: cell ? { x: cell.x, y: cell.y } : null,
                direction: line ? enumNameOf(childNamed(line, 'Direction')) : null,
                maxTiles: line ? numberOf(childNamed(line, 'MaxTiles')) : null,
                directions: enumDef(ORTHOGONAL_ROTATION_ENUM)?.members ?? ['Right', 'Down', 'Left', 'Up'],
            } as CellRayLayerData);
        }

        if (hasField(group, cls, 'BuffCenter') || hasField(group, cls, 'BuffRadius')) {
            const center = await effectiveMember(group, 'BuffCenter', token);
            const radius = await effectiveMember(group, 'BuffRadius', token);
            layers.push({
                kind: 'circle',
                ...layerBaseOf(path, 'BuffCenter', label('BuffCircle'), 'Regions', center),
                center: center ? await readVectorEvaluated(center.node, token).catch(() => null) : null,
                radius: radius ? numberOf(radius.node) : null,
                radiusField: 'BuffRadius',
                centerEditable: true,
            } as CircleLayerData);
        }

        // A status-value regulator's edge-distance region (the heat exchanger's absorption area)
        // draws as a halo grown outward from the part rect by `Distance` cells. Only the EdgeDistance
        // shape maps to this layer, other region shapes are left for the text editor.
        const regionMember = await effectiveMember(group, 'Region', token);
        const regionGroup = regionMember && isGroupNode(regionMember.node) ? regionMember.node : null;
        if (regionGroup && enumNameOf(childNamed(regionGroup, 'Type')) === 'EdgeDistance') {
            const distanceNode = childNamed(regionGroup, 'Distance');
            layers.push({
                kind: 'edgeRegion',
                ...layerBaseOf(path, 'Region', label('Region'), 'Regions', regionMember),
                distance: distanceNode ? numberOf(distanceNode) : null,
                distanceField: 'Distance',
            } as EdgeRegionLayerData);
        }

        if (inAncestry(cls, POLYGON_COLLIDER_CLASS) || isListNode(childNamed(group, 'Vertices'))) {
            const member = await effectiveMember(group, 'Vertices', token);
            layers.push(await polygonLayerOf(path, 'Vertices', label('Vertices'), member, token));
        }

        // A circle collider draws as a radius circle around the component's own location, which is
        // moved through the gizmo, so only the radius is editable here.
        if (inAncestry(cls, CIRCLE_COLLIDER_CLASS)) {
            const radius = await effectiveMember(group, 'Radius', token);
            const location = childNamed(group, 'Location');
            layers.push({
                kind: 'circle',
                ...layerBaseOf(path, 'Radius', label('CircleCollider'), 'Colliders', radius),
                center: location ? await readVectorEvaluated(location, token).catch(() => null) : null,
                radius: radius ? numberOf(radius.node) : null,
                radiusField: 'Radius',
                centerEditable: false,
            } as CircleLayerData);
        }

        if (inAncestry(cls, RAILGUN_CLASS)) {
            layers.push(
                await scalarPairPointLayer(group, path, 'RailgunStart', 'XStartOffset', 'YStartOffset', name, token),
                await scalarPairPointLayer(group, path, 'RailgunEnd', 'XEndOffset', 'YEndOffset', name, token)
            );
        }

        if (inAncestry(cls, RESOURCE_SPRITES_CLASS) || isListNode(childNamed(group, 'ResourceLevels'))) {
            const member = await effectiveMember(group, 'ResourceLevels', token);
            const points: Array<{ point: GridPoint; origin: AstProvenance }> = [];
            if (member && (isListNode(member.node) || isGroupNode(member.node))) {
                for (const element of member.node.elements) {
                    if (!isGroupNode(element)) continue;
                    const offset = readVector(childNamed(element, 'Offset'));
                    if (offset) {
                        points.push({
                            point: { x: offset.x, y: offset.y },
                            origin: provenanceOf(offset.node, member.inherited),
                        });
                    }
                }
            }
            if (points.length) {
                layers.push({
                    kind: 'pointList',
                    ...layerBaseOf(path, 'ResourceLevels:Offset', label('ResourceLevels offsets'), 'Graphics', member),
                    entryMember: 'Offset',
                    fixedCount: true,
                    points,
                } as PointListLayerData);
            }
        }
    }
    return layers;
};

/**
 * Builds a polygon layer from a vertices list member. Vertices written with references or math
 * (`[&~/SIZE/0, 0]`, the armor idiom) are evaluated for display and flagged so the webview shows
 * them but refuses to drag them (rewriting them would destroy the parameterization).
 */
const polygonLayerOf = async (
    fieldPath: readonly string[],
    fieldName: string,
    label: string,
    member: EffectiveMember | null,
    token: CancellationToken
): Promise<PolygonLayerData> => {
    const vertices: Array<{ point: GridPoint; origin: AstProvenance; isRef?: boolean }> = [];
    if (member && (isListNode(member.node) || isGroupNode(member.node))) {
        for (const element of member.node.elements) {
            const plain = readVector(element);
            if (plain) {
                vertices.push({ point: { x: plain.x, y: plain.y }, origin: provenanceOf(element, member.inherited) });
                continue;
            }
            const evaluated = await readVectorEvaluated(element, token).catch(() => null);
            if (evaluated) {
                vertices.push({ point: evaluated, origin: provenanceOf(element, member.inherited), isRef: true });
            }
        }
    }
    return {
        kind: 'polygon',
        ...layerBaseOf(fieldPath, fieldName, label, 'Colliders', member),
        vertices,
    };
};

/**
 * Builds a point layer over a pair of scalar fields (the railgun segment endpoints, written as
 * `XStartOffset`/`YStartOffset` and friends). The synthetic field name routes the edit back to the
 * two scalars.
 */
const scalarPairPointLayer = async (
    group: GroupNode,
    fieldPath: readonly string[],
    syntheticField: string,
    xField: string,
    yField: string,
    componentName: string,
    token: CancellationToken
): Promise<PointLayerData> => {
    const x = await effectiveMember(group, xField, token);
    const y = await effectiveMember(group, yField, token);
    const xValue = x ? numberOf(x.node) : null;
    const yValue = y ? numberOf(y.node) : null;
    return {
        kind: 'point',
        ...layerBaseOf(fieldPath, syntheticField, `${syntheticField} (${componentName})`, 'Components', x ?? y),
        point: xValue !== null && yValue !== null ? { x: xValue, y: yValue } : null,
    };
};

/** The scalar prohibit sugar fields with the rects they generate, per the decompiled expansion. */
const prohibitSugarRects = (
    size: { width: number; height: number },
    values: Partial<Record<'ProhibitLeft' | 'ProhibitRight' | 'ProhibitAbove' | 'ProhibitBelow', number>>
): Array<{ rect: { x: number; y: number; width: number; height: number }; label: string }> => {
    const rects: Array<{ rect: { x: number; y: number; width: number; height: number }; label: string }> = [];
    const left = values.ProhibitLeft;
    if (left) rects.push({ rect: { x: -left, y: 0, width: left, height: size.height }, label: 'ProhibitLeft' });
    const right = values.ProhibitRight;
    if (right) rects.push({ rect: { x: size.width, y: 0, width: right, height: size.height }, label: 'ProhibitRight' });
    const above = values.ProhibitAbove;
    if (above) rects.push({ rect: { x: 0, y: -above, width: size.width, height: above }, label: 'ProhibitAbove' });
    const below = values.ProhibitBelow;
    if (below) rects.push({ rect: { x: 0, y: size.height, width: size.width, height: below }, label: 'ProhibitBelow' });
    return rects;
};

/**
 * Builds the part-root layers of the sweep round: the prohibit rect list (with the scalar sugar
 * rendered as ghosts), the network overlay midpoint, and the root custom collider polygon.
 * @param part the part group.
 * @param size the effective part size, for the sugar rect expansion.
 * @param token cancels inheritance resolution.
 * @returns the layers.
 */
const partRootSweepLayers = async (
    part: GroupNode,
    size: { width: number; height: number },
    token: CancellationToken
): Promise<GridLayerData[]> => {
    const layers: GridLayerData[] = [];

    const prohibit = await effectiveMember(part, 'ProhibitRects', token);
    const entries: Array<{
        tag: string | null;
        rect: { x: number; y: number; width: number; height: number };
        origin: AstProvenance;
    }> = [];
    if (prohibit && (isListNode(prohibit.node) || isGroupNode(prohibit.node))) {
        for (const element of prohibit.node.elements) {
            if (!isListNode(element) || element.elements.length !== 2) continue;
            const rect = readRect(element.elements[1]);
            if (!rect) continue;
            entries.push({
                tag: enumNameOf(element.elements[0]),
                rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                origin: provenanceOf(element, prohibit.inherited),
            });
        }
    }
    const sugar: Partial<Record<'ProhibitLeft' | 'ProhibitRight' | 'ProhibitAbove' | 'ProhibitBelow', number>> = {};
    for (const field of ['ProhibitLeft', 'ProhibitRight', 'ProhibitAbove', 'ProhibitBelow'] as const) {
        const member = await effectiveMember(part, field, token);
        const value = member ? numberOf(member.node) : null;
        if (value !== null) sugar[field] = value;
    }
    layers.push({
        kind: 'rectList',
        ...layerBaseOf([], 'ProhibitRects', 'ProhibitRects', 'Regions', prohibit),
        entries,
        fallbackRects: prohibitSugarRects(size, sugar),
    } as RectListLayerData);

    const midpoint = await effectiveMember(part, 'PartNetworkOverlayMidpoint', token);
    layers.push({
        kind: 'point',
        ...layerBaseOf([], 'PartNetworkOverlayMidpoint', 'PartNetworkOverlayMidpoint', 'Networks', midpoint),
        point: midpoint ? await readVectorEvaluated(midpoint.node, token).catch(() => null) : null,
    } as PointLayerData);

    const custom = await effectiveMember(part, 'CustomCollider', token);
    if (custom) layers.push(await polygonLayerOf([], 'CustomCollider', 'CustomCollider', custom, token));

    return layers;
};

/**
 * Builds a point layer per graphics slot `Offset` (`Floor`, doodads, roof lighting, blueprint
 * sprite), so the sprite anchors are draggable.
 * @param part the part group.
 * @param token cancels inheritance resolution.
 * @returns the layers, only for slots the part actually declares.
 */
const graphicsOffsetLayers = async (part: GroupNode, token: CancellationToken): Promise<PointLayerData[]> => {
    const layers: PointLayerData[] = [];
    for (const { name, group, cls } of allComponents(part)) {
        if (!inAncestry(cls, GRAPHICS_RULES_CLASS)) continue;
        for (const slot of GRAPHICS_OFFSET_SLOTS) {
            const slotNode = childNamed(group, slot);
            if (!slotNode || !isGroupNode(slotNode)) continue;
            const offsetNode = childNamed(slotNode, 'Offset');
            const offset = readVector(offsetNode);
            const member: EffectiveMember | null = offsetNode ? { node: offsetNode, inherited: false } : null;
            layers.push({
                kind: 'point',
                ...layerBaseOf(['Components', name, slot], 'Offset', `${slot} offset (${name})`, 'Graphics', member),
                point: offset ? { x: offset.x, y: offset.y } : null,
            });
        }
    }
    return layers;
};

/**
 * Whether removing a group's local member would resurface inherited values: true when a base part
 * defines the member with at least one element. The edit generator uses this to decide what an
 * emptied field means. An empty local list shadowing an inherited list with values is a real
 * override, but when the base's list is empty too (armor bases write `AllowedDoorLocations = []`)
 * or no base defines the field, the empty local container is just leftover noise.
 * @param group the group owning the member.
 * @param name the member name.
 * @param token cancels reference resolution.
 * @returns true when a base part defines the member with values.
 */
export const inheritedMemberHasValues = async (
    group: GroupNode,
    name: string,
    token: CancellationToken
): Promise<boolean> => {
    const inherited = await findMemberThroughInheritance(group, name, resolveReference, token).catch(() => null);
    if (!inherited) return false;
    if (isListNode(inherited) || isGroupNode(inherited)) return inherited.elements.length > 0;
    // A scalar or reference base value cannot be judged element-wise, keep the override.
    return true;
};

/**
 * The enum names a base part writes for a member, ignoring the local declaration. Null when no
 * base defines the member (the game default applies then).
 * @param group the group owning the member.
 * @param name the member name.
 * @param token cancels reference resolution.
 * @returns the inherited names, or null.
 */
export const inheritedEnumNames = async (
    group: GroupNode,
    name: string,
    token: CancellationToken
): Promise<string[] | null> => {
    const inherited = await findMemberThroughInheritance(group, name, resolveReference, token).catch(() => null);
    return inherited ? readEnumNames(inherited) : null;
};

/**
 * The boolean value a base part writes for a member, ignoring the local declaration. Null when no
 * base defines it (or not as a plain boolean).
 * @param group the group owning the member.
 * @param name the member name.
 * @param token cancels reference resolution.
 * @returns the inherited boolean, or null.
 */
export const inheritedBoolean = async (
    group: GroupNode,
    name: string,
    token: CancellationToken
): Promise<boolean | null> => {
    const inherited = await findMemberThroughInheritance(group, name, resolveReference, token).catch(() => null);
    return inherited ? booleanOf(inherited) : null;
};

/**
 * The int list a base part writes for a member, ignoring the local declaration. Null when no base
 * defines it (or not as a plain number list).
 * @param group the group owning the member.
 * @param name the member name.
 * @param token cancels reference resolution.
 * @returns the inherited numbers, or null.
 */
export const inheritedIntList = async (
    group: GroupNode,
    name: string,
    token: CancellationToken
): Promise<number[] | null> => {
    const inherited = await findMemberThroughInheritance(group, name, resolveReference, token).catch(() => null);
    return inherited ? readIntList(inherited) : null;
};

/** The effective element values of a grid field, read through inheritance for override materialization. */
export interface EffectiveFieldState {
    /** The readable vectors (cells or fractional points) of a list field. */
    readonly cells: Array<{ x: number; y: number }>;
    /** The readable `{Key; Value}` entries of a map field. */
    readonly entries: Array<{ key: { x: number; y: number }; values: string[] }>;
    /** The readable `{ExternalCell; InternalCell}` pairs. */
    readonly pairs: Array<{ external: { x: number; y: number }; internal: { x: number; y: number } }>;
}

/**
 * Reads a grid field's effective elements (local or inherited), in the neutral shape the edit
 * generator uses to materialize a local override with a mutation applied.
 * @param container the group owning the field (the part root or a component).
 * @param fieldName the field name.
 * @param token cancels inheritance resolution.
 * @returns the readable elements (all empty when the field is absent everywhere).
 */
export const buildEffectiveFieldState = async (
    container: GroupNode,
    fieldName: string,
    token: CancellationToken
): Promise<EffectiveFieldState> => {
    const state: EffectiveFieldState = { cells: [], entries: [], pairs: [] };
    const member = await effectiveMember(container, fieldName, token);
    if (!member || (!isListNode(member.node) && !isGroupNode(member.node))) return state;
    for (const element of member.node.elements) {
        const vector = readVector(element);
        if (vector) {
            state.cells.push({ x: vector.x, y: vector.y });
            continue;
        }
        if (!isGroupNode(element)) continue;
        const key = readVector(childNamed(element, 'Key'));
        const value = childNamed(element, 'Value');
        if (key && value) {
            const values = readEnumNames(value);
            if (values) state.entries.push({ key: { x: key.x, y: key.y }, values });
            continue;
        }
        const external = readVector(childNamed(element, 'ExternalCell'));
        const internal = readVector(childNamed(element, 'InternalCell'));
        if (external && internal) {
            state.pairs.push({
                external: { x: external.x, y: external.y },
                internal: { x: internal.x, y: internal.y },
            });
        }
    }
    return state;
};

/**
 * Reads the part's effective `Size`, evaluating each component through references and math when it
 * is not a plain number.
 * @param part the part group.
 * @param token cancels resolution.
 * @returns the size with provenance, falling back to 1x1 with a null origin when unreadable.
 */
const readSize = async (
    part: GroupNode,
    token: CancellationToken
): Promise<{ width: number; height: number; origin: AstProvenance | null }> => {
    const member = await effectiveMember(part, 'Size', token);
    if (member) {
        const plain = readVector(member.node);
        if (plain) return { width: plain.x, height: plain.y, origin: provenanceOf(member.node, member.inherited) };
        if (isListNode(member.node) && member.node.elements.length === 2) {
            const width = await evaluateNumericValue(member.node.elements[0], token).catch(() => null);
            const height = await evaluateNumericValue(member.node.elements[1], token).catch(() => null);
            if (width !== null && height !== null) {
                return { width, height, origin: provenanceOf(member.node, member.inherited) };
            }
        }
    }
    return { width: 1, height: 1, origin: null };
};

/**
 * The margin of cells to render around the grid so out-of-bounds geometry (virtual cells, rects,
 * crew points) stays on canvas.
 * @param size the effective grid size.
 * @param layers the built layers.
 * @returns the margin, at least one cell.
 */
const marginFor = (size: { width: number; height: number }, layers: readonly GridLayerData[]): number => {
    let margin = 1;
    const cover = (x: number, y: number): void => {
        margin = Math.max(margin, -Math.floor(x), -Math.floor(y), Math.ceil(x - size.width + 1), Math.ceil(y - size.height + 1));
    };
    const coverRect = (rect: { x: number; y: number; width: number; height: number }): void => {
        cover(rect.x, rect.y);
        cover(rect.x + rect.width - 1, rect.y + rect.height - 1);
    };
    for (const layer of layers) {
        if (layer.kind === 'cellSet') {
            const base = layer.baseCell ?? { x: 0, y: 0 };
            for (const { cell } of layer.cells) cover(cell.x + base.x, cell.y + base.y);
        } else if (layer.kind === 'cellToValues') for (const { cell } of layer.entries) cover(cell.x, cell.y);
        else if (layer.kind === 'pointList') for (const { point } of layer.points) cover(point.x, point.y);
        else if (layer.kind === 'point' && layer.point) cover(layer.point.x, layer.point.y);
        else if (layer.kind === 'cell' && layer.cell) cover(layer.cell.x, layer.cell.y);
        else if (layer.kind === 'cellDirection' && layer.cell) cover(layer.cell.x, layer.cell.y);
        else if (layer.kind === 'cellRay' && layer.cell) cover(layer.cell.x, layer.cell.y);
        else if (layer.kind === 'polygon') for (const { point } of layer.vertices) cover(point.x, point.y);
        else if (layer.kind === 'circle' && layer.center) cover(layer.center.x, layer.center.y);
        else if (layer.kind === 'componentPoints') {
            for (const entry of layer.entries) if (entry.location) cover(entry.location.x, entry.location.y);
        } else if (layer.kind === 'rectList') {
            for (const { rect } of layer.entries) coverRect(rect);
            for (const { rect } of layer.fallbackRects) coverRect(rect);
        } else if (layer.kind === 'cellPairList') {
            for (const { external, internal } of layer.pairs) {
                cover(external.x, external.y);
                cover(internal.x, internal.y);
            }
        } else if (layer.kind === 'rect' && layer.rect) {
            coverRect(layer.rect);
        }
    }
    return margin;
};

/**
 * Builds the grid editor payload for the part at a document offset.
 * @param document the parsed part document.
 * @param offset the request's byte offset (anywhere inside the part group).
 * @param dataVersion the document version the payload reflects, echoed by edits.
 * @param token cancels resolution.
 * @returns the payload, or null when no part encloses the offset.
 */
export const buildPartGridData = async (
    document: AbstractNodeDocument,
    offset: number,
    dataVersion: number,
    token: CancellationToken
): Promise<PartGridData | null> => {
    const part = locatePartGroup(document, offset);
    if (!part) return null;

    const size = await readSize(part, token);
    const layers: GridLayerData[] = [];
    for (const spec of CELL_SET_FIELDS) layers.push(await cellSetLayer(part, spec, token));
    for (const spec of MAP_FIELDS) layers.push(await mapLayer(part, spec, token));
    layers.push(...(await crewLayers(part, token)));
    layers.push(await virtualCellsLayer(part, token));
    for (const field of RECT_FIELDS) layers.push(await rectLayer(part, field, token));
    layers.push(await componentPointsLayer(part, token));
    layers.push(...(await componentFieldLayers(part, token)));
    layers.push(...(await partRootSweepLayers(part, size, token)));
    layers.push(...(await graphicsOffsetLayers(part, token)));

    const [isRotateable, isFlippable, flipHRotate, flipVRotate, selectionTypeRotations] = await Promise.all([
        rotationBool(part, 'IsRotateable', token),
        rotationBool(part, 'IsFlippable', token),
        rotationIntList(part, 'FlipHRotate', token),
        rotationIntList(part, 'FlipVRotate', token),
        rotationIntList(part, 'SelectionTypeRotations', token),
    ]);

    const contiguityMember = await effectiveMember(part, 'AllowedContiguity', token);
    const fileName = decodeURIComponent(document.uri.replace(/\\/g, '/').split('/').pop() ?? 'Part');
    const anchorPosition = part.identifier?.position ?? part.position;
    return {
        partName: fileName.replace(/\.rules$/i, ''),
        dataVersion,
        anchor: Position.create(anchorPosition.line, anchorPosition.characterStart),
        size,
        margin: marginFor(size, layers),
        sprites: await collectSprites(part, token),
        layers,
        rotation: { isRotateable, isFlippable, flipHRotate, flipVRotate, selectionTypeRotations },
        contiguity: {
            values: contiguityMember ? readEnumNames(contiguityMember.node) : null,
            enumNames: enumDef(ADJACENCY_FLAGS_ENUM)?.members ?? [],
            origin: contiguityMember ? provenanceOf(contiguityMember.node, contiguityMember.inherited) : null,
        },
    };
};
