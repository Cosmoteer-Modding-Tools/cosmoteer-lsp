/**
 * The part-root fields the grid editor draws and the geometry check judges, in one table each so
 * both read the same list. Kept in its own module rather than in the data service because the
 * validator seeds the cache build id: importing the service would pull the whole editor into the
 * hashed closure and make every editor edit discard the users' on-disk caches.
 */

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
