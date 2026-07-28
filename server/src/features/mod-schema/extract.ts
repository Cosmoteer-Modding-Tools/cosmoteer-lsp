/**
 * Extracts the `.rules` schema surface a Cosmoteer code mod adds, from the mod's own assemblies.
 *
 * A code mod ships a `.dll` declaring new serializable types: part components, bullet components,
 * hit effects, each with its own `Type=` discriminator. The game loads them exactly like its own,
 * so a mod's `.rules` files legitimately write `Type = DroneLaunchController` and a field set no
 * shipped schema knows. Without this the language server reports every one of them as an unknown
 * discriminator, which is a false positive on content the game accepts.
 *
 * This is a port of the `--mod` path of `tools/schemagen` (the C# extractor built on Mono.Cecil)
 * onto the metadata reader in this folder, so no .NET runtime is needed on the user's machine. It
 * follows the same rules: `[ReflectiveSerialization]` and `[Serialize]` decide participation,
 * `[SerialBaseType]`/`[SerialDerivedType]` build the `Type=` vocabulary, and a member's C# type maps
 * to a schema value type through the same table. `server/test/features/mod-schema/extract.oracle.test.ts`
 * pins the two against each other on a real code mod.
 *
 * The one deliberate difference is how game types are resolved. schemagen has `Cosmoteer.dll` open
 * and resolves every reference into it; here the shipped schema plays that role, because it already
 * describes every game type under the same FullName. A reference the shipped schema does not know
 * degrades to an opaque value rather than being guessed at, which costs completion detail on that
 * one field and never invents a rule that flags a valid file.
 */
import { SchemaBundle, SchemaEnum, SchemaField, SchemaRegistry, SchemaTypeDef, ValueType } from '../../document/schema/schema.types';
import {
    AttrValue,
    CustomAttr,
    DotNetAssembly,
    FieldInfo,
    Instruction,
    MethodInfo,
    OPCODES,
    PropertyInfo,
    TypeInfo,
    TypeSig,
} from './dotnet-assembly';

const SERIALIZE = 'Halfling.Serialization.SerializeAttribute';
const REFLECTIVE = 'Halfling.Serialization.ReflectiveSerializationAttribute';
const BASETYPE = 'Halfling.Serialization.SerialBaseTypeAttribute';
const DERIVED = 'Halfling.Serialization.SerialDerivedTypeAttribute';
const OTCTOR = 'Halfling.Serialization.ObjectText.ObjectTextConstructorAttribute';
const KEY_VALUE_NAMES = 'Halfling.Serialization.DefaultSerializers.KeyValuePairNamesAttribute';
const DISABLE_NULL = 'Halfling.Serialization.DisableNullSerializationAttribute';
const GENERIC_READER = 'Halfling.Serialization.Generic.GenericSerialReader';
const OT_SERIALIZER = 'Halfling.Serialization.ObjectText.ObjectTextSerializer';

/** The group class a `Modifiable<T>` written in its group form resolves to, as schemagen emits it. */
const MODIFIABLE_VALUE = 'Cosmoteer.Ships.ModifiableValue';

/** What a mod's assemblies add to the shipped schema. */
export interface ModSchemaExtension {
    /** New types, keyed by C# FullName, in the same shape as the shipped bundle's types. */
    types: Record<string, SchemaTypeDef>;
    /** New enums the mod's fields reference, keyed by C# FullName. */
    enums: Record<string, SchemaEnum>;
    /** Registries the mod itself declares with `[SerialBaseType]`. */
    registries: Record<string, SchemaRegistry>;
    /** Discriminators the mod adds to an existing registry: registry FullName to `Type=` to class. */
    registryMembers: Record<string, Record<string, string>>;
    /**
     * The assembly each type was read from, by type FullName. Lets the decompiler hover link open a
     * mod class from the mod's own `.dll` instead of the game's.
     */
    assemblyOf: Record<string, string>;
    /**
     * The C# member each serialized field came from, by type FullName then field name. The schema
     * records the OT name (an alias when the member declares one), but a doc comment is keyed by
     * the member, so the two have to be matched up (see `xml-docs.ts`).
     */
    memberNames: Record<string, Record<string, string>>;
    /**
     * Where each contributing assembly is published, keyed by assembly path. Filled in after
     * extraction (see `mod-schema.ts`), so a hover on a mod class can point at the mod's own page
     * instead of the game's wiki. Absent for an assembly outside the workshop tree.
     */
    modLinks: Record<string, { url: string; name?: string }>;
}

/**
 * The read side of the shipped schema, which stands in for the game assemblies the C# extractor
 * resolves against. Narrow on purpose, so a test can drive extraction from a raw bundle.
 */
export interface GameSchemaView {
    /** A game type by FullName. */
    type(fullName: string): SchemaTypeDef | undefined;
    /** A game registry by FullName. */
    registry(fullName: string): SchemaRegistry | undefined;
    /** A game enum by FullName. */
    enumeration(fullName: string): SchemaEnum | undefined;
}

/**
 * Wrap a schema bundle as the resolver extraction consults for game types.
 *
 * @param bundle the shipped schema.
 * @returns the view.
 */
export const gameSchemaView = (bundle: SchemaBundle): GameSchemaView => ({
    type: (fullName) => bundle.types[fullName],
    registry: (fullName) => bundle.registries[fullName],
    enumeration: (fullName) => bundle.enums[fullName],
});

/** The named argument of an attribute, or undefined when it is unset. */
const named = (attr: CustomAttr | undefined, key: string): AttrValue => attr?.named.get(key);

