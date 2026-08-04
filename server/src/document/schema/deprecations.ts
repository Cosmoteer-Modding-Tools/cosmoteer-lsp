/**
 * Renamed, deleted, and superseded schema symbols, organized by the game version that changed them.
 *
 * Cosmoteer occasionally renames a serialization type, renames or deletes a field, or supersedes a
 * field with a richer one between game versions. A mod written against an older version still spells
 * the old name, which the current schema can only see as "not a valid type" / "not a member". Knowing
 * the change lets the tooling say "renamed to X in 0.23.0" instead, offer a one-click fix, and tell
 * the modder their mod targets an older game version. Far more actionable than a bare invalid-name
 * warning, and the same registry drives the whole-workspace migration command.
 *
 * This is the single registry of known changes, kept separate from the extracted schema (which only
 * knows the current names) so it is easy to extend when the next game update lands: add a new
 * version section below and fill the four maps. Every entry carries the game `version` that made the
 * change, shown in hints and used to group the migration report. Entries whose version predates the
 * Steam changelog record omit it. Four symbol kinds are modelled:
 *   - {@link DEPRECATED_DISCRIMINATORS}: renamed `Type=` discriminator values,
 *   - {@link DEPRECATED_FIELDS}: fields the game deleted outright (the old name no longer occurs in
 *     the game's code),
 *   - {@link RENAMED_FIELD_ALIASES}: fields the game renamed but still deserializes under the old
 *     spelling (the schema carries both names, so without this registry the old spelling is silent),
 *   - {@link OBSOLETE_FIELDS}: fields that still work but were superseded by a richer field.
 * To add an enum-value rename later, add a `DEPRECATED_ENUM_VALUES` map and a matching lookup.
 *
 * Every entry is verified against the current game DLL through the extracted schema: a deleted
 * field's name is absent, a renamed alias carries both spellings on one schema field, an obsolete
 * field exists alongside its successor. Sources: the official changelogs (cosmoteer.wiki.gg
 * transcriptions of the Steam posts) cross-checked against the schema extraction.
 */

/** A renamed symbol: the spelling to use now, and a short note on why it changed. */
export interface Deprecation {
    /** The current name that replaces the deprecated one. */
    readonly replacement: string;
    /** A short human note on the rename, shown in the hint and on hover. */
    readonly note: string;
    /** The game version that made the change, when the changelog records it (e.g. `0.23.0`). */
    readonly version?: string;
}

/** The reason the whole `Ammo*` family was renamed, shared by each of its entries. */
const AMMO_TO_RESOURCE = 'ammo was generalized into the resource system';

/**
 * Deprecated `Type=` discriminator values, by their old spelling. Cosmoteer folded the dedicated ammo
 * system into the generic resource system, renaming the whole `Ammo*` component / hit-effect family to
 * `Resource*` (ammo is just a resource now). Verified against the DLL: the old `Ammo*` names are absent
 * while every `Resource*` counterpart is present. The rename predates the recorded changelogs, so the
 * entries carry no version.
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

/** A field the game deleted outright (no old spelling left in its code): the migration guidance. */
export interface FieldDeprecation {
    /** FullName of the class that used to read the field. */
    readonly className: string;
    /** A short human note on what replaced the field, shown in the hint and on hover. */
    readonly note: string;
    /** The game version that deleted the field, when the changelog records it. */
    readonly version?: string;
    /**
     * The same-shaped field that took over the deleted one's job, when one exists. The fix then
     * renames instead of removing, so the author's configured value survives the migration.
     */
    readonly replacement?: string;
    /**
     * True when the changelog sanctions plain removal as the migration (the field is unused, nothing
     * replaces it). The workspace migration then applies the remove fix. Without this flag a
     * fix-less deleted field is only reported, since removing it may drop author intent that should
     * move elsewhere (e.g. a smoothing value that belongs in a ContinuousEffects component now).
     */
    readonly removeOnMigrate?: boolean;
}

/**
 * Deprecated (deleted) fields by lower-cased field name. Each name no longer occurs anywhere in the
 * game's code (verified against the fully decompiled current Cosmoteer.dll / the extracted schema).
 * Where vanilla still writes a deleted field (stale leftovers the game ignores), the schema keeps the
 * member flagged `dead` in the overlay, which keeps old mods parsing and hovering, and the entry here
 * upgrades the dead-field hint with the migration.
 */
