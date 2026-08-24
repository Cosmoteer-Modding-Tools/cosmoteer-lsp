/**
 * Fields a sibling switches off, the relations the schema itself cannot carry.
 *
 * The extracted schema says which class owns a field and what shape its value has. It cannot say
 * that the game reads `BuffMode` only inside the branch it entered because `BuffType` was there, or
 * that a sprite grid takes its dimensions from `RectType` only while `GridSize` is unwritten. Those
 * relations live in the reader methods, so a field that is dead weight in the group it sits in
 * looks exactly like one that works.
 *
 * Every entry is read out of the shipped assembly, from the branch that decides whether the field
 * is read at all. The wording of each `docs/fields` page comes from the same reading, which is why
 * the two agree.
 *
 * A relation is only worth an entry when the field it names is one a mod actually writes. A
 * relation nothing in the game or a mod ever writes can only fire on somebody inventing the
 * combination, which is not what the check is for.
 */

import { registry } from '../../utils/registry';

/** What makes the field inert, expressed against a sibling written in the same group. */
export type InertCondition =
    /** The sibling is written, and the game reads it instead of this field. */
    | { readonly kind: 'siblingPresent'; readonly sibling: string }
    /** The sibling is not written, and the branch that reads this field is never entered. */
    | { readonly kind: 'siblingAbsent'; readonly sibling: string }
    /** The sibling is written false, and the feature this field configures is switched off. */
    | { readonly kind: 'siblingFalse'; readonly sibling: string }
    /** The sibling is written true, and it takes over what this field would have decided. */
    | { readonly kind: 'siblingTrue'; readonly sibling: string }
    /** The sibling is written as a number that is not above zero. */
    | { readonly kind: 'siblingNotPositive'; readonly sibling: string };

/** One class's inert-field relations, keyed by the field name the game stops reading. */
type ClassRelations = Readonly<Record<string, InertCondition>>;

/** Shorthands, so a table row reads as the relation rather than as an object literal. */
const whenPresent = (sibling: string): InertCondition => ({ kind: 'siblingPresent', sibling });
const whenAbsent = (sibling: string): InertCondition => ({ kind: 'siblingAbsent', sibling });
const whenFalse = (sibling: string): InertCondition => ({ kind: 'siblingFalse', sibling });
const whenTrue = (sibling: string): InertCondition => ({ kind: 'siblingTrue', sibling });
const whenNotPositive = (sibling: string): InertCondition => ({ kind: 'siblingNotPositive', sibling });

/** The two converter classes read their quantities from the same four branches. */
const CONVERTER_RELATIONS: ClassRelations = {
    FromQuantity: whenAbsent('FromStorage'),
    MinFromQuantityForConversion: whenAbsent('FromStorage'),
    ToQuantity: whenAbsent('ToStorage'),
    MinToQuantityForConversion: whenAbsent('ToStorage'),
    CheckAnticipatedCapacity: whenAbsent('ToStorage'),
};

/** Every buff provider offers the single-filter shorthand beside the list, and prefers the list. */
const BUFF_PROVIDER_RELATIONS: ClassRelations = { Criteria: whenPresent('Criterias') };

/** A sprite grid takes its dimensions from the written size, and only otherwise from a part rect. */
const SPRITE_GRID_RELATIONS: ClassRelations = { RectType: whenPresent('GridSize') };

/** An objective counts either a number of targets or a fraction of the ones it found. */
const OBJECTIVE_COUNT_RELATIONS: ClassRelations = { TargetCountFraction: whenPresent('TargetCount') };

/** A drawn sprite reads pixel coordinates only while it has no UV rectangle. */
const SPRITE_SOURCE_RELATIONS: ClassRelations = { Source: whenPresent('UVRect') };

/**
 * Class FullName to the fields a sibling switches off in it. Looked up by the class a group
 * resolves to, so a field written in a group of another class is never judged by another class's
 * relation.
 */