/** The first attribute of a given class applied to a member, or undefined. */
const attrOf = (attributes: readonly CustomAttr[], fullName: string): CustomAttr | undefined =>
    attributes.find((a) => a.typeFullName === fullName);

/** Whether a type carries `[ReflectiveSerialization]`. */
const isReflective = (type: TypeInfo): boolean => attrOf(type.attributes, REFLECTIVE) !== undefined;

/** Whether a type contributes `[Serialize]` members, which makes it part of the schema graph. */
const hasSerializeMembers = (type: TypeInfo): boolean =>
    type.fields.some((f) => !f.isStatic && attrOf(f.attributes, SERIALIZE)) ||
    type.properties.some((p) => attrOf(p.attributes, SERIALIZE));

/** A type participates in the schema when it is a reflective node or feeds members to one. */
const participates = (type: TypeInfo): boolean => isReflective(type) || hasSerializeMembers(type);

/** The FullName a base-class signature names, when it names one at all. */
const baseName = (sig: TypeSig | undefined): string | undefined =>
    sig && (sig.kind === 'named' || sig.kind === 'generic') ? sig.fullName : undefined;

/**
 * Run the extraction over a mod's assemblies.
 *
 * @param assemblies every assembly of the mod, so a type declared in one and derived from in
 *                   another resolves.
 * @param game the shipped schema, standing in for the game assemblies.
 * @returns everything the mod adds to the schema.
 */
export const extractModSchema = (assemblies: readonly DotNetAssembly[], game: GameSchemaView): ModSchemaExtension =>
    new ModSchemaExtractor(assemblies, game).run();

/** Carries the cross-assembly indexes and the accumulating output of one extraction. */
class ModSchemaExtractor {
    /** Every type declared by the mod, by FullName, across all its assemblies. */
    private readonly modTypes = new Map<string, TypeInfo>();
    /** The assembly each mod type came from, so its tokens resolve against the right image. */
    private readonly ownerOf = new Map<string, DotNetAssembly>();
    private readonly out: ModSchemaExtension = {
        types: {},
        enums: {},
        registries: {},
        registryMembers: {},
        assemblyOf: {},
        memberNames: {},
        modLinks: {},
    };
    /** Memo of the custom-read participation probe, which walks method bodies. */
    private readonly customReadMemo = new Map<string, boolean>();

    constructor(
        assemblies: readonly DotNetAssembly[],
        private readonly game: GameSchemaView
    ) {
        for (const assembly of assemblies) {
            for (const type of assembly.types) {
                if (this.modTypes.has(type.fullName)) continue;
                this.modTypes.set(type.fullName, type);
                this.ownerOf.set(type.fullName, assembly);
            }
        }
    }

    /**
     * Build the registries and types the mod adds.
     *
     * @returns the extension.
     */
    run(): ModSchemaExtension {
        this.buildRegistries();
        this.buildTypes();
        this.prune();
        return this.out;
    }

    /**
     * Drop everything the game can never reach, the same reachability prune schemagen runs from the
     * document root. A mod's assembly is full of runtime classes that participate in serialization
     * for reasons of their own (multiplayer inputs, internal state holders); only what a `.rules`
     * file can actually name belongs in the schema. The entry points are the discriminators the mod
     * adds to a game registry, and everything those reach through inheritance and field types.
     */
    private prune(): void {
        const types = new Set<string>();
        const enums = new Set<string>();
        const queue: string[] = [];
        const enqueue = (fullName: string | undefined): void => {
            if (fullName && this.out.types[fullName] && !types.has(fullName)) queue.push(fullName);
        };
        const enqueueRegistry = (fullName: string | undefined): void => {
            if (!fullName) return;
            const own = this.out.registries[fullName];
            if (own) for (const member of Object.values(own.members)) enqueue(member);
            const added = this.out.registryMembers[fullName];
            if (added) for (const member of Object.values(added)) enqueue(member);
        };
        const visitValue = (valueType: ValueType): void => {
            switch (valueType.kind) {
                case 'group':
                    enqueue(valueType.ref);
                    break;
                case 'polymorphicGroup':
                    enqueue(valueType.ref);
                    enqueueRegistry(valueType.ref);
                    break;
                case 'reference':
                    enqueue(valueType.target);
                    enqueueRegistry(valueType.target);
                    break;
                case 'enum':
                    enums.add(valueType.ref);
                    break;
                case 'int':
                case 'float':
                case 'number':
                    enqueue(valueType.groupForm);
                    break;
                case 'list':
                case 'range':
                case 'interpolated':
                    visitValue(valueType.element);
                    break;
                case 'map':
                    visitValue(valueType.key);
                    visitValue(valueType.value);
                    break;
                case 'tuple':
                    valueType.elements.forEach(visitValue);
                    break;
                case 'constructed':
                    valueType.params.forEach((param) => visitValue(param.valueType));
                    break;
                case 'generic':
                    valueType.args.forEach(visitValue);
                    break;
            }
        };
        // The seeds: every discriminator the mod contributes to a registry the game already has, so
        // a `.rules` file can select it. A registry the mod declares itself is reached only through
        // a field of something already reachable.
        for (const registry of Object.keys(this.out.registryMembers)) enqueueRegistry(registry);
        while (queue.length > 0) {
            const fullName = queue.shift() as string;
            if (types.has(fullName)) continue;
            types.add(fullName);
            const def = this.out.types[fullName];
            enqueue(def.extends);
            enqueueRegistry(def.registry);
            if (def.isRegistry) enqueueRegistry(fullName);
            def.inlineFrom?.forEach(enqueue);
            if (def.valueForm) visitValue(def.valueForm);
            for (const field of def.fields) visitValue(field.valueType);
        }
        for (const fullName of Object.keys(this.out.types)) if (!types.has(fullName)) delete this.out.types[fullName];
        for (const fullName of Object.keys(this.out.assemblyOf)) {
            if (!types.has(fullName)) delete this.out.assemblyOf[fullName];
        }
        for (const fullName of Object.keys(this.out.memberNames)) {
            if (!types.has(fullName)) delete this.out.memberNames[fullName];
        }
        for (const fullName of Object.keys(this.out.enums)) if (!enums.has(fullName)) delete this.out.enums[fullName];
        for (const fullName of Object.keys(this.out.registries)) {
            if (!types.has(fullName)) delete this.out.registries[fullName];
        }
        for (const [registry, members] of Object.entries(this.out.registryMembers)) {
            for (const [disc, cls] of Object.entries(members)) if (!types.has(cls)) delete members[disc];
            if (Object.keys(members).length === 0) delete this.out.registryMembers[registry];
        }
    }