const DEPRECATED_FIELDS: Readonly<Record<string, FieldDeprecation>> = {
    // ---- 0.24.1 ----
    penetrationrecttype: {
        className: 'Cosmoteer.Bullets.Hits.BulletPenetratingHitRules',
        note: 'the parameter is unused and can be safely removed',
        version: '0.24.1',
        removeOnMigrate: true,
    },
    // ---- 0.26.1 ----
    suppresswholeshiptargetoverlaysforpartsfilter: {
        className: 'Cosmoteer.Ships.Parts.Weapons.WeaponRules',
        note: "its functionality is covered by 'SuppressDirectControlWhenTargetingPartsFilter'",
        version: '0.26.1',
        replacement: 'SuppressDirectControlWhenTargetingPartsFilter',
    },
    suppresswholeshiptargetoverlayswhentargetingshiprelativepoints: {
        className: 'Cosmoteer.Ships.Parts.Weapons.WeaponRules',
        note: "its functionality is covered by 'SuppressShipWideExplicitTargetsWhenTargetingShipRelativePoints'",
        version: '0.26.1',
        replacement: 'SuppressShipWideExplicitTargetsWhenTargetingShipRelativePoints',
    },
    valueoutputsmoothing: {
        className: 'Cosmoteer.Ships.Parts.Thrusters.ThrusterRules',
        note: "use the 'IntensityTweenDuration' of a ContinuousEffects component instead",
        version: '0.26.1',
    },
    // ---- 0.30.0 (Meltdown) ----
    flammable: {
        className: 'Cosmoteer.Ships.Parts.PartRules',
        note: "fire immunity is now the 'non_flammable' part category: TypeCategories = [non_flammable]",
        version: '0.30.0',
    },
};

/**
 * The deprecation for a class member, if the named field is a known deleted field of that class.
 *
 * @param className the FullName of the class that declares the field (callers try each ancestor of
 * a derived class, since the registry records the declaring class).
 * @param fieldName the field name as written in the file.
 * @returns the deprecation (migration note), or undefined when the field is not a known deleted field
 * of that class.
 */
export const deprecatedField = (className: string, fieldName: string): FieldDeprecation | undefined => {
    const deprecation = DEPRECATED_FIELDS[fieldName.toLowerCase()];
    return deprecation && deprecation.className === className ? deprecation : undefined;
};

/** A field rename whose old spelling the game still deserializes: the modern spelling to prefer. */
export interface FieldRename {
    /** FullNames of the classes that carry the renamed field. */
    readonly classNames: readonly string[];
    /** The current field name that replaces the old spelling. */
    readonly replacement: string;
    /** A short human note on the rename, shown in the hint and on hover. */
    readonly note: string;
    /** The game version that made the rename. */
    readonly version: string;
}

/** The 0.23.0 caveat shared by the `SourceShip*` → `FriendlyShip*` family: not a pure rename. */
const SOURCE_TO_FRIENDLY = 'the behavior now also covers all friendly ships, not just the firing ship';

/**
 * Renamed fields the game still accepts under the old spelling, by lower-cased old name. The schema
 * carries both spellings as aliases of one field, so the old name deserializes fine and no other
 * check ever flags it. This registry is the only source that says "prefer the modern name". Verified
 * against the extracted schema: each old spelling is a serialization alias of its replacement.
 */
const RENAMED_FIELD_ALIASES: Readonly<Record<string, FieldRename>> = {
    // ---- 0.23.0 ----
    createpartwhendestroyed: {
        classNames: ['Cosmoteer.Ships.Parts.PartRules'],
        replacement: 'UnderlyingPart',
        note: 'renamed; the old name is still accepted for backwards-compatibility',
        version: '0.23.0',
    },
    createpartpertilewhendestroyed: {
        classNames: ['Cosmoteer.Ships.Parts.PartRules'],
        replacement: 'UnderlyingPartPerTile',
        note: 'renamed; the old name is still accepted for backwards-compatibility',
        version: '0.23.0',
    },
    sourceshiplowcollisions: {
        classNames: [
            'Cosmoteer.Ships.Parts.Weapons.BeamEmitterRules',
            'Cosmoteer.Bullets.Hits.BulletPenetratingHitRules',
            'Cosmoteer.Bullets.Hits.BulletSimpleHitRules',
        ],
        replacement: 'FriendlyShipLowCollisions',
        note: SOURCE_TO_FRIENDLY,
        version: '0.23.0',
    },
    sourceshiphighcollisions: {
        classNames: [
            'Cosmoteer.Ships.Parts.Weapons.BeamEmitterRules',
            'Cosmoteer.Bullets.Hits.BulletPenetratingHitRules',
            'Cosmoteer.Bullets.Hits.BulletSimpleHitRules',
        ],
        replacement: 'FriendlyShipHighCollisions',
        note: SOURCE_TO_FRIENDLY,
        version: '0.23.0',
    },
    ignoresourceshiplowloschecks: {
        classNames: ['Cosmoteer.Ships.Parts.Weapons.WeaponRules'],
        replacement: 'IgnoreFriendlyShipLowLOSChecks',
        note: SOURCE_TO_FRIENDLY,
        version: '0.23.0',
    },
    ignoresourceshiphighloschecks: {
        classNames: ['Cosmoteer.Ships.Parts.Weapons.WeaponRules'],
        replacement: 'IgnoreFriendlyShipHighLOSChecks',
        note: SOURCE_TO_FRIENDLY,
        version: '0.23.0',
    },
};

