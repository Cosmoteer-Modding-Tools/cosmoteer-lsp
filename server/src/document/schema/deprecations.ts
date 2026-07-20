/**
 * Renamed schema symbols: the current spelling to use in place of an old one, and why it changed.
 *
 * Cosmoteer occasionally renames a serialization type (or, in future, a field or enum value) between
 * game versions. A mod written against an older version still spells the old name, which the current
 * schema can only see as "not a valid type". Knowing the rename lets the tooling say "renamed to X"
 * instead, offer a one-click fix, and tell the modder their mod targets an older game version. Far
 * more actionable than a bare invalid-type warning.
 *
 * This is the single registry of known renames and removals, kept separate from the extracted schema
 * (which only knows the current names) so it is easy to extend as more are found. One lookup per
 * symbol kind: `Type=` discriminator renames and deleted fields are known so far. To add an enum-value
 * rename later, add a `DEPRECATED_ENUM_VALUES` map and a matching lookup beside these.
 */

/** A renamed symbol: the spelling to use now, and a short note on why it changed. */
export interface Deprecation {
    /** The current name that replaces the deprecated one. */
    readonly replacement: string;
    /** A short human note on the rename, shown in the hint and on hover. */
    readonly note: string;
}

/** The reason the whole `Ammo*` family was renamed, shared by each of its entries. */
const AMMO_TO_RESOURCE = 'ammo was generalized into the resource system';

/**
 * Deprecated `Type=` discriminator values, by their old spelling. Cosmoteer folded the dedicated ammo
 * system into the generic resource system, renaming the whole `Ammo*` component / hit-effect family to
 * `Resource*` (ammo is just a resource now). Verified against the DLL: the old `Ammo*` names are absent
 * while every `Resource*` counterpart is present. Extend with future renames.
 */
const DEPRECATED_DISCRIMINATORS: Readonly<Record<string, Deprecation>> = {
    AmmoChange: { replacement: 'ResourceChange', note: AMMO_TO_RESOURCE },
    AmmoDrain: { replacement: 'ResourceDrain', note: AMMO_TO_RESOURCE },
    ExplosiveAmmoDrain: { replacement: 'ExplosiveResourceDrain', note: AMMO_TO_RESOURCE },
    AmmoStorage: { replacement: 'ResourceStorage', note: AMMO_TO_RESOURCE },
    AmmoConsumer: { replacement: 'ResourceConsumer', note: AMMO_TO_RESOURCE },
    AmmoConverter: { replacement: 'ResourceConverter', note: AMMO_TO_RESOURCE },
};

/**
 * The deprecation for a `Type=` discriminator value, if it is a known renamed type.
 *
 * @param written the discriminator value as written in the file (e.g. `AmmoChange`).
 * @returns the rename (current name + note), or undefined when the value is not a known deprecated type.
 */
export const deprecatedDiscriminator = (written: string): Deprecation | undefined =>
    DEPRECATED_DISCRIMINATORS[written];

/** A field the game deleted outright (no direct rename): the migration guidance to show for it. */
export interface FieldDeprecation {
    /** FullName of the class that used to read the field. */
    readonly className: string;
    /** A short human note on what replaced the field, shown in the hint and on hover. */
    readonly note: string;
}

/**
 * Deprecated (deleted) fields by lower-cased field name. The Meltdown fire rework deleted
 * `PartRules.Flammable` outright: the name no longer occurs anywhere in the game's code (verified
 * against the fully decompiled current Cosmoteer.dll). A part is now fireproofed by carrying the
 * `non_flammable` part category, which the fire status excludes via its part filter
 * (`Data/statuses/fire/fire.rules`, `ExcludePartCategories = [non_flammable]`). Vanilla still writes
 * the field in a dozen part files (stale leftovers the game ignores), so the schema keeps the member
 * (flagged `dead` in the overlay, which keeps old mods parsing and hovering) and this entry upgrades
 * the dead-field hint with the migration.
 */
const DEPRECATED_FIELDS: Readonly<Record<string, FieldDeprecation>> = {
    flammable: {
        className: 'Cosmoteer.Ships.Parts.PartRules',
        note: "fire immunity is now the 'non_flammable' part category: TypeCategories = [non_flammable]",
    },
};

/**
 * The deprecation for a class member, if the named field is a known deleted field of that class.
 *
 * @param className the FullName of the class that declares the field (the declaring ancestor when the
 * caller resolved a derived class).
 * @param fieldName the field name as written in the file.
 * @returns the deprecation (migration note), or undefined when the field is not a known deleted field
 * of that class.
 */
export const deprecatedField = (className: string, fieldName: string): FieldDeprecation | undefined => {
    const deprecation = DEPRECATED_FIELDS[fieldName.toLowerCase()];
    return deprecation && deprecation.className === className ? deprecation : undefined;
};