    /**
     * Register every mod type's `Type=` discriminator into the registry its base chain reaches,
     * whether that registry is the game's or the mod's own. Mirrors schemagen: an explicit
     * `[SerialDerivedType]` names the value (a type may carry several, one per accepted spelling),
     * and a concrete participating subclass with no such attribute registers under its class name,
     * which is how the engine's reflective member discovery spells it.
     */
    private buildRegistries(): void {
        for (const type of this.modTypes.values()) {
            const declared = attrOf(type.attributes, BASETYPE);
            if (!declared) continue;
            this.out.registries[type.fullName] = {
                name: type.name,
                typeField: (named(declared, 'TypeFieldName') as string) ?? 'Type',
                valueField: (named(declared, 'ValueFieldName') as string) ?? 'Value',
                members: {},
            };
        }
        for (const type of this.modTypes.values()) {
            const registry = this.nearestRegistryBase(type);
            if (!registry || registry === type.fullName) continue;
            const derivedAttrs = type.attributes.filter((a) => a.typeFullName === DERIVED);
            const members = this.membersOf(registry);
            if (derivedAttrs.length > 0) {
                for (const attr of derivedAttrs) members[(named(attr, 'TypeName') as string) ?? type.name] = type.fullName;
                continue;
            }
            if (type.isAbstract || !participates(type)) continue;
            if (!(type.name in members)) members[type.name] = type.fullName;
        }
    }

    /**
     * The member table new discriminators go into: a mod-declared registry's own table, or the
     * additions table for a game registry.
     *
     * @param registry the registry's FullName.
     * @returns the mutable member map.
     */
    private membersOf(registry: string): Record<string, string> {
        const own = this.out.registries[registry];
        if (own) return own.members;
        return (this.out.registryMembers[registry] ??= {});
    }

    /** Emit a schema type for every mod type that participates or is a provable custom-read group. */
    private buildTypes(): void {
        for (const type of this.modTypes.values()) {
            if (!participates(type) && !this.isCustomReadParticipant(type)) continue;
            const def: SchemaTypeDef = { name: type.name, namespace: type.namespace, fields: [] };
            if (type.isAbstract) def.abstract = true;
            const base = this.nearestSchemaBase(type);
            if (base) def.extends = base;
            const derived = attrOf(type.attributes, DERIVED);
            if (derived) {
                def.derivedType = (named(derived, 'TypeName') as string) ?? type.name;
                const registry = this.nearestRegistryBase(type);
                if (registry) def.registry = registry;
            }
            if (attrOf(type.attributes, BASETYPE)) def.isRegistry = true;
            const valueMember = this.emptyAliasMemberType(type);
            if (valueMember) {
                const mapped = this.mapType(valueMember);
                if (mapped.kind === 'group') def.inlineFrom = [mapped.ref];
                else def.valueForm = mapped;
            }
            if (this.purelyReflective(type)) def.purelyReflective = true;
            def.fields = this.ownFields(type);
            this.out.types[type.fullName] = def;
            const assembly = this.ownerOf.get(type.fullName);
            if (assembly) this.out.assemblyOf[type.fullName] = assembly.path;
        }
    }

    /**
     * The nearest ancestor that carries schema fields, so `extends` links a leaf to the class its
     * fields really come from. Mod-local ancestors are judged directly; the first game ancestor is
     * answered by the shipped schema, which only contains participating types.
     *
     * @param type the mod type.
     * @returns the base's FullName, or undefined when the chain reaches nothing schema-bearing.
     */
    private nearestSchemaBase(type: TypeInfo): string | undefined {
        let current = baseName(type.baseType);
        const guard = new Set<string>();
        while (current && current !== 'System.Object' && !guard.has(current)) {
            guard.add(current);
            const local = this.modTypes.get(current);
            if (!local) {
                // A game ancestor. The shipped schema knows the participating ones, and records
                // each type's own base, so the walk continues through it when this one is not.
                if (this.game.type(current) || this.game.registry(current)) return current;
                const known = this.game.type(current);
                current = known?.extends;
                continue;
            }
            if (participates(local)) return current;
            current = baseName(local.baseType);
        }
        return undefined;
    }