/**
 * The rename for a class member written under its pre-rename spelling, if it is a known renamed
 * field of that class.
 *
 * @param className the FullName of a class of the resolved group (callers try each ancestor).
 * @param written the field name as written in the file.
 * @returns the rename (modern name + note + version), or undefined when the spelling is not a known
 * renamed alias of that class.
 */
export const renamedFieldAlias = (className: string, written: string): FieldRename | undefined => {
    const rename = RENAMED_FIELD_ALIASES[written.toLowerCase()];
    if (!rename || !rename.classNames.includes(className)) return undefined;
    // Only the old spelling is deprecated: the map is keyed by it, but guard against a future entry
    // accidentally keying the modern name.
    return rename.replacement.toLowerCase() === written.toLowerCase() ? undefined : rename;
};

/** A field that still works but was superseded by a richer field the game now prefers. */
export interface ObsoleteField {
    /** FullNames of the classes that carry the obsolete field. */
    readonly classNames: readonly string[];
    /** The field that supersedes it. */
    readonly replacement: string;
    /** A short human note on the migration, shown in the hint and on hover. */
    readonly note: string;
    /** The game version that introduced the successor. */
    readonly version: string;
}

/**
 * Obsolete-but-working fields by lower-cased field name. Both the old and the new field exist as
 * separate members in the current DLL (the game keeps reading the old one for backwards
 * compatibility), so unlike {@link RENAMED_FIELD_ALIASES} these are not aliases of one field.
 * Verified against the extracted schema: each class carries both members.
 */
const OBSOLETE_FIELDS: Readonly<Record<string, ObsoleteField>> = {
    // ---- 0.24.0 ----
    explosivedamageresistance: {
        classNames: [
            'Cosmoteer.Ships.Parts.PartRules',
            'Cosmoteer.Ships.Parts.Defenses.ArcShieldRules',
            'Cosmoteer.Bullets.Targeting.BulletTargetableRules',
        ],
        replacement: 'DamageResistances',
        note: "use the 'DamageResistances' map instead: DamageResistances = { explosive = … }",
        version: '0.24.0',
    },
    // ---- 0.26.0 ----
    componentid: {
        classNames: ['Cosmoteer.Ships.Parts.Logic.BuffMultiProxyRules'],
        replacement: 'ComponentIDs',
        note: "ViaBuffs now supports multiple components through a 'ComponentIDs' list",
        version: '0.26.0',
    },
};

/**
 * The successor for a class member superseded by a richer field, if it is a known obsolete field of
 * that class.
 *
 * @param className the FullName of a class of the resolved group (callers try each ancestor).
 * @param fieldName the field name as written in the file.
 * @returns the obsolete-field entry (successor + note + version), or undefined when the field is not
 * a known obsolete field of that class.
 */
export const obsoleteField = (className: string, fieldName: string): ObsoleteField | undefined => {
    const obsolete = OBSOLETE_FIELDS[fieldName.toLowerCase()];
    return obsolete && obsolete.classNames.includes(className) ? obsolete : undefined;
};

/**
 * Renamed fields of the mod manifest (`mod.rules`), by lower-cased old spelling. The manifest is not
 * schema-validated (its loader lives outside the serialization system), so these entries are consumed
 * by the workspace migration directly rather than by a validator.
 */
export const RENAMED_MOD_RULES_FIELDS: Readonly<Record<string, Deprecation>> = {
    // ---- 0.24.0 ----
    modifiesmultiplayer: {
        replacement: 'ModifiesGameplay',
        note: 'renamed for clarity; the old name is still accepted for backwards-compatibility',
        version: '0.24.0',
    },
};
