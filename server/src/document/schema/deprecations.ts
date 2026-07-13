/**
 * Renamed schema symbols — the current spelling to use in place of an old one, and why it changed.
 *
 * Cosmoteer occasionally renames a serialization type (or, in future, a field or enum value) between
 * game versions. A mod written against an older version still spells the old name, which the current
 * schema can only see as "not a valid type". Knowing the rename lets the tooling say "renamed to X"
 * instead, offer a one-click fix, and tell the modder their mod targets an older game version — far
 * more actionable than a bare invalid-type warning.
 *
 * This is the single registry of known renames, kept separate from the extracted schema (which only
 * knows the CURRENT names) so it is easy to extend as more are found. One lookup per symbol kind;
 * only `Type=` discriminator renames are known so far. To add a field or enum-value rename later, add a
 * `DEPRECATED_FIELDS` / `DEPRECATED_ENUM_VALUES` map and a matching lookup beside the discriminator one.
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