    /**
     * The registry a type's `Type=` dispatches through: the nearest ancestor carrying
     * `[SerialBaseType]`, with implemented interfaces as the fallback for the registries that exist
     * only as interfaces. The class chain wins, as it does in schemagen.
     *
     * @param type the mod type.
     * @returns the registry's FullName, or undefined when the type is in no registry.
     */
    private nearestRegistryBase(type: TypeInfo): string | undefined {
        let current: string | undefined = type.fullName;
        const guard = new Set<string>();
        while (current && current !== 'System.Object' && !guard.has(current)) {
            guard.add(current);
            const local = this.modTypes.get(current);
            if (local) {
                if (attrOf(local.attributes, BASETYPE)) return current;
                current = baseName(local.baseType);
                continue;
            }
            // A game ancestor: the shipped schema names the registries directly, and the type graph
            // carries the rest of the chain.
            if (this.game.registry(current)) return current;
            current = this.game.type(current)?.extends;
        }
        for (const type2 of this.ancestorChain(type)) {
            const iface = this.interfaceRegistry(type2);
            if (iface) return iface;
        }
        return undefined;
    }

    /** The mod-local types on a type's base chain, nearest first, for the interface probe. */
    private *ancestorChain(type: TypeInfo): Generator<TypeInfo> {
        let current: TypeInfo | undefined = type;
        const guard = new Set<string>();
        while (current && !guard.has(current.fullName)) {
            guard.add(current.fullName);
            yield current;
            const next = baseName(current.baseType);
            current = next ? this.modTypes.get(next) : undefined;
        }
    }

    /**
     * A registry reached through implemented interfaces, transitively. Some engine registries put
     * `[SerialBaseType]` on an interface an abstract base implements, so the class chain alone never
     * reaches them.
     *
     * @param type the type whose interfaces are probed.
     * @returns the registry's FullName, or undefined when no interface declares one.
     */
    private interfaceRegistry(type: TypeInfo): string | undefined {
        for (const iface of type.interfaces) {
            const fullName = baseName(iface);
            if (!fullName) continue;
            if (this.game.registry(fullName)) return fullName;
            const local = this.modTypes.get(fullName);
            if (!local) continue;
            if (attrOf(local.attributes, BASETYPE)) return fullName;
            const deeper = this.interfaceRegistry(local);
            if (deeper) return deeper;
        }
        return undefined;
    }

    /**
     * The type of a member serialized under an explicit empty alias, which binds the member to the
     * node itself so the type reads every shape that member type reads.
     *
     * @param type the mod type.
     * @returns the member's type, or undefined when the type declares no such member.
     */
    private emptyAliasMemberType(type: TypeInfo): TypeSig | undefined {
        for (const field of type.fields) {
            if (named(attrOf(field.attributes, SERIALIZE), 'Alias') === '') return field.type;
        }
        for (const property of type.properties) {
            if (named(attrOf(property.attributes, SERIALIZE), 'Alias') === '') return property.type;
        }
        return undefined;
    }

    /**
     * Whether the type and its whole schema-inheritance chain read purely by reflection over their
     * `[Serialize]` members, which is what makes the emitted member list provably complete. A game
     * ancestor answers from the shipped schema's own flag.
     *
     * @param type the mod type.
     * @returns true when nothing in the chain has a hand-written read path.
     */
    private purelyReflective(type: TypeInfo): boolean {
        let current: TypeInfo | undefined = type;
        const guard = new Set<string>();
        while (current && !guard.has(current.fullName)) {
            guard.add(current.fullName);
            if (this.hasCustomDeserialization(current)) return false;
            const base = this.nearestSchemaBase(current);
            if (!base) return true;
            const local = this.modTypes.get(base);
            if (!local) return this.game.type(base)?.purelyReflective === true;
            current = local;
        }
        return true;
    }

    /** Whether a type's deserialization is anything other than plain reflective member reads. */
    private hasCustomDeserialization(type: TypeInfo): boolean {
        return (
            this.hasDeserializationHook(type) ||
            this.emptyAliasMemberType(type) !== undefined ||
            this.customReadCalls(type).length > 0
        );
    }

    /** Whether the engine deserializes the type through a hand-written hook. */
    private hasDeserializationHook(type: TypeInfo): boolean {
        return type.methods.some(
            (m) =>
                (m.isConstructor && attrOf(m.attributes, OTCTOR) !== undefined) ||
                (m.name.endsWith('ReadContentFrom') && m.parameters.some((p) => baseName(p.type) === OT_SERIALIZER)) ||
                (m.isConstructor && m.parameters.some((p) => baseName(p.type) === GENERIC_READER))
        );
    }

    /**
     * A type with no reflective surface that a deserialization hook still reads named keys for, so
     * it is a group of exactly those keys instead of an opaque value.
     *
     * @param type the mod type.
     * @returns true when the type is such a group.
     */
    private isCustomReadParticipant(type: TypeInfo): boolean {
        const cached = this.customReadMemo.get(type.fullName);
        if (cached !== undefined) return cached;
        const result =
            !participates(type) && this.hasDeserializationHook(type) && this.customReadCalls(type).length > 0;
        this.customReadMemo.set(type.fullName, result);
        return result;
    }

    /**
     * Keys a custom deserializer reads through the generic reader rather than as reflected members.
     * The OT key is the call's string literal and the value type its generic argument, both baked
     * into the IL, so both are recovered by scanning the type's method bodies.
     *
     * @param type the mod type.
     * @returns each recovered key with its value type, in the order the bodies mention them.
     */
    private customReadCalls(type: TypeInfo): { name: string; type: TypeSig }[] {
        const assembly = this.ownerOf.get(type.fullName);
        if (!assembly) return [];
        const readers = new Set(['ReadFromPath', 'TryReadFromPath', 'ReadOptionalFromPath']);
        const out: { name: string; type: TypeSig }[] = [];
        for (const method of type.methods) {
            const body = method.body();
            for (let i = 0; i < body.length; i++) {
                const instruction = body[i];
                if (instruction.opcode !== OPCODES.call && instruction.opcode !== OPCODES.callvirt) continue;
                if (typeof instruction.operand !== 'number') continue;
                const target = assembly.callTargetOfToken(instruction.operand);
                if (!target || !readers.has(target.name) || target.genericArgs.length === 0) continue;
                // The path is the call's first argument and the only string among them, so the
                // nearest preceding literal load is it.
                const path = nearestPrecedingString(body, i);
                if (path) out.push({ name: path, type: target.genericArgs[0] });
            }
        }
        return out;
    }

