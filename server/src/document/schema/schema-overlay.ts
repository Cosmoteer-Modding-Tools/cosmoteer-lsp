/**
 * Hand-authored schema corrections for types the `schemagen` extractor cannot reflect.
 *
 * `schemagen` walks `[ReflectiveSerialization]` `[Serialize]` fields. A handful of engine types are
 * instead read by a CUSTOM `IBaseDeserializer` (the same situation as the custom-deserialized
 * `Components` containers — see this folder's README), so their fields never appear as reflective
 * members and the extractor falls back to a lossy approximation. The prime example is
 * `Halfling.Graphics.Texture`: a dual-form value that is written either as a bare image path
 * (`Texture = foo.png`) OR as a group (`Texture { File=… MipLevels=… SampleMode=… }`). schemagen
 * only saw the scalar form and emitted `{ kind: 'asset', assetKind: 'image' }`, so the LSP could not
 * resolve a class for the group form and offered no field-name completion inside `Texture { … }`.
 *
 * This overlay supplies the missing group type (transcribed from the engine's `Texture` ObjectText
 * deserializer) and the two enums it needs that the prune dropped. It is merged into the bundle at
 * load (see {@link applySchemaOverlay}). It only adds, never overwriting an extracted definition,
 * so a future schemagen run that learns these types wins automatically.
 *
 * The group form is resolved structurally: an image-asset slot occupied by a group node is a
 * `Texture` (the only dual-form image type in the engine) — see `resolveGroupClass` in
 * `schema-context.ts`. So no per-field rewrite of the (many) `Texture`-typed fields is needed.
 */
import { SchemaBundle, SchemaEnum, SchemaField, SchemaTypeDef } from './schema.types';

/** The class an image-asset slot resolves to when it is written as a group rather than a bare path. */
export const TEXTURE_GROUP_CLASS = 'Halfling.Graphics.Texture';

/** A cross-file reference to a buff (`ID<BuffType>`), the value form of part buff `BuffType` fields. */
const BUFF_REF = { kind: 'reference', target: 'Cosmoteer.Ships.Buffs.BuffType', targetName: 'BuffType' } as const;

/** A reference to a sibling part component (`ID<PartComponentRules>`). */
const COMPONENT_REF = {
    kind: 'reference',
    target: 'Cosmoteer.Ships.Parts.PartComponentRules',
    targetName: 'PartComponentRules',
} as const;

/** A `ModifiableFloat` value: a plain number, or the dual-form modifiable group. */
const MODIFIABLE_FLOAT = {
    kind: 'number',
    type: 'ModifiableFloat',
    groupForm: 'Cosmoteer.Ships.ModifiableValue',
} as const;

/** A `ModifiableTime` value: a plain number, or the dual-form modifiable group. */
const MODIFIABLE_TIME = {
    kind: 'number',
    type: 'ModifiableTime',
    groupForm: 'Cosmoteer.Ships.ModifiableValue',
} as const;

/** A reference to a ship render layer (`ID<ShipRenderLayerRules>`). */
const RENDER_LAYER_REF = {
    kind: 'reference',
    target: 'Cosmoteer.Ships.ShipRenderLayerRules',
    targetName: 'ShipRenderLayerRules',
} as const;

