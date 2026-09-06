import { PartStats, PartStatsIndex } from '../part-table/part-table.types';
import { CareerBalance, estimatedTier } from './career-balance';
import { ShipAssessment, ShipDifficulty, ShipRole, ShipSignals, ShipStrength, ShipValue } from './ship-assessment.types';
import { Blueprint } from './ship-blueprint';

/**
 * Judging a saved ship the way the game and its own designers do, so a modder's ship can be
 * registered with a tier, a difficulty and a role that fit it, without a single number typed by hand.
 *
 * The tier is the game's own arithmetic and nothing else: `Ship.DifficultyValue` is the price of
 * every part and door plus the crew the ship houses at `CostPerCrew` each, and
 * `CareerGameModeManager.GetEstimatedTier` turns that value into a tier through `TierValueMaximums`.
 * A ship spawned from the built-in database is loaded with its crew filled to capacity
 * (`ShipSpawner` passes `SpawnCrew`, and `MatchPhysicalToBlueprints` fills every crew source), so
 * the crew counted is what the parts can house. Over the game's own combat ships the formula lands
 * on the authored tier for five in six and within one tier for the rest.
 *
 * The difficulty is a different kind of figure. The game reads it only as a filter a spawner may
 * set, and no vanilla spawner sets one, so it is a designer's note on how hard the ship is for its
 * tier rather than anything the game computes. Nothing in the parts reproduces what the designers
 * wrote, so the suggestion here says something a modder can check instead: how much of the ship's
 * value goes into weapons and armor, against what the game's own ships of the same tier spend. A
 * ship spending as they do is a `2`, one spending clearly less a `1`, one spending clearly more a
 * `3`, and the shares are handed back so the reason can be shown.
 *
 * The role is read off the parts and the name. Platforms and stations are what the game's own
 * files call them by name, and beyond the name a ship that puts almost nothing into thrusters
 * does not fly. A flying ship whose crew is most of its value carries people, one whose storage
 * outweighs its guns carries cargo, and the rest fight. Over the game's own ships the rule agrees
 * with the authored role for all but three of 873.
 */

/** Every role, in the order the clients offer them. */
export const SHIP_ROLES: readonly ShipRole[] = [
    'combat',
    'trade',
    'crew_transport',
    'defense',
    'trade_station',
    'military_station',
    'wreckage',
    'starter',
    'storage_pod',
];

/** The type categories the roles and the difficulty are read from, folded. */
const WEAPON_CATEGORY = 'weapon';
const DEFENSE_CATEGORY = 'defense';
const THRUSTER_CATEGORY = 'thruster';
const STORAGE_CATEGORY = 'storage';
const CREW_CATEGORY = 'provides_crew';
const ARMOR_CATEGORY = 'armor';

/**
 * What the game's own combat ships spend on weapons, as a share of their value, by authored tier.
 * The medians over the 673 vanilla combat ships. A ship's own share is read against the entry for
 * its tier, and the last entry stands for every tier past the table.
 */
const TYPICAL_WEAPON_SHARE: readonly number[] = [
    0.067, 0.108, 0.158, 0.178, 0.213, 0.25, 0.221, 0.235, 0.246, 0.26, 0.227, 0.219, 0.249, 0.239, 0.235, 0.237,
    0.233, 0.279,
];

/** The same for armor. */
const TYPICAL_ARMOR_SHARE: readonly number[] = [
    0.02, 0.037, 0.044, 0.056, 0.047, 0.059, 0.075, 0.066, 0.07, 0.075, 0.065, 0.092, 0.087, 0.093, 0.095, 0.109,
    0.116, 0.118,
];

/** How much of the strength score the weapons decide, the armor deciding the rest. */
const WEAPON_WEIGHT = 0.7;

/**
 * Where the strength score splits into the three bands. Placed so that the game's own combat ships
 * fall one in five below, three in five within and one in five above, which is the spread the
 * authored files themselves have across the bands.
 */
const STRENGTH_BANDS: Readonly<Record<'inLine' | 'above', number>> = { inLine: 0.8, above: 1.2 };

/** A file name the game's own files give a defense platform. */
const PLATFORM_NAME = /platform|turret|emplacement/i;

/** A file name the game's own files give a station. */
const STATION_NAME = /station|depot|outpost|fort/i;

/**
 * Below this share of value in thrusters, and this many thrusters per part, a ship does not fly.
 * The game's own stations sit under both while its combat ships sit over at least one.
 */
const STATION_THRUSTER_SHARE = 0.037;
const STATION_THRUSTERS_PER_PART = 0.025;

/** From this share of value in crew a flying, unarmed ship carries people rather than cargo. */
const CREW_TRANSPORT_CREW_SHARE = 0.17;

/** A flying ship with at least this much in storage and at most this much in weapons trades. */
const TRADE_STORAGE_SHARE = 0.1;
const TRADE_WEAPON_SHARE = 0.12;

/** From this share of value in weapons an immobile ship is a military station rather than a trading one. */
const MILITARY_STATION_WEAPON_SHARE = 0.11;