    /**
     * Build the schema fields a type declares itself: every `[Serialize]` field and property with
     * its OT name, mapped value type, optionality, nullability and default, followed by the keys a
     * custom deserializer reads.
     *
     * @param type the mod type.
     * @returns the declared fields, in declaration order with the custom reads last.
     */
    private ownFields(type: TypeInfo): SchemaField[] {
        const out: SchemaField[] = [];
        // The OT name and the C# member name diverge whenever a member declares an alias, and a doc
        // comment is keyed by the member, so the mapping is recorded as each field is emitted.
        const memberNames: Record<string, string> = {};
        const initializers = this.inlineDefaults(type);
        const ctorInitialized = this.constructorInitializedMembers(type);
        const members: { name: string; attributes: readonly CustomAttr[]; type: TypeSig }[] = [
            ...type.fields.filter((f) => !f.isStatic).map((f: FieldInfo) => ({ name: f.name, attributes: f.attributes, type: f.type })),
            ...type.properties.map((p: PropertyInfo) => ({ name: p.name, attributes: p.attributes, type: p.type })),
        ];
        for (const member of members) {
            const serialize = attrOf(member.attributes, SERIALIZE);
            if (!serialize) continue;
            const alias = named(serialize, 'Alias');
            const name = typeof alias === 'string' && alias !== '' ? alias : member.name;
            const valueType = this.mapType(member.type);
            if (valueType.kind === 'map') {
                const entryNames = attrOf(member.attributes, KEY_VALUE_NAMES);
                const entryKey = named(entryNames, 'Key');
                const entryValue = named(entryNames, 'Value');
                if (typeof entryKey === 'string') valueType.entryKey = entryKey;
                if (typeof entryValue === 'string') valueType.entryValue = entryValue;
            }
            // An empty-alias group member is written inline in the owner's group, never under its
            // own name, so the type-level `inlineFrom`/`valueForm` models it instead.
            if (alias === '' && (valueType.kind === 'group' || valueType.kind === 'polymorphicGroup')) continue;
            const explicitlyOptional = named(serialize, 'Optional') === true;
            const field: SchemaField = {
                name,
                valueType,
                optional:
                    explicitlyOptional ||
                    ctorInitialized.has(member.name) ||
                    alias === '' ||
                    isNullableReference(member.attributes) ||
                    (member.type.kind === 'generic' && member.type.name.startsWith('Nullable`')) ||
                    valueType.kind === 'list' ||
                    valueType.kind === 'map',
            };
            if (!explicitlyOptional) field.absentThrows = true;
            if (!this.voidAssignable(member.type)) field.nullable = false;
            const aliases = named(serialize, 'AlternateAliases');
            if (Array.isArray(aliases) && aliases.length > 0) {
                field.aliases = aliases.map((a) => String(a ?? ''));
            }
            const declared = named(serialize, 'DefaultValue');
            const initializer = initializers.get(member.name);
            if (declared !== undefined && declared !== null) {
                field.default = coerceDefault(declared, valueType.kind);
                field.defaultSource = 'attribute';
            } else if (initializer !== undefined) {
                field.default = coerceDefault(initializer, valueType.kind);
                field.defaultSource = 'initializer';
            }
            // A numeric enum default is the C# constant's raw value, useless in a hover, so it is
            // translated back to the member name it stands for when one matches exactly.
            if (valueType.kind === 'enum' && typeof field.default === 'number') {
                const memberName = this.enumDefaultName(member.type, field.default);
                if (memberName !== undefined) field.default = memberName;
            }
            memberNames[name] = member.name;
            out.push(field);
        }
        if (Object.keys(memberNames).length > 0) this.out.memberNames[type.fullName] = memberNames;
        const emitted = new Set(out.map((f) => f.name));
        for (const read of this.customReadCalls(type)) {
            // Every recovered key is optional even when read with the throwing overload: the read
            // may sit in a branch the scan cannot see, so requiredness is not provable here.
            if (read.name === 'Type' || emitted.has(read.name)) continue;
            emitted.add(read.name);
            const field: SchemaField = { name: read.name, valueType: this.mapType(read.type), optional: true };
            if (!this.voidAssignable(read.type)) field.nullable = false;
            out.push(field);
        }
        return out;
    }

    /**
     * Constant field initializers, read from the constant stores of the smallest-arity constructor,
     * which in practice is where the C# compiler puts a field initializer.
     *
     * @param type the mod type.
     * @returns the first constant stored per field name.
     */
    private inlineDefaults(type: TypeInfo): Map<string, number | string | boolean> {
        const out = new Map<string, number | string | boolean>();
        const assembly = this.ownerOf.get(type.fullName);
        const ctor = smallestConstructor(type);
        if (!assembly || !ctor) return out;
        const body = ctor.body();
        for (let i = 1; i < body.length; i++) {
            if (body[i].opcode !== OPCODES.stfld || typeof body[i].operand !== 'number') continue;
            const fieldName = assembly.fieldNameOfToken(body[i].operand as number);
            if (!fieldName || out.has(fieldName)) continue;
            const value = constantOf(body[i - 1]);
            if (value !== undefined) out.set(fieldName, value);
        }
        return out;
    }

