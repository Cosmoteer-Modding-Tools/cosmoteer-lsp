/**
 * The figures a judged blueprint is described by: the roles and difficulty bands a ship can be
 * registered with, the signals read off its parts, the value the game rates it at and the strength
 * its difficulty is read from. The assessment module computes them and the register-ship shapes
 * carry them to the clients, so they live apart from both.
 */

/** The roles a built-in ship can be registered in, each with its own folder and tags. */
export type ShipRole =
    | 'combat'
    | 'trade'
    | 'crew_transport'
    | 'defense'
    | 'trade_station'
    | 'military_station'
    | 'wreckage'
    | 'starter'
    | 'storage_pod';

/** The difficulty bands the vanilla files write. */
export type ShipDifficulty = 1 | 2 | 3;

/** What the parts of a ship add up to, before anything is judged from it. */
export interface ShipSignals {
    /** How many parts the blueprint places. */
    readonly parts: number;
    /** How many of them are weapons. */
    readonly weapons: number;
    /** How many of them are thrusters. */
    readonly thrusters: number;
    /** How many of them are storage. */
    readonly storage: number;
    /** How many of them house crew. */
    readonly crewQuarters: number;
    /** How many of them are armor. */
    readonly armor: number;
    /** The damage per second of every weapon that declares one, together. */
    readonly dps: number;
    /** The health of every part together. */
    readonly health: number;
    /** The health of the armor alone. */
    readonly armorHealth: number;
    /** The crew the ship houses, filled to capacity the way a spawned ship is. */
    readonly crew: number;
    /** The cells the parts cover. */
    readonly tiles: number;
    /** The credits spent on weapons. */
    readonly weaponValue: number;
    /** The credits spent on armor. */
    readonly armorValue: number;
    /** The credits spent on thrusters. */
    readonly thrusterValue: number;
    /** The credits spent on storage. */
    readonly storageValue: number;
    /** The part ids the project declares nothing for, each once. */
    readonly unknownParts: readonly string[];
    /** The part ids known but unpriced, because a resource they take has no price, each once. */
    readonly unpricedParts: readonly string[];
}

/** The credits the ship is rated by, in the game's own split. */
export interface ShipValue {
    readonly parts: number;
    readonly doors: number;
    readonly crew: number;
    readonly total: number;
    /** True when the ship class's door price could not be read, so the doors count for nothing. */
    readonly doorsUnpriced: boolean;
}

/** What the difficulty was read from, so a client can show the reason beside the number. */
export interface ShipStrength {
    /** The share of the ship's value spent on weapons. */
    readonly weaponShare: number;
    /** What the game's own combat ships of the same tier spend on weapons, as a share. */
    readonly typicalWeaponShare: number;
    /** The share of the ship's value spent on armor. */
    readonly armorShare: number;
    /** What the game's own combat ships of the same tier spend on armor, as a share. */
    readonly typicalArmorShare: number;
    /** The two shares against their typical values, weighted, where `1` is the game's own norm. */
    readonly score: number;
}

/** What one blueprint was judged to be. */
export interface ShipAssessment {
    readonly fsPath: string;
    /** The ship's name, from the blueprint or from the file name. */
    readonly name: string;
    readonly shipRulesId?: string;
    readonly signals: ShipSignals;
    readonly value: ShipValue;
    /** The tier the game rates the ship's value at. */
    readonly valueTier: number;
    /** The difficulty band the ship's strength lands in. */
    readonly difficulty: ShipDifficulty;
    readonly strength: ShipStrength;
    /** The roles that fit the ship, the best fit first. */
    readonly roles: readonly ShipRole[];
}
