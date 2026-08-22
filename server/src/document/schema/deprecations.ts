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
 * Every entry also has an identity, its {@link migrationSymbolOf} symbol, which the diagnostics carry
 * and {@link deprecationBySymbol} reads back. That is what lets a fix say "apply this one rename to
 * the whole mod" and collect only the findings of that entry, instead of matching the old name as
 * text, which would hit the many places the same word is a live field or a component id.
 *
 * The entries come from the official changelogs (cosmoteer.wiki.gg transcriptions of the Steam
 * posts), cross-checked against the extracted schema: a deleted field's name is absent, a renamed
 * alias carries both spellings on one schema field, an obsolete field exists alongside its
 * successor.
 */

/** A renamed symbol: the spelling to use now, and a short note on why it changed. */
export interface Deprecation {
    /** The current name that replaces the deprecated one. */
    readonly replacement: string;
    /**
     * The old name's canonical spelling, for a map keyed by a lower-cased name. Only needed where
     * the key is not the spelling a modder writes, so a message can name the field the way the file
     * does. Omitted where the key already is that spelling.
     */
    readonly name?: string;
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
 * `Resource*` (ammo is just a resource now). The rename predates the recorded changelogs, so the
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
    /** The deleted field's canonical spelling, since the map is keyed by its lower-cased name. */
    readonly name: string;
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
 * game's code. Where vanilla still writes a deleted field (stale leftovers the game ignores), the schema keeps the
 * member flagged `dead` in the overlay, which keeps old mods parsing and hovering, and the entry here
 * upgrades the dead-field hint with the migration.
 */
const DEPRECATED_FIELDS: Readonly<Record<string, FieldDeprecation>> = {
    // ---- 0.24.1 ----
    penetrationrecttype: {
        className: 'Cosmoteer.Bullets.Hits.BulletPenetratingHitRules',
        name: 'PenetrationRectType',
        note: 'the parameter is unused and can be safely removed',
        version: '0.24.1',
        removeOnMigrate: true,
    },
    // ---- 0.26.1 ----
    suppresswholeshiptargetoverlaysforpartsfilter: {
        className: 'Cosmoteer.Ships.Parts.Weapons.WeaponRules',
        name: 'SuppressWholeShipTargetOverlaysForPartsFilter',
        note: "its functionality is covered by 'SuppressDirectControlWhenTargetingPartsFilter'",
        version: '0.26.1',
        replacement: 'SuppressDirectControlWhenTargetingPartsFilter',
    },
    suppresswholeshiptargetoverlayswhentargetingshiprelativepoints: {
        className: 'Cosmoteer.Ships.Parts.Weapons.WeaponRules',
        name: 'SuppressWholeShipTargetOverlaysWhenTargetingShipRelativePoints',
        note: "its functionality is covered by 'SuppressShipWideExplicitTargetsWhenTargetingShipRelativePoints'",
        version: '0.26.1',
        replacement: 'SuppressShipWideExplicitTargetsWhenTargetingShipRelativePoints',
    },
    valueoutputsmoothing: {
        className: 'Cosmoteer.Ships.Parts.Thrusters.ThrusterRules',
        name: 'ValueOutputSmoothing',
        note: "use the 'IntensityTweenDuration' of a ContinuousEffects component instead",
        version: '0.26.1',
    },
    // ---- 0.30.0 (Meltdown) ----
    flammable: {
        className: 'Cosmoteer.Ships.Parts.PartRules',
        name: 'Flammable',
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
    /** The old name's canonical spelling, since the map is keyed by its lower-cased form. */
    readonly name: string;
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
 * check ever flags it. This registry is the only source that says "prefer the modern name".
 */
const RENAMED_FIELD_ALIASES: Readonly<Record<string, FieldRename>> = {
    // ---- 0.23.0 ----
    createpartwhendestroyed: {
        classNames: ['Cosmoteer.Ships.Parts.PartRules'],
        name: 'CreatePartWhenDestroyed',
        replacement: 'UnderlyingPart',
        note: 'renamed; the old name is still accepted for backwards-compatibility',
        version: '0.23.0',
    },
    createpartpertilewhendestroyed: {
        classNames: ['Cosmoteer.Ships.Parts.PartRules'],
        name: 'CreatePartPerTileWhenDestroyed',
        replacement: 'UnderlyingPartPerTile',
        note: 'renamed; the old name is still accepted for backwards-compatibility',
        version: '0.23.0',
    },
    sourceshiplowcollisions: {
        name: 'SourceShipLowCollisions',
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
        name: 'SourceShipHighCollisions',
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
        name: 'IgnoreSourceShipLowLOSChecks',
        replacement: 'IgnoreFriendlyShipLowLOSChecks',
        note: SOURCE_TO_FRIENDLY,
        version: '0.23.0',
    },
    ignoresourceshiphighloschecks: {
        classNames: ['Cosmoteer.Ships.Parts.Weapons.WeaponRules'],
        name: 'IgnoreSourceShipHighLOSChecks',
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
    /** The obsolete field's canonical spelling, since the map is keyed by its lower-cased name. */
    readonly name: string;
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
 */
const OBSOLETE_FIELDS: Readonly<Record<string, ObsoleteField>> = {
    // ---- 0.24.0 ----
    explosivedamageresistance: {
        name: 'ExplosiveDamageResistance',
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
        name: 'ComponentID',
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
        name: 'ModifiesMultiplayer',
        replacement: 'ModifiesGameplay',
        note: 'renamed for clarity; the old name is still accepted for backwards-compatibility',
        version: '0.24.0',
    },
};

/**
 * Which of the registries above a migration symbol names. The registries are keyed by the old name,
 * and one old name can mean different things in different registries, so the kind is part of the
 * identity rather than a detail of it.
 */
export type MigrationSymbolKind = 'discriminator' | 'deletedField' | 'renamedAlias' | 'obsoleteField' | 'manifestField';

/** What a migration symbol names: the registry entry behind it, in the form a message can read. */
export interface DeprecationSymbol {
    /** The registry the entry came from. */
    readonly kind: MigrationSymbolKind;
    /** The old name's canonical spelling, for messages that name the field the way a file writes it. */
    readonly name: string;
    /** The current name that replaces it, absent for a deletion nothing took over. */
    readonly replacement?: string;
    /** The game version that made the change, when the changelog records it. */
    readonly version?: string;
}

/**
 * The identity of one deprecation-registry entry, which a diagnostic carries so a bulk fix can
 * collect exactly that deprecation across a mod and nothing else. Case is folded, because the game
 * resolves member names ignoring case and the same field is written `Flammable` in one file and
 * `flammable` in the next.
 *
 * @param kind which registry the entry lives in.
 * @param written the old name as written in the file, or as the registry keys it.
 * @returns the symbol.
 */
export const migrationSymbolOf = (kind: MigrationSymbolKind, written: string): string =>
    `${kind}:${written.toLowerCase()}`;

/**
 * The registry entry a migration symbol names. The lookup has to live here because the registries
 * are module-private, and a bulk fix needs the entry to say what it is about to change.
 *
 * @param symbol a symbol built by {@link migrationSymbolOf}.
 * @returns the entry, or undefined when no registry holds it (a symbol from an older release, say).
 */
export const deprecationBySymbol = (symbol: string): DeprecationSymbol | undefined => {
    const separator = symbol.indexOf(':');
    if (separator < 0) return undefined;
    const kind = symbol.slice(0, separator) as MigrationSymbolKind;
    const key = symbol.slice(separator + 1);
    switch (kind) {
        case 'discriminator': {
            // The only registry keyed by the canonical spelling, so its key is compared case-folded.
            const entry = Object.entries(DEPRECATED_DISCRIMINATORS).find(([name]) => name.toLowerCase() === key);
            if (!entry) return undefined;
            return { kind, name: entry[0], replacement: entry[1].replacement, version: entry[1].version };
        }
        case 'deletedField': {
            const entry = DEPRECATED_FIELDS[key];
            if (!entry) return undefined;
            return { kind, name: entry.name, replacement: entry.replacement, version: entry.version };
        }
        case 'renamedAlias': {
            const entry = RENAMED_FIELD_ALIASES[key];
            if (!entry) return undefined;
            return { kind, name: entry.name, replacement: entry.replacement, version: entry.version };
        }
        case 'obsoleteField': {
            const entry = OBSOLETE_FIELDS[key];
            if (!entry) return undefined;
            return { kind, name: entry.name, replacement: entry.replacement, version: entry.version };
        }
        case 'manifestField': {
            const entry = RENAMED_MOD_RULES_FIELDS[key];
            if (!entry) return undefined;
            return { kind, name: entry.name ?? key, replacement: entry.replacement, version: entry.version };
        }
        default:
            return undefined;
    }
};

/**
 * Every migration symbol the registries hold. A test walks it to prove each one resolves and that
 * the per-symbol migration runs add up to the unfiltered one, which is what keeps the next
 * deprecation entry from shipping without an identity.
 *
 * @returns the symbols, registry by registry.
 */
export const allDeprecationSymbols = (): string[] => [
    ...Object.keys(DEPRECATED_DISCRIMINATORS).map((name) => migrationSymbolOf('discriminator', name)),
    ...Object.keys(DEPRECATED_FIELDS).map((key) => migrationSymbolOf('deletedField', key)),
    ...Object.keys(RENAMED_FIELD_ALIASES).map((key) => migrationSymbolOf('renamedAlias', key)),
    ...Object.keys(OBSOLETE_FIELDS).map((key) => migrationSymbolOf('obsoleteField', key)),
    ...Object.keys(RENAMED_MOD_RULES_FIELDS).map((key) => migrationSymbolOf('manifestField', key)),
];