    /**
     * Member names the smallest-arity constructor assigns anything to. A class that initializes a
     * member has a default for it, so the deserializer tolerates the key's absence.
     *
     * @param type the mod type.
     * @returns the assigned member names, with auto-property backing fields normalized.
     */
    private constructorInitializedMembers(type: TypeInfo): Set<string> {
        const out = new Set<string>();
        const assembly = this.ownerOf.get(type.fullName);
        const ctor = smallestConstructor(type);
        if (!assembly || !ctor) return out;
        for (const instruction of ctor.body()) {
            if (instruction.opcode !== OPCODES.stfld || typeof instruction.operand !== 'number') continue;
            const fieldName = assembly.fieldNameOfToken(instruction.operand);
            if (fieldName) out.add(backingFieldName(fieldName));
        }
        return out;
    }

    /**
     * Whether deserializing a valueless node into a declared type is legal, which the engine allows
     * for anything it can assign null to.
     *
     * @param sig the member's declared type.
     * @returns true when a bare valueless field is not a load error.
     */
    private voidAssignable(sig: TypeSig): boolean {
        if (sig.kind === 'array') return true;
        if (sig.kind === 'generic') {
            if (sig.name.startsWith('Nullable`')) return true;
            return !this.isValueTypeName(sig.fullName, false);
        }
        if (sig.kind === 'primitive') return sig.fullName === 'System.String' || sig.fullName === 'System.Object';
        if (sig.kind !== 'named') return true;
        return !this.isValueTypeName(sig.fullName, sig.valueType);
    }

    /**
     * Whether a named type is a non-null-tolerant value type.
     *
     * @param fullName the type's FullName.
     * @param signatureSaysValueType whether the signature encoded it as a value type.
     * @returns true when a null cannot be assigned to it.
     */
    private isValueTypeName(fullName: string, signatureSaysValueType: boolean): boolean {
        const local = this.modTypes.get(fullName);
        if (local) {
            if (!local.isValueType) return false;
            // A type that opts out of the serializer's null check handles the void itself.
            return attrOf(local.attributes, DISABLE_NULL) === undefined;
        }
        return signatureSaysValueType;
    }

    /**
     * The enum member name a raw numeric default stands for.
     *
     * @param sig the member's declared type.
     * @param value the raw constant.
     * @returns the member's name, or undefined when no member has that value.
     */
    private enumDefaultName(sig: TypeSig, value: number): string | undefined {
        const fullName = sig.kind === 'generic' && sig.name.startsWith('Nullable`') ? baseName(sig.args[0]) : baseName(sig);
        if (!fullName) return undefined;
        const local = this.modTypes.get(fullName);
        if (!local?.isEnum) return undefined;
        for (const field of local.fields) {
            if (field.isLiteral && field.name !== 'value__' && field.constant === value) return field.name;
        }
        return undefined;
    }

    /**
     * Map a C# type to the schema's value kind, the same table schemagen applies.
     *
     * @param sig the declared type.
     * @returns the value type, `opaque` for anything with a hand-written deserializer this cannot
     *          describe, which makes the validator accept any written shape there.
     */
    private mapType(sig: TypeSig): ValueType {
        if (sig.kind === 'typeParam') return { kind: 'opaque', type: sig.name, reason: 'typeParam' };
        if (sig.kind === 'unknown') return { kind: 'opaque', type: sig.name };
        if (sig.kind === 'array') return { kind: 'list', element: this.mapType(sig.element) };
        if (sig.kind === 'primitive') return mapPrimitive(sig.fullName);
        if (sig.kind === 'generic') return this.mapGeneric(sig);
        return this.mapNamed(sig.fullName, sig.name);
    }

    /** Map a generic instantiation, unwrapping the engine's wrappers and the collection shapes. */
    private mapGeneric(sig: Extract<TypeSig, { kind: 'generic' }>): ValueType {
        const args = sig.args;
        const name = sig.name;
        const arg = (index: number): ValueType => this.mapType(args[index] ?? { kind: 'unknown', name: '' });
        if (name.startsWith('Nullable`') || name.startsWith('MPValue`')) return arg(0);
        if (name.startsWith('ID`')) {
            const target = args[0];
            return {
                kind: 'reference',
                target: baseName(target) ?? '',
                targetName: target && 'name' in target ? target.name : '',
            };
        }
        if (name.startsWith('Range`')) return { kind: 'range', element: arg(0) };
        if (name.startsWith('Interpolated`')) return { kind: 'interpolated', element: arg(0) };
        if (name.startsWith('ValueTuple`')) return { kind: 'tuple', elements: args.map((a) => this.mapType(a)) };
        if (LIST_GENERICS.some((prefix) => name.startsWith(prefix))) return { kind: 'list', element: arg(0) };
        if (MAP_GENERICS.some((prefix) => name.startsWith(prefix))) return { kind: 'map', key: arg(0), value: arg(1) };
        // A mod-local generic whose own members never use its parameters maps like a plain type,
        // which is how a generic base's nested helper types reach the schema.
        const local = this.modTypes.get(sig.fullName);
        if (local && !this.usesGenericParameters(local)) return this.mapNamed(sig.fullName, local.name);
        return { kind: 'generic', type: name, args: args.map((a) => this.mapType(a)) };
    }

    /** Whether a type's serialized surface depends on its generic parameters. */
    private usesGenericParameters(type: TypeInfo): boolean {
        if (type.isEnum) return false;
        const usesParam = (sig: TypeSig): boolean =>
            sig.kind === 'typeParam' ||
            (sig.kind === 'array' && usesParam(sig.element)) ||
            (sig.kind === 'generic' && sig.args.some(usesParam));
        if (type.baseType && usesParam(type.baseType)) return true;
        return (
            type.fields.some((f) => attrOf(f.attributes, SERIALIZE) && usesParam(f.type)) ||
            type.properties.some((p) => attrOf(p.attributes, SERIALIZE) && usesParam(p.type))
        );
    }