export const INERT_FIELDS = registry<ClassRelations>({
    // The inline modifier shorthands: each block of settings is read inside the branch its own
    // discriminating field opened, so the settings alone reach nothing.
    'Cosmoteer.Ships.ModifiableValue': {
        BuffMode: whenAbsent('BuffType'),
        BuffMinValue: whenAbsent('BuffType'),
        BuffMaxValue: whenAbsent('BuffType'),
        StatusMode: whenAbsent('StatusType'),
        StatusMinValue: whenAbsent('StatusType'),
        StatusMaxValue: whenAbsent('StatusType'),
        EffectScaleMode: whenAbsent('EffectScaleExponent'),
    },
    'Cosmoteer.Ships.Parts.Resources.ResourceConverterRules': CONVERTER_RELATIONS,
    'Cosmoteer.Ships.Parts.Resources.TriggeredResourceConverterRules': CONVERTER_RELATIONS,
    // Both explicit-target settings are read next to the switch that allows explicit targets at all.
    'Cosmoteer.Ships.Parts.Weapons.WeaponRules': {
        AllowShipWideExplicitTargets: whenFalse('CanBeGivenExplicitTarget'),
        ShowTargetButtons: whenFalse('CanBeGivenExplicitTarget'),
    },
    // The interval between a continuous beam's hits, which a beam that does not last has none of.
    'Cosmoteer.Ships.Parts.Weapons.BeamEmitterRules': { HitInterval: whenNotPositive('Duration') },
    'Cosmoteer.Ships.Parts.Graphics.PartSpriteGridRules': SPRITE_GRID_RELATIONS,
    'Cosmoteer.Ships.Parts.Graphics.PartBlendSpriteGridRules': SPRITE_GRID_RELATIONS,
    'Cosmoteer.Ships.Doors.DoorRules': { EditorGroup: whenPresent('EditorGroups') },
    'Cosmoteer.Ships.Parts.Buffs.PartAreaBuffProviderRules': BUFF_PROVIDER_RELATIONS,
    'Cosmoteer.Ships.Parts.Buffs.PartCircleBuffProviderRules': BUFF_PROVIDER_RELATIONS,
    'Cosmoteer.Ships.Parts.Buffs.PartFloodBuffProviderRules': BUFF_PROVIDER_RELATIONS,
    'Cosmoteer.Ships.Parts.Buffs.PartGridBuffProviderRules': BUFF_PROVIDER_RELATIONS,
    // An expanding blast reads its growth settings only while it has a duration to grow over.
    'Cosmoteer.Simulation.HitEffects.BaseExplosiveEffectRules`2': {
        ExpandIncrement: whenNotPositive('ExpandDuration'),
        ExpandStartRadius: whenNotPositive('ExpandDuration'),
        ExpandLoss: whenNotPositive('ExpandDuration'),
    },
    // A random pick replaces the single sound rather than falling back to it.
    'Cosmoteer.Simulation.MediaEffects.AudioEffectRules': { Sound: whenPresent('RandomSounds') },
    'Cosmoteer.Generators.Simulation.ShipSpawner': { Ships: whenPresent('Ship') },
    'Cosmoteer.Generators.Simulation.DoodadSpawner': { DoodadTypes: whenPresent('DoodadType') },
    'Cosmoteer.Modes.Career.Missions.Objectives.DefeatShipsObjective/Spawner': OBJECTIVE_COUNT_RELATIONS,
    'Cosmoteer.Modes.Career.Missions.Objectives.ProtectShipsObjective/Spawner': OBJECTIVE_COUNT_RELATIONS,
    'Cosmoteer.Modes.Career.Missions.Objectives.DontSurrenderToObjective/Spawner': OBJECTIVE_COUNT_RELATIONS,
    'Cosmoteer.Modes.Career.Missions.Objectives.DiscoverPOIsObjective/Spawner': {
        DiscoverCountFraction: whenPresent('DiscoverCount'),
    },
    // A stat widget's own name and number formatting are skipped once a custom text key supplies
    // the whole line.
    'Cosmoteer.Game.Gui.Build.Stats.StatBarRules': {
        NameKey: whenPresent('CustomTooltipTextKey'),
        NumberFormat: whenPresent('CustomValueTextKey'),
    },
    'Cosmoteer.Game.Gui.Build.Stats.IconTextStatWidgetRules': {
        NameKey: whenPresent('CustomTooltipTextKey'),
        NumberFormat: whenPresent('CustomValueTextKey'),
    },
    'Cosmoteer.Ships.AI.StrategyModules.AIAggroEnemiesModuleRules': {
        GotoLastKnownTargetLocation: whenTrue('RotateOnly'),
    },
    'Cosmoteer.Bullets.Hits.BulletPenetratingHitRules': { ShieldPenetrationFactor: whenFalse('PenetratesShields') },
    'Cosmoteer.Data.BuiltinShipRules': { FlightDirection: whenAbsent('StasisIcon') },
    'Cosmoteer.Resources.ResourceRarityRules': { FogDotSprite: whenFalse('UseFogDot') },
    'Cosmoteer.Game.PartTargeterGuiRules': { DefaultCancelHotkey: whenFalse('HasCancelButton') },
    'Halfling.Graphics.Sprite': SPRITE_SOURCE_RELATIONS,
    'Halfling.Graphics.CircleRenderer': SPRITE_SOURCE_RELATIONS,
    'Halfling.Gui.Components.Graphics.GuiSprite': SPRITE_SOURCE_RELATIONS,
});

/**
 * The relation that switches a field off in the class a group resolved to, if the registry knows
 * one. Matching is case-insensitive, the way the game binds a member name.
 *
 * @param cls the class the group resolved to.
 * @param field the field name as written.
 * @returns the condition under which the game stops reading the field, or undefined.
 */
export const inertCondition = (cls: string, field: string): InertCondition | undefined => {
    const relations = INERT_FIELDS[cls];
    if (!relations) return undefined;
    const folded = field.toLowerCase();
    for (const name in relations) if (name.toLowerCase() === folded) return relations[name];
    return undefined;
};
