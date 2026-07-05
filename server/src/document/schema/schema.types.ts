/**
 * TypeScript shape of `cosmoteer.schema.json` — the machine-readable Cosmoteer `.rules`
 * schema extracted from `Cosmoteer.dll` (see this folder's README and the `schemagen` tool).
 *
 * The bundle is the type graph of every `[ReflectiveSerialization]` class reachable from the
 * document root (`Cosmoteer.Data.Rules`), plus the polymorphic `Type=` registries and enums.
 * Types/enums/registries are keyed by their C# FullName.
 */

/** The value-kind of a field — drives value completion and validation. */
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
    | { kind: 'map'; key: ValueType; value: ValueType }
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
    default?: string | number | boolean;
    aliases?: string[];
    /**
     * Human-readable prose description of the field, shown in hover and completion. Not extracted by
     * schemagen; merged in at load from the community-maintained docs (see `field-docs.ts` and
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
    unresolved: { types: Record<string, number>; generics: Record<string, number> };
}