    /**
     * Map a named type. Mod-local types are judged from their own metadata; a game type is answered
     * by the shipped schema, with the engine's curated value types named ahead of it because those
     * are read by hand-written deserializers rather than as the groups their class shape suggests.
     *
     * @param fullName the type's FullName.
     * @param shortName the type's short name, which the curated table keys on.
     * @returns the value type.
     */
    private mapNamed(fullName: string, shortName: string): ValueType {
        const local = this.modTypes.get(fullName);
        if (local) {
            const localMapped = this.mapLocalNamed(local, fullName);
            if (localMapped) return localMapped;
        } else {
            const enumeration = this.game.enumeration(fullName);
            if (enumeration) {
                const mapped: ValueType = { kind: 'enum', ref: fullName, name: enumeration.name };
                if (enumeration.enumLike) mapped.enumLike = true;
                return mapped;
            }
            if (this.game.registry(fullName)) {
                return { kind: 'polymorphicGroup', ref: fullName, name: shortName };
            }
        }
        const curated = CURATED_VALUE_TYPES[shortName];
        if (curated) return structuredClone(curated);
        if (!local && this.game.type(fullName)) return { kind: 'group', ref: fullName, name: shortName };
        if (shortName.startsWith('Modifiable')) {
            return { kind: 'number', type: shortName, groupForm: MODIFIABLE_VALUE };
        }
        return { kind: 'opaque', type: shortName };
    }

    /**
     * Map a type the mod itself declares, which is judged from its metadata exactly as schemagen
     * judges a game type.
     *
     * @param type the mod type.
     * @param fullName its FullName.
     * @returns the value type, or undefined to fall through to the curated and opaque handling.
     */
    private mapLocalNamed(type: TypeInfo, fullName: string): ValueType | undefined {
        if (type.isEnum) {
            this.registerEnum(fullName, type, enumMemberNames(type), false);
            return { kind: 'enum', ref: fullName, name: type.name };
        }
        if (attrOf(type.attributes, BASETYPE)) return { kind: 'polymorphicGroup', ref: fullName, name: type.name };
        if (participates(type)) return { kind: 'group', ref: fullName, name: type.name };
        if (this.isCustomReadParticipant(type) && !type.name.startsWith('Modifiable')) {
            return { kind: 'group', ref: fullName, name: type.name };
        }
        // An enum-like struct exposes its values as static fields of its own type. A numeric value
        // type that merely names a few constants is excluded: it accepts arbitrary numbers.
        const constants = type.fields.filter((f) => f.isStatic && f.isPublic && baseName(f.type) === fullName);
        const hasNumericConversion = type.methods.some(
            (m) =>
                m.isStatic &&
                (m.name === 'op_Implicit' || m.name === 'op_Explicit') &&
                NUMERIC_NAMES.has(shortOf(baseName(m.returnType) ?? ''))
        );
        if (constants.length >= 2 && !hasNumericConversion && type.name !== 'Angle') {
            this.registerEnum(fullName, type, constants.map((f) => f.name), true);
            return { kind: 'enum', ref: fullName, name: type.name, enumLike: true };
        }
        const constructor = type.methods.find(
            (m) =>
                m.isConstructor &&
                attrOf(m.attributes, OTCTOR) !== undefined &&
                !m.parameters.some((p) => PLUMBING.has(shortOf(baseName(p.type) ?? '')))
        );
        if (constructor) {
            return {
                kind: 'constructed',
                type: type.name,
                params: constructor.parameters.map((p) => ({ name: p.name, valueType: this.mapType(p.type) })),
            };
        }
        return undefined;
    }

    /** Record a mod enum the first time a field references it. */
    private registerEnum(fullName: string, type: TypeInfo, members: string[], enumLike: boolean): void {
        if (this.out.enums[fullName]) return;
        const def: SchemaEnum = { name: type.name, members };
        if (enumLike) def.enumLike = true;
        this.out.enums[fullName] = def;
    }
}

/** Generic collection types the engine reads as a `.rules` list. */
const LIST_GENERICS = [
    'List`',
    'IList`',
    'IReadOnlyList`',
    'IReadOnlyCollection`',
    'ICollection`',
    'IEnumerable`',
    'ImmutableArray`',
    'HashSet`',
    'SortedSet`',
];

/** Generic dictionary types the engine reads as a `.rules` map. */
const MAP_GENERICS = ['Dictionary`', 'IDictionary`', 'IReadOnlyDictionary`', 'SortedDictionary`'];

/** Numeric type names whose conversion operator marks an enum-like candidate as really numeric. */
const NUMERIC_NAMES = new Set(['Single', 'Double', 'Decimal', 'Int32', 'Int64', 'Int16', 'Byte', 'UInt32']);

/** Constructor parameter types that mark a constructor as deserializer plumbing, not schema. */
const PLUMBING = new Set([
    'ObjectTextSerializer',
    'IOTNode',
    'OTNode',
    'ProgressTracker',
    'IObjectTextDeserializer',
    'IObjectTextContentDeserializer',
    'ITrackingContext',
    'MemberInfo',
]);

/**
 * The engine value types read by a hand-written deserializer, keyed by short name. These are named
 * ahead of the shipped schema's own type lookup because their written form is not the group their
 * class shape would suggest: a `Texture` is an image path, an `Angle` a number.
 */