/** Group types schemagen could not reflect (custom-deserialized), keyed by C# FullName. */
const OVERLAY_TYPES: Record<string, SchemaTypeDef> = {
    [TEXTURE_GROUP_CLASS]: {
        name: 'Texture',
        namespace: 'Halfling.Graphics',
        // Transcribed from Halfling.Graphics.Texture's ObjectText deserializer (the `Read` path):
        // every field is read via `TryReadFromPath`, so all are optional.
        fields: [
            { name: 'File', valueType: { kind: 'asset', assetKind: 'image' }, optional: true },
            // Either an integer count or the literal `max`, hence a permissive scalar (not `int`).
            { name: 'MipLevels', valueType: { kind: 'string', semantic: 'mipLevels' }, optional: true },
            {
                name: 'ColorKey',
                valueType: { kind: 'group', ref: 'Halfling.Graphics.IntColor', name: 'IntColor' },
                optional: true,
            },
            { name: 'FixTransparentColors', valueType: { kind: 'bool' }, optional: true },
            { name: 'MultiplyByAlpha', valueType: { kind: 'bool' }, optional: true },
            { name: 'PreMultiplyByAlpha', valueType: { kind: 'bool' }, optional: true },
            {
                name: 'Compression',
                valueType: { kind: 'enum', ref: 'Halfling.Graphics.CompressionFormat', name: 'CompressionFormat' },
                optional: true,
            },
            {
                name: 'SampleMode',
                valueType: { kind: 'enum', ref: 'Halfling.Graphics.TextureSampleMode', name: 'TextureSampleMode' },
                optional: true,
            },
            {
                name: 'UVMode',
                valueType: { kind: 'enum', ref: 'Halfling.Graphics.TextureUVMode', name: 'TextureUVMode' },
                optional: true,
            },
            {
                name: 'UMode',
                valueType: { kind: 'enum', ref: 'Halfling.Graphics.TextureUVMode', name: 'TextureUVMode' },
                optional: true,
            },
            {
                name: 'VMode',
                valueType: { kind: 'enum', ref: 'Halfling.Graphics.TextureUVMode', name: 'TextureUVMode' },
                optional: true,
            },
            {
                name: 'PerformanceMode',
                valueType: { kind: 'enum', ref: 'Halfling.Graphics.PerformanceMode', name: 'PerformanceMode' },
                optional: true,
            },
            {
                name: 'Resize',
                valueType: { kind: 'group', ref: 'Halfling.Geometry.IntVector2', name: 'IntVector2' },
                optional: true,
            },
        ],
    },
};

