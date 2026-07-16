/**
 * TypeScript shape of `cosmoteer.schema.json`, the machine-readable Cosmoteer `.rules`
 * schema extracted from `Cosmoteer.dll` (see this folder's README and the `schemagen` tool).
 *
 * The bundle is the type graph of every `[ReflectiveSerialization]` class reachable from the
 * document root (`Cosmoteer.Data.Rules`), plus the polymorphic `Type=` registries and enums.
 * Types/enums/registries are keyed by their C# FullName.
 */

/** The value-kind of a field. Drives value completion and validation. */
export type ValueType =
    | {
          kind: 'bool' | 'int' | 'float' | 'string' | 'number';
          type?: string;
          unit?: string;
          semantic?: string;
          /**
           * For a value that is primarily a scalar but also accepts a structured group form (a
           * `Modifiable<T>` written as `{ BaseValue = … BuffType = … }`), the FullName of the group
           * type whose fields apply inside the `{ }`. Lets completion/hover/validation handle both forms.
           */
          groupForm?: string;
      }
    | { kind: 'enum'; ref: string; name: string; enumLike?: boolean }
    | { kind: 'reference'; target: string; targetName: string }
    | { kind: 'group' | 'polymorphicGroup'; ref: string; name: string }
    | { kind: 'list' | 'range' | 'interpolated'; element: ValueType }
    | {
          kind: 'map';
          key: ValueType;
          value: ValueType;
          /** Entry-form member names when the map is written as a list of `{ Key = … Value = … }`
           *  groups. Custom spellings come from `[KeyValuePairNames]` (`Old`/`New` for roof decal
           *  upgrades). Absent means the engine defaults, `Key` and `Value`. */
          entryKey?: string;
          entryValue?: string;
      }
    | { kind: 'tuple'; elements: ValueType[] }
    | { kind: 'constructed'; type: string; params: Array<{ name: string; valueType: ValueType }> }
    | { kind: 'asset'; assetKind: string }
    | { kind: 'code'; lang: string }
    | { kind: 'opaque'; type: string; reason?: string }
    | { kind: 'generic'; type: string; args: ValueType[] };

export interface SchemaField {
    name: string;
    valueType: ValueType;
    optional: boolean;
    /**
     * True when the ObjectText deserializer throws on this field being absent, i.e. its `[Serialize]`
     * does not set `Optional = true` (`BaseSerializer` does `Optional = attr?.Optional ?? true`, then
     * `if (!Optional) throw` before applying any default). Absent means absence is legal.
     *
     * This is not the negation of {@link optional}: that flag is deliberately broader (it also counts
     * ctor-initialized, nullable and collection members) because it feeds the required-field check,
     * where the strict reading false-positived. Anything asking "is removing this field safe?" must
     * read this one. A field can be `optional` by that heuristic and still be one the game load
     * requires.
     */
    absentThrows?: boolean;
    /**
     * False when the C# member is a non-nullable value type, so a bare valueless field (`ScaleIn`
     * with no `=`) is a game load error: the deserializer reads a void node as null and throws.
     * Absent means null-tolerant (reference type, `Nullable<T>`, or curated without the flag).
     */
    nullable?: boolean;
    default?: string | number | boolean;
    /**
     * Where {@link default} came from, which decides how far it can be trusted. Absent when the field
     * has no default.
     *  - `attribute`: the game's own `[Serialize(DefaultValue = …)]`. This is the value an absent field
     *    yields: BaseSerializer's reflective read does `SetValue(target, DefaultValue)` for a missing
     *    optional member, whatever the class's construction looks like.
     *  - `initializer`: schemagen read it from the constant stores of the smallest-arity constructor
     *    (in practice a C# field initializer). It only equals the absent-value when the game constructs
     *    the class that way and fills it reflectively, so trust it only on a `purelyReflective` type.
     */
    defaultSource?: 'attribute' | 'initializer';
    /**
     * True when the game declares the member but no game code ever reads its value, so writing it
     * is dead weight in a mod. Detected by schemagen's whole-assembly read scan (no field load,
     * getter call, or name mention anywhere in the scanned assemblies), so it tracks game updates
     * through schema regeneration. Absent means the member is read normally.
     */
    dead?: boolean;
    aliases?: string[];
    /**
     * True when this field carries a `[Serialize(OverrideDeserializer = …)]` whose wrapper reads
     * a bare word looked up by name (a Widget `AnchorRect = TopLeft` preset). Strings only, a
     * number still throws in game.
     */
    scalarStringForm?: boolean;
    /**
     * Human-readable prose description of the field, shown in hover and completion. Not extracted by
     * schemagen, merged in at load from the community-maintained docs (see `field-docs.ts` and
     * `docs/fields/`). Absent when the field has not been documented yet.
     */
    description?: string;
}