const CURATED_VALUE_TYPES: Record<string, ValueType> = {
    Angle: { kind: 'number', unit: 'degrees', type: 'Angle' },
    Direction: { kind: 'number', unit: 'degrees', type: 'Direction' },
    KeyString: { kind: 'string', semantic: 'localizationKey' },
    AbsolutePath: { kind: 'string', semantic: 'path' },
    RelativePath: { kind: 'string', semantic: 'path' },
    FilePath: { kind: 'string', semantic: 'path' },
    Texture: { kind: 'asset', assetKind: 'image' },
    Sound: { kind: 'asset', assetKind: 'sound' },
    Shader: { kind: 'asset', assetKind: 'shader' },
    Font: { kind: 'group', ref: 'Halfling.Graphics.Font', name: 'Font' },
    Cursor: { kind: 'group', ref: 'Halfling.Gui.Cursor', name: 'Cursor' },
    CompiledCode: { kind: 'code', lang: 'python' },
    VirtualInternalCell: {
        kind: 'group',
        ref: 'Cosmoteer.Ships.Parts.VirtualInternalCell',
        name: 'VirtualInternalCell',
    },
    PartConversion: { kind: 'group', ref: 'Cosmoteer.Generators.Ships.PartConversion', name: 'PartConversion' },
    IInputButton: { kind: 'list', element: { kind: 'enum', ref: 'Halfling.Input.ViKey', name: 'ViKey' } },
};

/** The short name of a FullName. */
const shortOf = (fullName: string): string => {
    const slash = fullName.lastIndexOf('/');
    const tail = slash >= 0 ? fullName.slice(slash + 1) : fullName;
    const dot = tail.lastIndexOf('.');
    return dot >= 0 ? tail.slice(dot + 1) : tail;
};

/** The value kind of a .NET primitive. */
const mapPrimitive = (fullName: string): ValueType => {
    switch (fullName) {
        case 'System.Boolean':
            return { kind: 'bool' };
        case 'System.String':
            return { kind: 'string' };
        case 'System.Byte':
        case 'System.SByte':
        case 'System.Int16':
        case 'System.UInt16':
        case 'System.Int32':
        case 'System.UInt32':
        case 'System.Int64':
        case 'System.UInt64':
            return { kind: 'int' };
        case 'System.Single':
        case 'System.Double':
            return { kind: 'float' };
        default:
            return { kind: 'opaque', type: shortOf(fullName) };
    }
};

/** The literal member names of an enum, dropping the synthetic value field. */
const enumMemberNames = (type: TypeInfo): string[] =>
    type.fields.filter((f) => f.isLiteral && f.name !== 'value__').map((f) => f.name);

/** The auto-property name behind a `<Foo>k__BackingField` compiler-generated field name. */
const backingFieldName = (name: string): string => {
    if (name.length > 1 && name[0] === '<') {
        const end = name.indexOf('>');
        if (end > 1) return name.slice(1, end);
    }
    return name;
};

/** The smallest-arity instance constructor, whose body carries the field initializers. */
const smallestConstructor = (type: TypeInfo): MethodInfo | undefined => {
    let best: MethodInfo | undefined;
    for (const method of type.methods) {
        if (!method.isConstructor || method.isStatic) continue;
        if (!best || method.parameters.length < best.parameters.length) best = method;
    }
    return best;
};

/** The constant an instruction loads, or undefined when it loads something else. */
const constantOf = (instruction: Instruction): number | string | boolean | undefined => {
    const { opcode, operand } = instruction;
    if (opcode >= OPCODES.ldc_i4_0 && opcode <= OPCODES.ldc_i4_8) return opcode - OPCODES.ldc_i4_0;
    if (opcode === OPCODES.ldc_i4_m1) return -1;
    if (opcode === OPCODES.ldc_i4 || opcode === OPCODES.ldc_i4_s || opcode === OPCODES.ldc_i8) {
        return typeof operand === 'number' ? operand : undefined;
    }
    if (opcode === OPCODES.ldc_r4 || opcode === OPCODES.ldc_r8) {
        return typeof operand === 'number' ? operand : undefined;
    }
    if (opcode === OPCODES.ldstr) return typeof operand === 'string' ? operand : undefined;
    return undefined;
};

/** The literal of the nearest `ldstr` before an index, which is a call's string argument. */
const nearestPrecedingString = (body: readonly Instruction[], from: number): string | undefined => {
    for (let i = from - 1; i >= 0; i--) {
        if (body[i].opcode === OPCODES.ldstr) return typeof body[i].operand === 'string' ? (body[i].operand as string) : undefined;
    }
    return undefined;
};

/** Whether a member carries the compiler's nullable-reference annotation for its own type. */
const isNullableReference = (attributes: readonly CustomAttr[]): boolean => {
    const nullable = attributes.find((a) => shortOf(a.typeFullName) === 'NullableAttribute');
    const first = nullable?.ctorArgs[0];
    if (typeof first === 'number') return first === 2;
    if (Array.isArray(first)) return first[0] === 2;
    return false;
};

/**
 * Fit an extracted constant into the schema's default field, which stores a bool for a bool-typed
 * member even when the C# constant is the integer the IL loaded.
 *
 * @param value the raw constant.
 * @param kind the field's mapped value kind.
 * @returns the default as the schema records it.
 */
const coerceDefault = (value: AttrValue, kind: ValueType['kind']): string | number | boolean | undefined => {
    if (value === null || value === undefined) return undefined;
    if (Array.isArray(value)) return undefined;
    if (typeof value === 'object') return value.typeName;
    if (kind === 'bool' && typeof value === 'number') return value !== 0;
    if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
    return value;
};
