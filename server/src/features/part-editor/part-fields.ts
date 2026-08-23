/**
 * The part-root fields the grid editor draws and the geometry check judges, in one table each so
 * both read the same list. Kept in its own module rather than in the data service because the
 * validator seeds the cache build id: importing the service would pull the whole editor into the
 * hashed closure and make every editor edit discard the users' on-disk caches.
 *
 * The mode-surface table below is here for the same reason from the other direction: the wiring
 * report and the mod overview's part-unlock section both read it, and the report itself must stay
 * out of that closure.
 */
import { schema } from '../../document/schema/schema';
import { ValueType } from '../../document/schema/schema.types';
import { isSameOrSubclass } from '../navigation/schema-id-reference.navigation';

/** The schema class a part's root group resolves to. */
export const PART_RULES_CLASS = 'Cosmoteer.Ships.Parts.PartRules';

export const ADJACENCY_FLAGS_ENUM = 'Cosmoteer.Ships.Parts.AdjacencyFlags';
export const TRAVEL_DIRECTION_ENUM = 'Cosmoteer.Ships.Crew.TravelDirection';

/**
 * The part-root cell-set fields, one `cellSet` layer each. Door locations name the outside cells a
 * door may connect to (the game's `AllowsDoorAt` identifies the outside cell of a door against
 * them), blocked travel cells sit inside the part rect.
 */
export const CELL_SET_FIELDS: ReadonlyArray<{ readonly field: string; readonly domain: 'inside' | 'outside' | 'any' }> =
    [
        { field: 'AllowedDoorLocations', domain: 'outside' },
        { field: 'BlockedTravelCells', domain: 'inside' },
    ];

/** The part-root map fields, one `cellToValues` layer each. */
export const MAP_FIELDS: ReadonlyArray<{
    readonly field: string;
    readonly valueModel: 'flags' | 'enumList';
    readonly enumRef: string;
    /** The whole-part scalar field the map overrides per cell, shown as a ghost fallback. */
    readonly fallbackField: string | null;
}> = [
    {
        field: 'BlockedTravelCellDirections',
        valueModel: 'enumList',
        enumRef: TRAVEL_DIRECTION_ENUM,
        fallbackField: null,
    },
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
export const RECT_FIELDS = ['PhysicalRect', 'SaveRect'] as const;

/** The career tech class whose `PartsUnlocked` decides when a part becomes buildable. */
export const TECH_RULES_CLASS = 'Cosmoteer.Modes.Career.TechTree.TechRules';

/** The build battle's own tech class, which carries a parallel `PartsUnlocked`. */
export const BUILD_BATTLE_TECH_RULES_CLASS = 'Cosmoteer.Modes.Pvp.BuildBattle.BuildBattleTechRules';

/**
 * Whether a schema value type reaches a reference to a part, through list, map or tuple nesting.
 *
 * @param valueType the field's value type.
 * @returns true when a value of that type names a part.
 */
const reachesPartReference = (valueType: ValueType | undefined): boolean => {
    if (!valueType) return false;
    switch (valueType.kind) {
        case 'reference':
            return isSameOrSubclass(valueType.target, PART_RULES_CLASS);
        case 'list':
        case 'range':
        case 'interpolated':
            return reachesPartReference(valueType.element);
        case 'map':
            return reachesPartReference(valueType.key) || reachesPartReference(valueType.value);
        case 'tuple':
            return valueType.elements.some(reachesPartReference);
        default:
            return false;
    }
};

/**
 * Every field of a `Cosmoteer.Modes.*` class whose value names a part, keyed by the lower-cased
 * field name and mapping to the classes that declare it. Derived from the schema at module load, so
 * a game update that adds a mode surface is picked up by regenerating the schema rather than by
 * editing this file. Today it holds exactly five declarations under three names: `PartsUnlocked`
 * (career techs and build-battle techs), `PartID` (both `ToggleChoice` shapes) and `PartsWhitelist`
 * (the build-battle mode). The key is the field name rather than the class because a tech element's
 * owner class only resolves once the alias chain that roots `techs.rules` has run, and a reader of
 * this table has to degrade to a looser match instead of to nothing.
 */
export const MODE_PART_FIELDS: ReadonlyMap<string, readonly string[]> = (() => {
    const byName = new Map<string, string[]>();
    for (const [fullName, type] of Object.entries(schema.types)) {
        if (!fullName.startsWith('Cosmoteer.Modes.')) continue;
        for (const field of type.fields ?? []) {
            if (!reachesPartReference(field.valueType)) continue;
            const key = field.name.toLowerCase();
            (byName.get(key) ?? byName.set(key, []).get(key)!).push(fullName);
        }
    }
    return byName;
})();