export interface SchemaTypeDef {
    name: string;
    namespace?: string;
    /** Base class FullName whose fields are inherited (walk to collect the full field set). */
    extends?: string;
    abstract?: boolean;
    /** Present on a polymorphic member: its `Type=` discriminator value. */
    derivedType?: string;
    /** FullName of the registry base this type is a member of. */
    registry?: string;
    isRegistry?: boolean;
    /**
     * True when the type's OT deserializer also reads a plain scalar value (`Time = 10`,
     * `Default = White`). Detected by schemagen from the engine's own deserialization hooks
     * (an `[ObjectTextConstructor]` or `ReadContentFrom` body branching on `OTFieldNode`), so it
     * tracks game updates through schema regeneration.
     */
    scalarForm?: boolean;
    /**
     * The member a scalar value lands in when written for a `scalarForm` type (`FireTrigger =
     * Turret` stores into `ID`, an `EditorParentParts` entry into `Parent`). Extracted by schemagen
     * from the store instruction in the deserializer's scalar branch. Absent when the scalar is
     * parsed rather than stored into one member (`Color = White`).
     */
    scalarField?: string;
    /**
     * True when a globally registered wrapper serializer reads the type from a bare word looked
     * up by name (`ValueCombiner = Add`). Strings only, a number still throws in game.
     */
    scalarStringForm?: boolean;
    /**
     * The value type of the member a `[Serialize(Alias = "")]` declaration binds to the node
     * itself, making the type read every shape that member type reads (ShipFile's path string,
     * MultiHitEffectRules' effect list, a proxy's group-only ProxyRules). Extracted by schemagen.
     */
    valueForm?: ValueType;
    /**
     * Classes whose fields are written inline in this type's own group: a `[Serialize(Alias = "")]`
     * group-typed member (a network component's embedded `PartNetworkFilter`, a widget sprite's
     * `AtlasSprite`). The named classes' fields are merged into `fields` at load (schema-overlay.ts).
     */
    inlineFrom?: string[];
    /**
     * True when this type and its whole `extends` chain deserialize purely by reflection over their
     * `[Serialize]` members, so the emitted `fields` list is the complete set of keys the engine reads.
     * Detected by schemagen (no custom `[ObjectTextConstructor]`/`ReadContentFrom` hook, no `valueForm`,
     * no custom wrapper serializer, no generic `*FromPath` read, anywhere in the chain). Only under this
     * guarantee is a written key that the class does not declare provably ignored by the game, which is
     * what the ignored-field validator gates on. Absent means the member list may be incomplete.
     */
    purelyReflective?: boolean;
    fields: SchemaField[];
}

export interface SchemaRegistry {
    name: string;
    /** The field that selects the concrete type (default `Type`). */
    typeField: string;
    valueField: string;
    /** discriminator value -> member class FullName. */
    members: Record<string, string>;
}

export interface SchemaEnum {
    name: string;
    members: string[];
    enumLike?: boolean;
}

export interface SchemaBundle {
    meta: Record<string, string | number>;
    registries: Record<string, SchemaRegistry>;
    types: Record<string, SchemaTypeDef>;
    enums: Record<string, SchemaEnum>;
    /** Class FullName → ids the engine hardcodes in C# (schemagen sweeps every literal
     *  `new ID<T>("…")` construction), so no `.rules` file declares them. */
    builtinIds?: Record<string, string[]>;
    unresolved: { types: Record<string, number>; generics: Record<string, number> };
}