// Extra fields a reflectively-extracted type accepts that schemagen still can't see. schemagen now
// recovers most custom-deserializer reads directly from method IL (the generic `*FromPath<T>("Name")`
// calls — see `CustomReadCalls` in tools/schemagen), so this list is only what that cannot reach: the
// alternate spellings of a custom content deserializer, fields read via a non-generic overload, or a
// value read off a nested/foreign object. Merged additively (a name already extracted is left as-is),
// so each entry self-retires if schemagen later learns it. Keyed by C# FullName.
const OVERLAY_FIELD_ADDITIONS: Record<string, SchemaField[]> = {
    // `IntColor` reflects its byte `R`/`G`/`B`/`A`, but its content deserializer also reads float
    // `Rf`/`Gf`/`Bf`/`Af` (0..1) and `H`/`S`/`V` — the spelling vanilla overwhelmingly uses.
    'Halfling.Graphics.IntColor': [
        { name: 'Rf', valueType: { kind: 'number' }, optional: true },
        { name: 'Gf', valueType: { kind: 'number' }, optional: true },
        { name: 'Bf', valueType: { kind: 'number' }, optional: true },
        { name: 'Af', valueType: { kind: 'number' }, optional: true },
        { name: 'H', valueType: { kind: 'number' }, optional: true },
        { name: 'S', valueType: { kind: 'number' }, optional: true },
        { name: 'V', valueType: { kind: 'number' }, optional: true },
    ],
    // A `ToggledComponents` part holds a `Components` map (named sub-components, each polymorphic) read
    // by a custom deserializer. Its children resolve structurally like any `Components` container.
    'Cosmoteer.Ships.Parts.Logic.PartToggledComponentsRules': [
        {
            name: 'Components',
            valueType: {
                kind: 'map',
                key: { kind: 'string' },
                value: {
                    kind: 'polymorphicGroup',
                    ref: 'Cosmoteer.Ships.Parts.PartComponentRules',
                    name: 'PartComponentRules',
                },
            },
            optional: true,
        },
    ],
    // The buff provider parts read `BuffType` off the game buff registry in a custom constructor (a
    // non-generic read schemagen's IL scan does not catch).
    'Cosmoteer.Ships.Parts.Buffs.PartSelfBuffProviderRules': [{ name: 'BuffType', valueType: BUFF_REF, optional: true }],
    'Cosmoteer.Ships.Parts.Buffs.PartAreaBuffProviderRules': [{ name: 'BuffType', valueType: BUFF_REF, optional: true }],
    'Cosmoteer.Ships.Parts.Buffs.PartGridBuffProviderRules': [{ name: 'BuffType', valueType: BUFF_REF, optional: true }],
    // `PartRules` reads the `Flammable` bool and the thruster part reads these force/fuel values off the
    // part rules, none as a generic `*FromPath<T>` call.
    'Cosmoteer.Ships.Parts.PartRules': [
        { name: 'Flammable', valueType: { kind: 'bool' }, optional: true },
        { name: 'ThrusterForce', valueType: MODIFIABLE_FLOAT, optional: true },
        { name: 'FuelUsage', valueType: MODIFIABLE_FLOAT, optional: true },
        { name: 'ThrustRecoveryTime', valueType: MODIFIABLE_TIME, optional: true },
    ],
    // `ProxyRules` is embedded inline by every proxy part (below). Its `ComponentID` lives on a nested
    // helper class in C#, so neither reflection nor the IL scan sees it, but the OT writes it directly.
    'Cosmoteer.Ships.Parts.Logic.ProxyRules': [{ name: 'ComponentID', valueType: COMPONENT_REF, optional: true }],
    // A bullet emitter reads the resources it consumes and the storage they come from.
    'Cosmoteer.Ships.Parts.Weapons.BulletEmitterRules': [
        { name: 'ResourcesUsed', valueType: MODIFIABLE_FLOAT, optional: true },
        { name: 'ResourceStorage', valueType: COMPONENT_REF, optional: true },
    ],
    // A triggered-effects part scales its media effects by another component's value.
    'Cosmoteer.Ships.Parts.Effects.PartTriggeredEffectsRules': [
        { name: 'FactorMediaEffectsIntensityWith', valueType: COMPONENT_REF, optional: true },
    ],
    'Cosmoteer.Generators.Ships.Stages.AsteroidWedgesStage': [
        { name: 'RandomizeReplaceOrder', valueType: { kind: 'bool' }, optional: true },
    ],
    'Cosmoteer.Generators.Simulation.DoodadSpawner': [
        { name: 'HideIfUnexplored', valueType: { kind: 'bool' }, optional: true },
        { name: 'Undiscovered', valueType: { kind: 'string' }, optional: true },
        { name: 'ShowOnlyInFog', valueType: { kind: 'string' }, optional: true },
    ],
    // Resource sprites flag whether they have a zero-resource sprite.
    'Cosmoteer.Ships.Parts.Graphics.PartResourceSpritesRules': [
        { name: 'HasZeroResourceSprite', valueType: { kind: 'bool' }, optional: true },
    ],
    // Indicator sprites render on a named ship render layer.
    'Cosmoteer.Ships.Parts.Graphics.PartIndicatorSpritesRules': [
        { name: 'Layer', valueType: RENDER_LAYER_REF, optional: true },
    ],
    // A turret weapon names the emitter component it fires through.
    'Cosmoteer.Ships.Parts.Weapons.TurretWeaponRules': [{ name: 'Emitter', valueType: COMPONENT_REF, optional: true }],
    // The particle emitter and quad renderer carry these custom-read members.
    'Halfling.Particles.ParticleEmitterDef': [
        { name: 'UpdatedEmittedParticles', valueType: { kind: 'bool' }, optional: true },
    ],
    'Halfling.Particles.Renderers.StandardParticleQuadRenderer': [
        { name: 'MaxScale', valueType: { kind: 'number' }, optional: true },
    ],
};