/**
 * Whether a part is a weapon. The `weapon` category is what the game's own weapons declare, but not
 * all of them: the chaingun, the flak cannon and the point defense carry categories of their own, so
 * a part that deals damage or is filed as a defense counts as well.
 *
 * @param part the part's figures.
 * @param categories its categories, folded.
 * @returns true when the part fights.
 */
const isWeapon = (part: PartStats, categories: ReadonlySet<string>): boolean =>
    categories.has(WEAPON_CATEGORY) || categories.has(DEFENSE_CATEGORY) || (part.dps ?? 0) > 0;

/**
 * The ship's name: its file name without the `.ship.png` ending. The game names a loaded ship the
 * same way, whatever name was saved inside it, and a built-in ship's id is made of it.
 *
 * @param fsPath the blueprint's file.
 * @returns the name.
 */
export const blueprintName = (fsPath: string): string => {
    const base = fsPath.replace(/\\/g, '/').split('/').pop() ?? fsPath;
    return base.replace(/\.ship\.png$/i, '');
};

/**
 * What the parts of a blueprint add up to.
 *
 * @param blueprint the blueprint.
 * @param stats the project's parts, by id.
 * @returns the signals.
 */
const signalsOf = (blueprint: Blueprint, stats: PartStatsIndex): ShipSignals => {
    let weapons = 0;
    let thrusters = 0;
    let storage = 0;
    let crewQuarters = 0;
    let armor = 0;
    let dps = 0;
    let health = 0;
    let armorHealth = 0;
    let crew = 0;
    let tiles = 0;
    let weaponValue = 0;
    let armorValue = 0;
    let thrusterValue = 0;
    let storageValue = 0;
    const unknown = new Set<string>();
    const unpriced = new Set<string>();
    for (const placed of blueprint.parts) {
        const part = stats.byId.get(placed.id.toLowerCase());
        if (!part) {
            unknown.add(placed.id);
            continue;
        }
        if (part.cost === null) unpriced.add(placed.id);
        const categories = new Set(part.categories.map((category) => category.toLowerCase()));
        const cost = part.cost ?? 0;
        const isArmor = categories.has(ARMOR_CATEGORY);
        if (isWeapon(part, categories)) {
            weapons++;
            weaponValue += cost;
        }
        if (categories.has(THRUSTER_CATEGORY)) {
            thrusters++;
            thrusterValue += cost;
        }
        if (categories.has(STORAGE_CATEGORY)) {
            storage++;
            storageValue += cost;
        }
        if (categories.has(CREW_CATEGORY)) crewQuarters++;
        if (isArmor) {
            armor++;
            armorValue += cost;
            armorHealth += part.maxHealth ?? 0;
        }
        dps += part.dps ?? 0;
        health += part.maxHealth ?? 0;
        crew += part.crewCapacity;
        tiles += part.tiles ?? 0;
    }
    return {
        parts: blueprint.parts.length,
        weapons,
        thrusters,
        storage,
        crewQuarters,
        armor,
        dps,
        health,
        armorHealth,
        crew,
        tiles,
        weaponValue,
        armorValue,
        thrusterValue,
        storageValue,
        unknownParts: [...unknown],
        unpricedParts: [...unpriced],
    };
};

/**
 * The credits the ship is rated by, split the way the game sums them.
 *
 * @param blueprint the blueprint.
 * @param stats the project's parts, by id.
 * @param balance what the game rates a ship by.
 * @param crew the crew the ship houses.
 * @returns the value.
 */
const valueOf = (blueprint: Blueprint, stats: PartStatsIndex, balance: CareerBalance, crew: number): ShipValue => {
    let parts = 0;
    for (const placed of blueprint.parts) parts += stats.byId.get(placed.id.toLowerCase())?.cost ?? 0;
    const doorCost = blueprint.shipRulesId
        ? balance.doorCostByShipClass.get(blueprint.shipRulesId.toLowerCase())
        : undefined;
    const doors = (doorCost ?? 0) * blueprint.doors;
    const crewValue = crew * balance.costPerCrew;
    return {
        parts,
        doors,
        crew: crewValue,
        total: parts + doors + crewValue,
        doorsUnpriced: doorCost === undefined && blueprint.doors > 0,
    };
};

/** A share of the ship's value, zero for a ship worth nothing. */
const shareOf = (part: number, total: number): number => (total > 0 ? part / total : 0);

/**
 * The typical share for a tier, the last table entry standing for every tier past it.
 *
 * @param table the shares by tier, from tier one.
 * @param tier the tier.
 * @returns the share.
 */
const typicalAt = (table: readonly number[], tier: number): number =>
    table[Math.min(table.length, Math.max(1, tier)) - 1];

/**
 * How the ship's spending on weapons and armor compares with the game's own ships of its tier.
 *
 * @param signals what the parts add up to.
 * @param value the ship's value.
 * @param tier the ship's value tier.
 * @returns the strength.
 */
