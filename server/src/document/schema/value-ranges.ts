/**
 * Ranges the game reads in a direction, and the pairs of fields that stand for one.
 *
 * A `Range<T>` carries two endpoints and the schema puts no order on them, correctly: most ranges
 * are interpolation bounds and the game's own files write plenty that count down. What decides
 * whether a descending pair is a mistake is the consumer, and the consumers disagree. The random
 * number generator refuses a high below its low outright, its floating point twin clamps instead,
 * and the interpolation helpers take either order and mean it.
 *
 * Every entry is read out of the shipped assembly, from the call the endpoints reach. A field is
 * listed only where its consumer was followed to the end, since the same field name on two classes
 * can reach a throwing sink on one and an interpolation on the other.
 */

/** What the consumer does with a range whose endpoints are the wrong way round. */
export type RangeDirectionEffect =
    /** The integer roll refuses it, so the game throws where it draws the number. */
    | 'throws'
    /** The value is compared rather than rolled, so the feature can never come out true. */
    | 'neverTrue';

/** One range field whose direction the consumer cares about. */
export interface RangeDirectionRule {
    /** The class that owns the read, matched exactly. */
    readonly owner: string;
    /** The field carrying the range, or the pair of fields standing for one. */
    readonly field: string;
    /** The field holding the upper end, for the two-field spelling. */
    readonly upperField?: string;
    readonly effect: RangeDirectionEffect;
}

export const RANGE_DIRECTION_RULES: readonly RangeDirectionRule[] = [
    // Every one of these reaches `Rand.Int32(low, high)`, which throws on a high below its low. The
    // float overload clamps instead, so only the ones read as whole numbers are listed. The ship
    // spawner's health range is a float range and belongs here anyway: it converts to integers
    // before rolling, so it reaches the throwing overload.
    { owner: 'Cosmoteer.Ships.Parts.Weapons.EmitterRules', field: 'Pellets', effect: 'throws' },
    { owner: 'Cosmoteer.Simulation.HitEffects.ChainLightningEffectRules', field: 'ChainStrikes', effect: 'throws' },
    { owner: 'Cosmoteer.Generators.Galaxies.MapNodesSpawner', field: 'Count', effect: 'throws' },
    { owner: 'Cosmoteer.Backgrounds.BackgroundObjectRules', field: 'Count', effect: 'throws' },
    { owner: 'Cosmoteer.Generators.Simulation.ResourceTypeLoadoutRules', field: 'Quantity', effect: 'throws' },
    { owner: 'Cosmoteer.Modes.Career.Map.RandomNodeTiersSpawner', field: 'TierRangeLow', effect: 'throws' },
    { owner: 'Cosmoteer.Modes.Career.Map.RandomNodeTiersSpawner', field: 'TierRangeHigh', effect: 'throws' },
    { owner: 'Cosmoteer.Generators.Simulation.ShipSpawner', field: 'RandomHealthRange', effect: 'throws' },
    {
        owner: 'Cosmoteer.Modes.Career.Missions.Objectives.DebugEventObjective/Spawner',
        field: 'EventCount',
        effect: 'throws',
    },
    {
        owner: 'Cosmoteer.Modes.Career.Missions.Objectives.DefeatShipsObjective/Spawner',
        field: 'TargetCount',
        effect: 'throws',
    },
    {
        owner: 'Cosmoteer.Modes.Career.Missions.Objectives.DontSurrenderToObjective/Spawner',
        field: 'TargetCount',
        effect: 'throws',
    },
    {
        owner: 'Cosmoteer.Modes.Career.Missions.Objectives.ProtectShipsObjective/Spawner',
        field: 'TargetCount',
        effect: 'throws',
    },
    {
        owner: 'Cosmoteer.Modes.Career.Missions.Objectives.DeliverResourcesObjective/Spawner',
        field: 'Amount',
        effect: 'throws',
    },
    {
        owner: 'Cosmoteer.Modes.Career.Missions.Objectives.DiscoverPOIsObjective/Spawner',
        field: 'DiscoverCount',
        effect: 'throws',
    },
    // The two generator stages spell one range as two fields, and roll between them the same way.
    {
        owner: 'Cosmoteer.Generators.Ships.Stages.AsteroidStage',
        field: 'MinParts',
        upperField: 'MaxParts',
        effect: 'throws',
    },
    {
        owner: 'Cosmoteer.Generators.Ships.Stages.AsteroidDepositsStage',
        field: 'MinPartsPerDeposit',
        upperField: 'MaxPartsPerDeposit',
        effect: 'throws',
    },
    // These two are compared rather than rolled. A mode cycle whose range counts down simply never
    // cycles, and a part criteria whose window does never matches a part.
    { owner: 'Cosmoteer.Ships.Parts.Logic.PartModeCycleRules', field: 'ModeRange', effect: 'neverTrue' },
    { owner: 'Cosmoteer.Ships.Parts.RelativePartCriteria', field: 'Left', effect: 'neverTrue' },
    { owner: 'Cosmoteer.Ships.Parts.RelativePartCriteria', field: 'Right', effect: 'neverTrue' },
    { owner: 'Cosmoteer.Ships.Parts.RelativePartCriteria', field: 'Top', effect: 'neverTrue' },
    { owner: 'Cosmoteer.Ships.Parts.RelativePartCriteria', field: 'Bottom', effect: 'neverTrue' },
];