/**
 * Inline-member expansions: a class with a `[Serialize(Alias="")]` member of a group type writes that
 * group's fields directly inline rather than as a named sub-group. The fields of the named type are
 * copied into the class at load. Keyed by class FullName → the type whose fields to inline.
 */
const OVERLAY_INLINE_TYPES: Record<string, string> = {
    // `BlueprintPartSpriteRules` embeds an `AtlasSprite` with an empty alias, so its `File`/`Size`/
    // `Offset`/… are written directly in the blueprint sprite group (~4000 vanilla+mod uses).
    'Cosmoteer.Ships.Blueprints.Graphics.BlueprintPartSpriteRules': 'Cosmoteer.Ships.Rendering.AtlasSprite',
    // Every proxy part embeds `ProxyRules` with an empty alias, so its `ComponentID`/`PartLocation`/
    // `ProxyToggle`/… are written directly in the proxy group.
    'Cosmoteer.Ships.Parts.Logic.PartTriggerProxyRules': 'Cosmoteer.Ships.Parts.Logic.ProxyRules',
    'Cosmoteer.Ships.Parts.Logic.PartToggleProxyRules': 'Cosmoteer.Ships.Parts.Logic.ProxyRules',
    'Cosmoteer.Ships.Parts.Logic.PartValueProxyRules': 'Cosmoteer.Ships.Parts.Logic.ProxyRules',
    'Cosmoteer.Ships.Parts.Logic.ComponentPresenceToggleRules': 'Cosmoteer.Ships.Parts.Logic.ProxyRules',
    'Cosmoteer.Ships.Parts.Resources.ResourceStorageProxyRules': 'Cosmoteer.Ships.Parts.Logic.ProxyRules',
    'Cosmoteer.Ships.Parts.Logic.PartChainableProxyRules': 'Cosmoteer.Ships.Parts.Logic.ProxyRules',
};

/** Enums the overlay types reference that the extractor's prune dropped, keyed by C# FullName. */
const OVERLAY_ENUMS: Record<string, SchemaEnum> = {
    'Halfling.Graphics.TextureUVMode': { name: 'TextureUVMode', members: ['Clamp', 'Wrap'] },
    'Halfling.Graphics.PerformanceMode': {
        name: 'PerformanceMode',
        members: ['Immutable', 'Static', 'Dynamic', 'DynamicStreaming'],
    },
};

/**
 * Merge the hand-authored corrections into a freshly-loaded bundle. Additive only: an entry already
 * present in the extracted bundle is left untouched, so the overlay self-retires as schemagen
 * improves. Mutates and returns `bundle`.
 */
export const applySchemaOverlay = (bundle: SchemaBundle): SchemaBundle => {
    for (const [fullName, type] of Object.entries(OVERLAY_TYPES)) {
        if (!bundle.types[fullName]) bundle.types[fullName] = type;
    }
    for (const [fullName, def] of Object.entries(OVERLAY_ENUMS)) {
        if (!bundle.enums[fullName]) bundle.enums[fullName] = def;
    }
    for (const [fullName, extra] of Object.entries(OVERLAY_FIELD_ADDITIONS)) {
        const type = bundle.types[fullName];
        if (!type) continue;
        const present = new Set(type.fields.map((f) => f.name));
        for (const field of extra) if (!present.has(field.name)) type.fields.push(field);
    }
    // Inline an embedded empty-alias member's fields into its containing class, copying them from the
    // already-loaded named type so the two stay in sync.
    for (const [fullName, inlineFrom] of Object.entries(OVERLAY_INLINE_TYPES)) {
        const type = bundle.types[fullName];
        const source = bundle.types[inlineFrom];
        if (!type || !source) continue;
        const present = new Set(type.fields.map((f) => f.name));
        for (const field of source.fields) {
            if (!present.has(field.name)) type.fields.push({ ...field, optional: true });
        }
    }
    return bundle;
};