const strengthOf = (signals: ShipSignals, value: ShipValue, tier: number): ShipStrength => {
    const weaponShare = shareOf(signals.weaponValue, value.total);
    const armorShare = shareOf(signals.armorValue, value.total);
    const typicalWeaponShare = typicalAt(TYPICAL_WEAPON_SHARE, tier);
    const typicalArmorShare = typicalAt(TYPICAL_ARMOR_SHARE, tier);
    const score =
        WEAPON_WEIGHT * (weaponShare / typicalWeaponShare) + (1 - WEAPON_WEIGHT) * (armorShare / typicalArmorShare);
    return { weaponShare, typicalWeaponShare, armorShare, typicalArmorShare, score };
};

/**
 * The difficulty band a strength lands in.
 *
 * @param strength the strength.
 * @returns the band.
 */
const difficultyOf = (strength: ShipStrength): ShipDifficulty =>
    strength.score >= STRENGTH_BANDS.above ? 3 : strength.score >= STRENGTH_BANDS.inLine ? 2 : 1;

/**
 * The roles that fit the ship, best first.
 *
 * @param signals what the parts add up to.
 * @param value the ship's value.
 * @param name the ship's name, which the game's own files name platforms and stations by.
 * @returns the roles, every one of them, ranked.
 */
const rolesOf = (signals: ShipSignals, value: ShipValue, name: string): ShipRole[] => {
    const weaponShare = shareOf(signals.weaponValue, value.total);
    const thrusterShare = shareOf(signals.thrusterValue, value.total);
    const storageShare = shareOf(signals.storageValue, value.total);
    const crewShare = shareOf(value.crew, value.total);
    const thrustersPerPart = signals.parts > 0 ? signals.thrusters / signals.parts : 0;
    let ranked: ShipRole[];
    if (PLATFORM_NAME.test(name)) {
        ranked = ['defense', 'military_station', 'combat'];
    } else if (
        STATION_NAME.test(name) ||
        (thrusterShare < STATION_THRUSTER_SHARE && thrustersPerPart < STATION_THRUSTERS_PER_PART)
    ) {
        ranked =
            weaponShare < MILITARY_STATION_WEAPON_SHARE
                ? ['trade_station', 'military_station', 'trade']
                : ['military_station', 'trade_station', 'defense'];
    } else if (crewShare >= CREW_TRANSPORT_CREW_SHARE) {
        ranked = ['crew_transport', 'trade', 'combat'];
    } else if (storageShare >= TRADE_STORAGE_SHARE && weaponShare <= TRADE_WEAPON_SHARE) {
        ranked = ['trade', 'combat', 'crew_transport'];
    } else {
        ranked = ['combat', 'trade', 'defense'];
    }
    return [...ranked, ...SHIP_ROLES.filter((role) => !ranked.includes(role))];
};

/**
 * Judges one blueprint.
 *
 * @param fsPath the blueprint's file.
 * @param blueprint what it places.
 * @param stats the project's parts, by id.
 * @param balance what the game rates a ship by.
 * @returns the assessment.
 */
export const assessBlueprint = (
    fsPath: string,
    blueprint: Blueprint,
    stats: PartStatsIndex,
    balance: CareerBalance
): ShipAssessment => {
    const name = blueprintName(fsPath);
    const signals = signalsOf(blueprint, stats);
    const value = valueOf(blueprint, stats, balance, signals.crew);
    const valueTier = estimatedTier(value.total, balance.tierValueMaximums);
    const strength = strengthOf(signals, value, valueTier);
    return {
        fsPath: fsPath.replace(/\\/g, '/'),
        name,
        shipRulesId: blueprint.shipRulesId,
        signals,
        value,
        valueTier,
        difficulty: difficultyOf(strength),
        strength,
        roles: rolesOf(signals, value, name),
    };
};

/** The highest tier the game's own galaxy generates, the ceiling every suggested tier is held to. */
const HIGHEST_TIER = 18;

/**
 * The tier a ship of a value tier is registered at in a role.
 *
 * A ship, a platform and a trader take the game's own figure. A station does not: the game's own
 * stations are authored well under their value, because a station is meant to outweigh the ships
 * of the systems it stands in. The trade stations follow a line fitted to the 32 vanilla ones
 * (a value tier of 12 reads as 5, of 15 as 10, of 18 as 15), and the military stations sit three
 * tiers under their value.
 *
 * @param role the role.
 * @param valueTier the tier the game rates the ship's value at.
 * @returns the tier to write.
 */
export const tierForRole = (role: ShipRole, valueTier: number): number => {
    const clamp = (tier: number): number => Math.min(HIGHEST_TIER, Math.max(1, Math.round(tier)));
    if (role === 'trade_station') return clamp(1.7 * valueTier - 15.3);
    if (role === 'military_station') return clamp(valueTier - 3);
    return clamp(valueTier);
};

/**
 * The tier a station starts appearing at, for the roles that write one. The game's own military
 * stations appear a couple of tiers before the tier they are rated at.
 *
 * @param role the role.
 * @param tier the tier being written.
 * @returns the spawn tier, or undefined for a role that writes none.
 */
export const spawnTierForRole = (role: ShipRole, tier: number): number | undefined =>
    role === 'military_station' ? Math.max(1, tier - 2) : undefined;
