/**
 * The component-slot pass of the mod schema extraction, a port of schemagen's
 * `SchemaGen.ComponentSlots.cs` and `SchemaGen.SlotWalk.cs` onto the TypeScript metadata reader.
 *
 * A slot is a `[Serialize]` member typed `ID<PartComponentRules>` (or a nullable, list, array or
 * tuple of those). Every one of them maps to the same schema value type, the registry base, so the
 * schema alone cannot say which kind of component belongs there. The code can: the value is
 * resolved at runtime through `Part.GetComponent<T>` or `Part.TryGetComponent<T>`, and `T` is the
 * kind. `GetComponent<T>` throws when the component is of another kind, so a mis-slotted component
 * is a crash when the part is built.
 *
 * The pass recovers that `T` by a local abstract interpretation of every method body the mod
 * declares: one operand stack and one local array, each value carrying the set of slots it came
 * from. A field or getter load of a slot member starts a tag, the tag rides through
 * `Nullable.GetValueOrDefault`, indexers and enumerators, merges at branch targets, and a call to one
 * of the lookups with a tagged argument records the pair. Nothing interprocedural is needed, since
 * every such path stays inside one method body.
 *
 * What is deliberately refused, because the game's own files contradict it: the blueprint and wreck
 * containers, where a slot pointing at a component with no blueprint half is the ordinary case; the
 * rules-level shape that looks a slot up in `ComponentsByID`; and the kind every component
 * satisfies. Everything the pass cannot place is left without an entry, which is what tells the
 * language server to say nothing rather than to guess.
 *
 * Only the mod's assemblies are read here. The game's own slots, capabilities and ancestry are
 * already in the shipped bundle, so where a mod type's ancestry runs into a game class or
 * interface, the kinds that game type satisfies are read from the bundle's `componentAncestry`.
 */
import {
    CallTarget,
    DotNetAssembly,
    FieldRef,
    Instruction,
    MethodInfo,
    TypeInfo,
    TypeSig,
} from './dotnet-assembly.types';

/** One recovered lookup of a slot: the runtime kind asked for, and whether the lookup throws. */
export interface SlotLookup {
    readonly kind: string;
    readonly throws: boolean;
}

/** What the pass recovers from a mod's assemblies. */
export interface ComponentSlotAnalysis {
    /**
     * The recovered kind of each slot, keyed `declaringTypeFullName::serializedName`. `throws` is
     * true when any call site reads the slot through `GetComponent`, which fails the part load.
     */
    readonly slots: ReadonlyMap<string, SlotLookup>;
    /**
     * Which kinds each component rules class satisfies, keyed by its FullName, as kind FullNames. A
     * class that builds no physical component has no entry at all, which is what makes the check
     * abstain on it rather than report.
     */
    readonly capabilities: ReadonlyMap<string, readonly string[]>;
}

/** What the pass needs to know about the game's side of the class hierarchy. */
export interface GameHierarchy {
    /** The schema base of a game type, or undefined for a type the bundle does not carry. */
    extendsOf(fullName: string): string | undefined;
    /** The kinds a game component rules class satisfies, as indices into `kindNames`. */
    capabilitiesOf(fullName: string): readonly number[] | undefined;
    /** The kinds a game class or interface satisfies through its ancestry, as indices into `kindNames`. */
    ancestryOf(fullName: string): readonly number[] | undefined;
    /** The game's kind names, in bundle order. */
    readonly kindNames: readonly string[];
}

const PART_COMPONENT_RULES = 'Cosmoteer.Ships.Parts.PartComponentRules';
const LIVE_PART = 'Cosmoteer.Ships.Parts.Part';
const PART_COMPONENT = 'Cosmoteer.Ships.Parts.PartComponent';
const BULLET_COMPONENT_RULES = 'Cosmoteer.Bullets.BulletComponentRules';
const BULLET_COMPONENT = 'Cosmoteer.Bullets.IBulletComponent';
/**
 * The game's base implementation of `IBulletComponent`. A mod's bullet component derives from it
 * rather than implementing the interface itself, and a base class's interfaces are not repeated on
 * the derived type's metadata, so the interface is credited through the base's name.
 */
const BULLET_COMPONENT_BASE = 'Cosmoteer.Bullets.BulletComponent';
const SERIALIZE = 'Halfling.Serialization.SerializeAttribute';

/** A slot member: the class that declares it, and what the OT calls it. */
interface SlotMember {
    readonly declaring: string;
    readonly serialized: string;
}

/** A value on the modelled stack: which slots it came from, and what it literally is. */
interface SlotValue {
    /** The slot keys this value came from, undefined when it came from none. */
    readonly tags?: ReadonlySet<string>;
    /** The string this value is, for a literal, which names a read key. */
    readonly literal?: string;
    /** The local this value is the address of, so an `out` write can be followed, or -1. */
    readonly localAddress: number;
    /**
     * True for a component a bullet's own dictionary handed back for a tagged id. A bullet has no
     * typed lookup to read a kind from: the id goes through a plain indexer and the kind is the cast
     * that follows, so the walk carries the value until it meets that cast.
     */
    readonly fromComponentLookup: boolean;
}

/** An untagged value, which is everything the walk does not follow. */
const NONE: SlotValue = { localAddress: -1, fromComponentLookup: false };

/**
 * One value carrying one slot tag.
 *
 * @param tag the slot key.
 * @returns the tagged value.
 */
const valueOf = (tag: string): SlotValue => ({ tags: new Set([tag]), localAddress: -1, fromComponentLookup: false });

/**
 * A value carrying a set of tags, untagged when the set is empty or absent.
 *
 * @param tags the slot keys.
 * @param fromComponentLookup whether the value is a component handed back for a tagged id.
 * @returns the value.
 */
const valueWith = (tags: ReadonlySet<string> | undefined, fromComponentLookup = false): SlotValue =>
    tags && tags.size > 0 ? { tags: new Set(tags), localAddress: -1, fromComponentLookup } : NONE;

/**
 * The union of two values, which is what a branch join produces.
 *
 * @param left one incoming value.
 * @param right the other.
 * @returns the merged value.
 */
const mergeValues = (left: SlotValue | undefined, right: SlotValue | undefined): SlotValue => {
    if (!left) return right ?? NONE;
    if (!right) return left;
    if (!left.tags && !right.tags) return NONE;
    const tags = new Set<string>();
    for (const tag of left.tags ?? []) tags.add(tag);
    for (const tag of right.tags ?? []) tags.add(tag);
    return {
        tags,
        localAddress: left.localAddress >= 0 ? left.localAddress : right.localAddress,
        fromComponentLookup: false,
    };
};

/** The modelled machine state at one point in a method body. */
class SlotState {
    /** The operand stack, innermost last. */
    readonly stack: SlotValue[] = [];
    /** The method's locals. */
    readonly locals: (SlotValue | undefined)[];
    /** True after a `br`, `ret` or `throw`, where the state means nothing until a join. */
    unreachable = false;

    /**
     * A fresh state for a body with that many locals.
     *
     * @param locals how many locals the body declares.
     */
    constructor(locals: number) {
        this.locals = new Array<SlotValue | undefined>(locals).fill(undefined);
    }

    /**
     * Pops one value, answering an untagged one when the modelled stack ran dry.
     *
     * @returns the value.
     */
    pop(): SlotValue {
        return this.stack.pop() ?? NONE;
    }

    /**
     * Pushes one value.
     *
     * @param value the value.
     */
    push(value: SlotValue): void {
        this.stack.push(value);
    }

    /**
     * Reads a local.
     *
     * @param index the local's index.
     * @returns its value, untagged when out of range or never written.
     */
    getLocal(index: number): SlotValue {
        return (index >= 0 && index < this.locals.length && this.locals[index]) || NONE;
    }

    /**
     * Writes a local, overwriting rather than merging, since the compiler reuses one.
     *
     * @param index the local's index.
     * @param value the value written.
     */
    setLocal(index: number, value: SlotValue): void {
        if (index >= 0 && index < this.locals.length) this.locals[index] = value;
    }

    /**
     * A copy, so a branch target keeps the state as it was at the branch.
     *
     * @returns the copy.
     */
    clone(): SlotState {
        const copy = new SlotState(this.locals.length);
        copy.unreachable = this.unreachable;
        copy.stack.push(...this.stack);
        for (let index = 0; index < this.locals.length; index++) copy.locals[index] = this.locals[index];
        return copy;
    }

    /**
     * The join of two states. Stacks of different depths are dropped rather than merged, since a
     * disagreement there means the walk lost track and a merged stack would be fiction.
     *
     * @param left one incoming state.
     * @param right the other.
     * @returns the merged state.
     */
    static merge(left: SlotState, right: SlotState): SlotState {
        const merged = new SlotState(Math.max(left.locals.length, right.locals.length));
        for (let index = 0; index < merged.locals.length; index++) {
            merged.locals[index] = mergeValues(left.locals[index], right.locals[index]);
        }
        if (left.stack.length === right.stack.length) {
            for (let index = 0; index < left.stack.length; index++) {
                merged.stack.push(mergeValues(left.stack[index], right.stack[index]));
            }
        }
        return merged;
    }
}

/**
 * Whether a type is an `ID<PartComponentRules>` or an `ID<BulletComponentRules>`, directly or
 * wrapped. A bullet owns its components the way a part does, and the slots on both sides are
 * resolved through a typed lookup, so both are walked as the same shape.
 *
 * @param sig the type to test.
 * @returns 1 for a single id, 2 for a collection or tuple carrying one, 0 for anything else.
 */
const componentIdShape = (sig: TypeSig | undefined): number => {
    if (!sig) return 0;
    switch (sig.kind) {
        case 'array':
            return componentIdShape(sig.element) !== 0 ? 2 : 0;
        case 'generic': {
            const first = sig.args[0];
            if (sig.name.startsWith('ID`') && first && 'fullName' in first) {
                if (first.fullName === PART_COMPONENT_RULES || first.fullName === BULLET_COMPONENT_RULES) return 1;
            }
            if (sig.name.startsWith('Nullable`')) return componentIdShape(first) === 1 ? 1 : 0;
            for (const argument of sig.args) if (componentIdShape(argument) !== 0) return 2;
            return 0;
        }
        default:
            return 0;
    }
};

/**
 * The FullName a type reference reads as, spelled the way Cecil spells it so a generic instantiation
 * carries its arguments in angle brackets.
 *
 * @param sig the type.
 * @returns the name.
 */
const fullNameOf = (sig: TypeSig): string => {
    switch (sig.kind) {
        case 'primitive':
        case 'named':
            return sig.fullName;
        case 'generic':
            return `${sig.fullName}<${sig.args.map(fullNameOf).join(',')}>`;
        case 'array':
            return `${fullNameOf(sig.element)}[]`;
        default:
            return sig.name;
    }
};

/**
 * Whether a type mentions a generic parameter anywhere.
 *
 * @param sig the type.
 * @returns true when it does.
 */
const containsTypeParam = (sig: TypeSig): boolean => {
    switch (sig.kind) {
        case 'typeParam':
            return true;
        case 'generic':
            return sig.args.some(containsTypeParam);
        case 'array':
            return containsTypeParam(sig.element);
        default:
            return false;
    }
};

/**
 * The short name of a FullName, which is what a generic family is told apart by.
 *
 * @param fullName the name.
 * @returns everything after the last dot.
 */
const shortOf = (fullName: string): string => {
    const dot = fullName.lastIndexOf('.');
    return dot >= 0 ? fullName.slice(dot + 1) : fullName;
};

/**
 * The OT name a member is written under, which is its alias when it declares one.
 *
 * @param attributes the member's attributes.
 * @param fallback the C# member name, used when no alias is declared.
 * @returns the serialized name.
 */
const serializedNameOf = (
    attributes: readonly { typeFullName: string; named: ReadonlyMap<string, unknown> }[],
    fallback: string
): string => {
    const serialize = attributes.find((attribute) => attribute.typeFullName === SERIALIZE);
    if (!serialize) return fallback;
    const alias = serialize.named.get('Alias');
    return typeof alias === 'string' && alias.length > 0 ? alias : fallback;
};

/**
 * Whether a call is made on the dictionary a bullet holds its own components in. Read from the key
 * type rather than from the value, since the dictionary's members are declared in terms of its type
 * parameters and the instantiated value type never appears on the call itself.
 *
 * @param called the call.
 * @returns true for the bullet's component dictionary.
 */
const isBulletComponentMap = (called: CallTarget): boolean => {
    const key = called.declaringArgs[0];
    if (!key || key.kind !== 'generic' || !key.name.startsWith('ID`')) return false;
    const rules = key.args[0];
    return rules !== undefined && 'fullName' in rules && rules.fullName === BULLET_COMPONENT_RULES;
};

/**
 * A called method's parameter type with the declaring generic instance's arguments substituted in.
 * `Dictionary<ID<…>, …>.TryGetValue` states its parameter as `!0`, and without the substitution
 * every map lookup of an id is lost.
 *
 * @param called the call.
 * @param index the parameter's position.
 * @returns the parameter's type as this call site sees it.
 */
const slotParamType = (called: CallTarget, index: number): TypeSig | undefined => {
    const type = called.parameters[index];
    if (type?.kind === 'typeParam' && !type.ofMethod && type.position < called.declaringArgs.length) {
        return called.declaringArgs[type.position];
    }
    return type;
};

/** The methods whose generic argument names the kind a component slot must be. */
const isComponentLookup = (name: string): boolean => name === 'GetComponent' || name === 'TryGetComponent';

/** The reads of a key from a path, which create a slot no C# member declares. */
const READ_NAMES = new Set(['TryReadFromPath', 'ReadFromPath', 'ReadOptionalFromPath', 'ReadFromPathOrDefault']);

/** The calls that hand their receiver or first argument straight back, so a tag rides through. */
const PASSTHROUGH_NAMES = new Set([
    'get_Item',
    'get_Current',
    'GetEnumerator',
    'ToArray',
    'ToList',
    'ToImmutableArray',
    'AsSpan',
    'get_Span',
    'First',
    'Last',
    'ElementAt',
    'Single',
    'get_Value',
    'GetValueOrDefault',
]);

const OP = {
    ldarg_0: 0x02,
    ldarg_3: 0x05,
    ldloc_0: 0x06,
    ldloc_3: 0x09,
    stloc_0: 0x0a,
    stloc_3: 0x0d,
    ldarg_s: 0x0e,
    ldloc_s: 0x11,
    ldloca_s: 0x12,
    stloc_s: 0x13,
    dup: 0x25,
    ret: 0x2a,
    br_s: 0x2b,
    brfalse_s: 0x2c,
    brtrue_s: 0x2d,
    beq_s: 0x2e,
    blt_un_s: 0x37,
    br: 0x38,
    brfalse: 0x39,
    brtrue: 0x3a,
    beq: 0x3b,
    blt_un: 0x44,
    switch: 0x45,
    callvirt: 0x6f,
    call: 0x28,
    ldstr: 0x72,
    newobj: 0x73,
    castclass: 0x74,
    isinst: 0x75,
    throw: 0x7a,
    ldfld: 0x7b,
    ldflda: 0x7c,
    stfld: 0x7d,
    ldsfld: 0x7e,
    ldsflda: 0x7f,
    stsfld: 0x80,
    ldelema: 0x8f,
    ldelem_ref: 0x9a,
    ldelem: 0xa3,
    unbox_any: 0xa5,
    endfinally: 0xdc,
    leave: 0xdd,
    leave_s: 0xde,
    ldarg: 0xfe09,
    ldloc: 0xfe0c,
    ldloca: 0xfe0d,
    stloc: 0xfe0e,
    rethrow: 0xfe1a,
} as const;

/** How many values each opcode pops and pushes, read from the opcode's own stack behaviour. */
const POPS = new Map<number, number>();
const PUSHES = new Map<number, number>();
{
    const set = (table: Map<number, number>, count: number, codes: readonly number[]): void => {
        for (const code of codes) table.set(code, count);
    };
    const range = (from: number, to: number): number[] =>
        Array.from({ length: to - from + 1 }, (_unused, index) => from + index);
    set(POPS, 1, [
        ...range(0x0a, 0x0d),
        0x10,
        0x13,
        0x25,
        0x26,
        0x2c,
        0x2d,
        0x39,
        0x3a,
        0x45,
        ...range(0x46, 0x4e),
        0x65,
        0x66,
        ...range(0x67, 0x6e),
        0x71,
        0x74,
        0x75,
        0x76,
        0x79,
        0x7a,
        0x7b,
        0x7c,
        0x80,
        ...range(0x82, 0x8e),
        0xa5,
        ...range(0xb3, 0xba),
        0xc2,
        0xc3,
        0xc6,
        ...range(0xd1, 0xd5),
        0xe0,
        0xfe07,
        0xfe0b,
        0xfe0e,
        0xfe0f,
        0xfe11,
        0xfe15,
        0xfe1d,
    ]);
    set(POPS, 2, [
        ...range(0x2e, 0x37),
        ...range(0x3b, 0x44),
        ...range(0x4f, 0x56),
        ...range(0x58, 0x64),
        0x70,
        0x7d,
        0x81,
        0x8f,
        ...range(0x90, 0x9a),
        0xa3,
        ...range(0xd6, 0xdb),
        0xdf,
        ...range(0xfe01, 0xfe05),
    ]);
    set(POPS, 3, [...range(0x9b, 0xa2), 0xa4, 0xfe17, 0xfe18]);
    set(PUSHES, 1, [
        ...range(0x02, 0x09),
        0x0e,
        0x0f,
        0x11,
        0x12,
        ...range(0x14, 0x23),
        ...range(0x46, 0x4e),
        ...range(0x58, 0x6e),
        0x71,
        0x72,
        0x74,
        0x75,
        0x76,
        0x79,
        0x7b,
        0x7c,
        0x7e,
        0x7f,
        ...range(0x82, 0x9a),
        0xa3,
        0xa5,
        ...range(0xb3, 0xba),
        0xc2,
        0xc3,
        0xc6,
        0xd0,
        ...range(0xd1, 0xdb),
        0xe0,
        0xfe00,
        ...range(0xfe01, 0xfe07),
        0xfe09,
        0xfe0a,
        0xfe0c,
        0xfe0d,
        0xfe0f,
        0xfe1c,
        0xfe1d,
    ]);
    set(PUSHES, 2, [0x25]);
}

/**
 * Reads the local index an instruction names, whether inline or in its opcode.
 *
 * @param instruction the instruction.
 * @returns the index, or -1 when it names none.
 */
const localIndexOf = (instruction: Instruction): number => {
    const { opcode, operand } = instruction;
    if (opcode >= OP.ldloc_0 && opcode <= OP.ldloc_3) return opcode - OP.ldloc_0;
    if (opcode >= OP.stloc_0 && opcode <= OP.stloc_3) return opcode - OP.stloc_0;
    return typeof operand === 'number' ? operand : -1;
};

/**
 * Reads the argument index an instruction names, `this` counted as zero.
 *
 * @param instruction the instruction.
 * @returns the index, or -1 when it names none.
 */
const argIndexOf = (instruction: Instruction): number => {
    const { opcode, operand } = instruction;
    if (opcode >= OP.ldarg_0 && opcode <= OP.ldarg_3) return opcode - OP.ldarg_0;
    return typeof operand === 'number' ? operand : -1;
};

/**
 * The offsets an instruction can branch to.
 *
 * @param instruction the instruction.
 * @returns the target offsets, empty for a non-branch.
 */
const branchTargetsOf = (instruction: Instruction): readonly number[] => {
    const { opcode, operand } = instruction;
    if (instruction.targets) return instruction.targets;
    const short = opcode >= OP.br_s && opcode <= OP.blt_un_s;
    const long = opcode >= OP.br && opcode <= OP.blt_un;
    if ((short || long || opcode === OP.leave || opcode === OP.leave_s) && typeof operand === 'number')
        return [operand];
    return [];
};

/** The per-mod pass: the tables schemagen keeps on its generator, and the walk that fills them. */
class ComponentSlotPass {
    /** Every slot member found, keyed `declaringTypeFullName::memberName`. */
    private readonly slotMembers = new Map<string, SlotMember>();
    /** Getter method keys (`declaringType::get_Name`) to the slot members they read. */
    private readonly slotGetters = new Map<string, string[]>();
    /** Auto-property backing fields to the member key they belong to. */
    private readonly slotBackingFields = new Map<string, string>();
    /** The lookups recorded per slot key, filled by the walk. */
    private slotLookups = new Map<string, SlotLookup[]>();
    /** Where a slot's value is stored on to, so a key read from a path reaches its member. */
    private slotAliasEdges = new Map<string, string[]>();

    constructor(
        private readonly types: ReadonlyMap<string, TypeInfo>,
        private readonly ownerOf: ReadonlyMap<string, DotNetAssembly>,
        private readonly game: GameHierarchy
    ) {}

    /**
     * Recovers the expected runtime kind of every component slot and which kinds each component
     * class satisfies.
     *
     * @returns the analysis.
     */
    run(): ComponentSlotAnalysis {
        this.collectSlotMembers();
        // Two rounds, because a key read from a path can be created by a method analysed after the
        // one that consumes it. The second round is a replay with the key table already complete,
        // not a fixpoint.
        for (let round = 0; round < 2; round++) {
            this.slotLookups = new Map();
            this.slotAliasEdges = new Map();
            for (const type of this.types.values()) {
                const assembly = this.ownerOf.get(type.fullName);
                if (!assembly) continue;
                for (const method of type.methods) {
                    if (method.body().length > 0) this.walkForSlots(type, method, assembly);
                }
            }
        }
        const slots = this.buildSlotTable();
        const kindNames = [...this.game.kindNames];
        for (const kind of [...new Set([...slots.values()].map((slot) => slot.kind))].sort()) {
            if (!kindNames.includes(kind)) kindNames.push(kind);
        }
        return { slots, capabilities: this.buildCapabilities(kindNames) };
    }

    /** Collects every field and property carrying a component id, with their getters. */
    private collectSlotMembers(): void {
        const addGetter = (getterKey: string, memberKey: string): void => {
            const keys = this.slotGetters.get(getterKey) ?? [];
            if (!keys.includes(memberKey)) keys.push(memberKey);
            this.slotGetters.set(getterKey, keys);
        };
        for (const type of this.types.values()) {
            for (const field of type.fields) {
                if (componentIdShape(field.type) === 0) continue;
                // A compiler-generated backing field is reached through its property instead.
                if (field.name.startsWith('<')) continue;
                this.slotMembers.set(`${type.fullName}::${field.name}`, {
                    declaring: type.fullName,
                    serialized: serializedNameOf(field.attributes, field.name),
                });
            }
            for (const property of type.properties) {
                if (componentIdShape(property.type) === 0) continue;
                const key = `${type.fullName}::${property.name}`;
                this.slotMembers.set(key, {
                    declaring: type.fullName,
                    serialized: serializedNameOf(property.attributes, property.name),
                });
                if (type.methods.some((method) => method.name === `get_${property.name}`)) {
                    addGetter(`${type.fullName}::get_${property.name}`, key);
                }
                this.slotBackingFields.set(`${type.fullName}::<${property.name}>k__BackingField`, key);
            }
        }
        // A slot read through an interface reference dispatches to the interface's getter, so that
        // getter has to reach every implementing class's own member. An interface the mod declares
        // is checked for the property. A game interface's members are not readable here, so its
        // getter is wired without the check: a call to `I::get_P` can only exist in the mod's IL if
        // `I` declares `P`, which makes the wider wiring safe.
        for (const type of this.types.values()) {
            if (type.isInterface) continue;
            for (const property of type.properties) {
                if (componentIdShape(property.type) === 0) continue;
                if (!type.methods.some((method) => method.name === `get_${property.name}`)) continue;
                const key = `${type.fullName}::${property.name}`;
                for (const iface of this.implementedInterfaces(type)) {
                    const definition = this.types.get(iface);
                    if (!definition) {
                        addGetter(`${iface}::get_${property.name}`, key);
                        continue;
                    }
                    const declared = definition.properties.find((p) => p.name === property.name);
                    if (declared && definition.methods.some((method) => method.name === `get_${property.name}`)) {
                        addGetter(`${definition.fullName}::get_${property.name}`, key);
                    }
                }
            }
        }
    }

    /**
     * Every interface a type implements, its mod-declared bases' included.
     *
     * @param type the type to walk.
     * @returns the interface FullNames, each once.
     */
    private implementedInterfaces(type: TypeInfo): string[] {
        const seen = new Set<string>();
        let current: TypeInfo | undefined = type;
        while (current) {
            for (const iface of current.interfaces) if ('fullName' in iface) seen.add(iface.fullName);
            const base: TypeSig | undefined = current.baseType;
            current = base && 'fullName' in base ? this.types.get(base.fullName) : undefined;
        }
        return [...seen];
    }

    /**
     * Records one recovered lookup against a slot key.
     *
     * @param key the slot key the tag names.
     * @param lookup the kind asked for and whether the call throws.
     */
    private recordLookup(key: string, lookup: SlotLookup): void {
        const found = this.slotLookups.get(key) ?? [];
        found.push(lookup);
        this.slotLookups.set(key, found);
    }

    /**
     * Records that one slot's value is stored into another slot member.
     *
     * @param from the slot the value came from.
     * @param to the member it is stored into.
     */
    private recordAliasEdge(from: string, to: string): void {
        if (from === to) return;
        const edges = this.slotAliasEdges.get(from) ?? [];
        if (!edges.includes(to)) edges.push(to);
        this.slotAliasEdges.set(from, edges);
    }

    /**
     * The lookups a slot reaches, following the members its value is stored into.
     *
     * @param key the slot key.
     * @param seen keys already visited, which stops a cycle.
     * @returns every lookup recorded for the slot or for what it feeds.
     */
    private lookupsOf(key: string, seen = new Set<string>()): SlotLookup[] {
        const found: SlotLookup[] = [];
        if (seen.has(key)) return found;
        seen.add(key);
        found.push(...(this.slotLookups.get(key) ?? []));
        for (const edge of this.slotAliasEdges.get(key) ?? []) found.push(...this.lookupsOf(edge, seen));
        return found;
    }

    /**
     * Turns the recovered lookups into the emitted table: one kind per slot, with the enforcement
     * the call sites agree on. A slot whose sites disagree on the kind is dropped rather than
     * guessed at, and so is the kind every component satisfies.
     *
     * @returns the slot table, keyed `declaringTypeFullName::serializedName`.
     */
    private buildSlotTable(): Map<string, SlotLookup> {
        const slots = new Map<string, SlotLookup>();
        for (const [key, member] of this.slotMembers) {
            const lookups = this.lookupsOf(key);
            if (lookups.length === 0) continue;
            const kinds = [...new Set(lookups.map((lookup) => lookup.kind))];
            if (kinds.length !== 1) continue;
            const kind = kinds[0];
            // The base of each side satisfies every slot on that side, so it separates nothing.
            if (kind === PART_COMPONENT || kind === BULLET_COMPONENT) continue;
            // A kind stated as a generic instantiation cannot be matched against a component's
            // ancestry, which names the open type.
            if (kind.includes('<')) continue;
            // One site that throws is enough to make a wrong component a failed part load.
            slots.set(`${member.declaring}::${member.serialized}`, {
                kind,
                throws: lookups.some((lookup) => lookup.throws),
            });
        }
        return slots;
    }

    /**
     * Walks one method body, recording every component lookup a slot's value reaches and every
     * member it is stored into.
     *
     * @param type the declaring type.
     * @param method the method to walk.
     * @param assembly the assembly its tokens resolve against.
     */
    private walkForSlots(type: TypeInfo, method: MethodInfo, assembly: DotNetAssembly): void {
        const body = method.body();
        const frame = method.frame();
        const incoming = new Map<number, SlotState>();
        const targets = new Set<number>(frame.handlerStarts);
        for (const instruction of body) for (const target of branchTargetsOf(instruction)) targets.add(target);

        // A constructor's id parameters are slots in their own right: a value read from a path is
        // handed to the constructor and stored on to the member the OT really names.
        if (method.isConstructor) {
            method.parameters.forEach((parameter, index) => {
                if (componentIdShape(parameter.type) === 0) return;
                const key = `${type.fullName}::#${index}`;
                if (!this.slotMembers.has(key))
                    this.slotMembers.set(key, { declaring: type.fullName, serialized: `${index}` });
            });
        }

        // Two sweeps, so a target reached only by a backward branch still sees its incoming state.
        for (let sweep = 0; sweep < 2; sweep++) {
            let state = new SlotState(frame.locals);
            for (const instruction of body) {
                const arriving = targets.has(instruction.offset) ? incoming.get(instruction.offset) : undefined;
                if (arriving) state = state.unreachable ? arriving.clone() : SlotState.merge(state, arriving);
                this.step(type, method, instruction, state, incoming, assembly);
            }
        }
    }

    /**
     * Hands the current state to an instruction's branch targets.
     *
     * @param instruction the branching instruction.
     * @param state the state at the branch.
     * @param incoming the per-target incoming states.
     */
    private static recordBranch(instruction: Instruction, state: SlotState, incoming: Map<number, SlotState>): void {
        for (const target of branchTargetsOf(instruction)) {
            const existing = incoming.get(target);
            incoming.set(target, existing ? SlotState.merge(existing, state.clone()) : state.clone());
        }
    }

    /**
     * Steps one instruction, moving tags through the modelled state.
     *
     * @param type the declaring type.
     * @param method the method being walked.
     * @param instruction the instruction.
     * @param state the state to advance.
     * @param incoming the per-target incoming states, written by a branch.
     * @param assembly the assembly the instruction's tokens resolve against.
     */
    private step(
        type: TypeInfo,
        method: MethodInfo,
        instruction: Instruction,
        state: SlotState,
        incoming: Map<number, SlotState>,
        assembly: DotNetAssembly
    ): void {
        const { opcode, operand } = instruction;
        if (opcode === OP.ldstr) {
            state.push({
                literal: typeof operand === 'string' ? operand : undefined,
                localAddress: -1,
                fromComponentLookup: false,
            });
            return;
        }
        if ((opcode >= OP.ldarg_0 && opcode <= OP.ldarg_3) || opcode === OP.ldarg_s || opcode === OP.ldarg) {
            const argument = argIndexOf(instruction);
            if (method.isConstructor && argument >= 0) {
                const position = argument - (method.isStatic ? 0 : 1);
                const parameter = method.parameters[position];
                if (position >= 0 && parameter && componentIdShape(parameter.type) !== 0) {
                    state.push(valueOf(`${type.fullName}::#${position}`));
                    return;
                }
            }
            state.push(NONE);
            return;
        }
        if (opcode === OP.ldfld || opcode === OP.ldflda || opcode === OP.ldsfld || opcode === OP.ldsflda) {
            if (opcode === OP.ldfld || opcode === OP.ldflda) state.pop();
            const key = this.slotFieldKey(typeof operand === 'number' ? assembly.fieldOfToken(operand) : undefined);
            state.push(key && this.slotMembers.has(key) ? valueOf(key) : NONE);
            return;
        }
        if (opcode === OP.stfld || opcode === OP.stsfld) {
            const value = state.pop();
            if (opcode === OP.stfld) state.pop();
            const key = this.slotFieldKey(typeof operand === 'number' ? assembly.fieldOfToken(operand) : undefined);
            if (value.tags && key && this.slotMembers.has(key)) {
                for (const tag of value.tags) this.recordAliasEdge(tag, key);
            }
            return;
        }
        if ((opcode >= OP.ldloc_0 && opcode <= OP.ldloc_3) || opcode === OP.ldloc_s || opcode === OP.ldloc) {
            state.push(state.getLocal(localIndexOf(instruction)));
            return;
        }
        if (opcode === OP.ldloca_s || opcode === OP.ldloca) {
            const index = localIndexOf(instruction);
            state.push({ tags: state.getLocal(index).tags, localAddress: index, fromComponentLookup: false });
            return;
        }
        if ((opcode >= OP.stloc_0 && opcode <= OP.stloc_3) || opcode === OP.stloc_s || opcode === OP.stloc) {
            state.setLocal(localIndexOf(instruction), state.pop());
            return;
        }
        if (opcode === OP.dup) {
            const value = state.pop();
            state.push(value);
            state.push(value);
            return;
        }
        if (opcode === OP.castclass || opcode === OP.unbox_any || opcode === OP.isinst) {
            const value = state.pop();
            // The cast on a component a bullet's dictionary handed back is where the kind the slot
            // is read as finally appears. `castclass` and `unbox.any` throw when the component is of
            // another kind, while `isinst` answers null and carries on. A cast to a type parameter
            // names no kind: the walk is reading one method body at a time and has no instantiation
            // to read it through.
            const cast = typeof operand === 'number' ? assembly.typeOfToken(operand) : undefined;
            if (
                value.fromComponentLookup &&
                value.tags &&
                cast &&
                cast.kind !== 'typeParam' &&
                !containsTypeParam(cast)
            ) {
                const throws = opcode !== OP.isinst;
                for (const tag of value.tags) this.recordLookup(tag, { kind: fullNameOf(cast), throws });
            }
            state.push(NONE);
            return;
        }
        if (opcode === OP.ldelem || opcode === OP.ldelem_ref || opcode === OP.ldelema) {
            state.pop();
            state.push(state.pop());
            return;
        }
        if (opcode === OP.call || opcode === OP.callvirt || opcode === OP.newobj) {
            this.stepCall(type, instruction, state, assembly);
            return;
        }
        if (opcode === OP.ret || opcode === OP.throw || opcode === OP.rethrow || opcode === OP.endfinally) {
            state.stack.length = 0;
            state.unreachable = true;
            return;
        }
        if (opcode === OP.br || opcode === OP.br_s || opcode === OP.leave || opcode === OP.leave_s) {
            ComponentSlotPass.recordBranch(instruction, state, incoming);
            state.stack.length = 0;
            state.unreachable = true;
            return;
        }
        if (opcode === OP.brtrue || opcode === OP.brtrue_s || opcode === OP.brfalse || opcode === OP.brfalse_s) {
            state.pop();
            ComponentSlotPass.recordBranch(instruction, state, incoming);
            return;
        }
        if (opcode === OP.switch) {
            state.pop();
            ComponentSlotPass.recordBranch(instruction, state, incoming);
            return;
        }
        if ((opcode >= OP.beq && opcode <= OP.blt_un) || (opcode >= OP.beq_s && opcode <= OP.blt_un_s)) {
            state.pop();
            state.pop();
            ComponentSlotPass.recordBranch(instruction, state, incoming);
            return;
        }
        const pops = POPS.get(opcode) ?? 0;
        const pushes = PUSHES.get(opcode) ?? 0;
        for (let index = 0; index < pops; index++) state.pop();
        for (let index = 0; index < pushes; index++) state.push(NONE);
    }

    /**
     * The slot key a field reference names, resolving an auto-property's backing field.
     *
     * @param field the field reference.
     * @returns the key, or undefined for an unreadable token.
     */
    private slotFieldKey(field: FieldRef | undefined): string | undefined {
        if (!field || !field.declaringType) return undefined;
        const key = `${field.declaringType}::${field.name}`;
        return this.slotBackingFields.get(key) ?? key;
    }

    /**
     * Steps a call, which is where everything happens: a getter starts a tag, a read from a path
     * creates a key, a component lookup records the kind, and a pass-through carries the tag on.
     *
     * @param type the declaring type of the method being walked.
     * @param instruction the call instruction.
     * @param state the state to advance.
     * @param assembly the assembly the call's token resolves against.
     */
    private stepCall(type: TypeInfo, instruction: Instruction, state: SlotState, assembly: DotNetAssembly): void {
        const { opcode, operand } = instruction;
        const called = typeof operand === 'number' ? assembly.callTargetOfToken(operand) : undefined;
        if (!called) {
            // An unreadable target still consumed and produced something. Nothing is known about
            // either, so the stack is left as it is rather than guessed at.
            return;
        }
        const isNewobj = opcode === OP.newobj;
        const hasThis = called.hasThis && !isNewobj;
        const offset = hasThis ? 1 : 0;
        const count = called.parameters.length + offset;
        const args: SlotValue[] = new Array<SlotValue>(count);
        for (let index = count - 1; index >= 0; index--) args[index] = state.pop();
        const self = hasThis && count > 0 ? args[0] : NONE;
        const name = called.name;
        const declaringType = called.declaringType ?? '';
        const returnsVoid = called.returnType.kind === 'primitive' && called.returnType.fullName === 'System.Void';
        const generic = called.genericArgs.length === 1 ? called.genericArgs[0] : undefined;
        const kind = generic && generic.kind !== 'typeParam' ? fullNameOf(generic) : undefined;

        // A getter over a slot member is a load of that member.
        const read = this.slotGetters.get(`${declaringType}::${name}`);
        if (read && !returnsVoid) {
            state.push(valueWith(new Set(read)));
            return;
        }

        // A key read from a path is a member the OT names that no C# member declares.
        const isRead = READ_NAMES.has(name);
        if (isRead && generic && componentIdShape(generic) !== 0) {
            const literal = args.find((argument) => argument.literal !== undefined)?.literal;
            if (literal !== undefined) {
                const key = `${type.fullName}::#${literal}`;
                if (!this.slotMembers.has(key))
                    this.slotMembers.set(key, { declaring: type.fullName, serialized: literal });
                // The read writes through an `out` local, which is how the value reaches its member.
                for (const argument of args)
                    if (argument.localAddress >= 0) state.setLocal(argument.localAddress, valueOf(key));
                if (!returnsVoid && componentIdShape(called.returnType) !== 0) {
                    state.push(valueOf(key));
                    return;
                }
            }
        }

        // A bullet resolves a slot through its own dictionary rather than through a typed lookup,
        // so the component comes back as the interface every bullet component implements and the
        // kind is whatever the caller casts it to. Both spellings are covered: the indexer, which
        // throws on a name the bullet does not hold, and the try-get, which writes through an `out`
        // local.
        if (name === 'get_Item' && isBulletComponentMap(called)) {
            const key = [...args].reverse().find((argument) => argument.tags !== undefined);
            state.push(key?.tags ? valueWith(key.tags, true) : NONE);
            return;
        }
        if (name === 'TryGetValue' && called.parameters.length === 2 && isBulletComponentMap(called)) {
            const key = args.find((argument) => argument.tags !== undefined);
            const target = args.find((argument) => argument.localAddress >= 0);
            if (key?.tags && target) state.setLocal(target.localAddress, valueWith(key.tags, true));
            state.push(NONE);
            return;
        }

        // A call that hands the value straight back, so the tag rides through it.
        const passthrough =
            (shortOf(declaringType).startsWith('Nullable`') &&
                (name === 'get_Value' || name === 'GetValueOrDefault')) ||
            PASSTHROUGH_NAMES.has(name);

        // A value added to a tagged collection is stored into whatever that collection is.
        if ((name === 'Add' || name === 'AddRange' || name === 'Insert') && self.tags) {
            for (const argument of args) {
                if (!argument.tags) continue;
                for (const tag of argument.tags) for (const target of self.tags) this.recordAliasEdge(tag, target);
            }
        }

        // The live ship's own container, and only it: the blueprint and wreck containers resolve the
        // same ids through their own lookups, where a component with no half of that kind is the
        // ordinary case rather than a mistake.
        const isLookup = isComponentLookup(name) && declaringType === LIVE_PART;
        if (!isRead) {
            for (let index = 0; index < called.parameters.length; index++) {
                if (componentIdShape(slotParamType(called, index)) !== 1) continue;
                const tags = index + offset < args.length ? args[index + offset].tags : undefined;
                if (!tags || !isLookup || kind === undefined) continue;
                for (const tag of tags) this.recordLookup(tag, { kind, throws: name === 'GetComponent' });
            }
        }

        if (isNewobj) {
            for (let index = 0; index < called.parameters.length; index++) {
                const value = args[index + offset];
                if (!value.tags) continue;
                const parameterKey = `${declaringType}::#${index}`;
                if (!this.slotMembers.has(parameterKey)) continue;
                for (const tag of value.tags) this.recordAliasEdge(tag, parameterKey);
            }
            state.push(NONE);
            return;
        }
        if (returnsVoid) return;
        let result = NONE;
        if (passthrough) {
            if (self.tags) result = valueWith(self.tags);
            else if (args.length > 0 && args[0].tags) result = valueWith(args[0].tags);
        }
        state.push(result);
    }

    /**
     * The base chain of a type by name, the mod's own types resolved directly and a game type
     * through the bundle's `extends`, which links each type to its nearest schema-bearing ancestor.
     *
     * @param fullName the type to start from, itself included.
     * @returns the FullNames up the chain.
     */
    private *baseChain(fullName: string): Generator<string> {
        const seen = new Set<string>();
        let current: string | undefined = fullName;
        while (current && !seen.has(current)) {
            seen.add(current);
            yield current;
            const mod = this.types.get(current);
            if (mod) {
                const base: TypeSig | undefined = mod.baseType;
                current = base && 'fullName' in base ? base.fullName : undefined;
            } else {
                current = this.game.extendsOf(current);
            }
        }
    }

    /**
     * Whether a type derives from a named class.
     *
     * @param fullName the type to test.
     * @param baseName the base class FullName.
     * @returns true when the base is in the type's chain.
     */
    private inheritsFrom(fullName: string, baseName: string): boolean {
        for (const name of this.baseChain(fullName)) if (name === baseName) return true;
        return false;
    }

    /**
     * Every class and interface in a mod type's ancestry, itself included. The mod's own types are
     * opened directly. A game class or interface the chain reaches is answered by the bundle's
     * `componentAncestry`, which carries the kinds that type satisfies through its own ancestry, so
     * the chain is complete on both sides.
     *
     * @param fullName the type to walk.
     * @returns the FullNames it satisfies, kinds a game type contributes included.
     */
    private ancestryOf(fullName: string): Set<string> {
        const names = new Set<string>();
        const queue = [fullName];
        while (queue.length > 0) {
            const current = queue.pop()!;
            if (names.has(current)) continue;
            names.add(current);
            const mod = this.types.get(current);
            if (!mod) {
                for (const index of this.game.ancestryOf(current) ?? []) {
                    const kind = this.game.kindNames[index];
                    if (kind !== undefined) names.add(kind);
                }
                continue;
            }
            for (const iface of mod.interfaces) if ('fullName' in iface) queue.push(iface.fullName);
            const base = mod.baseType;
            if (base && 'fullName' in base) queue.push(base.fullName);
        }
        if (names.has(BULLET_COMPONENT_BASE)) names.add(BULLET_COMPONENT);
        return names;
    }

    /**
     * The runtime component class a rules class builds, read from the single `newobj` in its
     * `CreateComponent` override. A class that does not override it inherits its base's answer,
     * which for a game base is the bundle's own capability entry.
     *
     * @param type the component rules class.
     * @returns the produced type's FullName, the game base whose entry stands in, or undefined when
     *          the class builds no physical component.
     */
    private producedComponent(type: TypeInfo): { produced?: string; gameBase?: string } | undefined {
        for (const name of this.baseChain(type.fullName)) {
            const current = this.types.get(name);
            if (!current) return this.game.capabilitiesOf(name) ? { gameBase: name } : undefined;
            const assembly = this.ownerOf.get(current.fullName);
            const factory = current.methods.find(
                (method) => method.name === 'CreateComponent' && method.body().length > 0
            );
            if (!factory || !assembly) continue;
            let made: string | undefined;
            for (const instruction of factory.body()) {
                if (instruction.opcode !== OP.newobj || typeof instruction.operand !== 'number') continue;
                const ctor = assembly.callTargetOfToken(instruction.operand);
                // The base implementation's only `newobj` is the exception it throws.
                if (!ctor?.declaringType || ctor.declaringType.endsWith('Exception')) continue;
                made = ctor.declaringType;
            }
            if (made !== undefined) return { produced: made };
        }
        return undefined;
    }

    /**
     * The runtime component a bullet component rules class puts into the bullet's dictionary. A
     * bullet component has no `CreateComponent` factory: it builds itself inside `AddComponents`
     * and registers under its own id, so the class is read off the one component that method makes.
     * A class making none registers nothing, and a class making several is left undecided rather
     * than guessed at.
     *
     * @param type the bullet component rules class.
     * @returns the registered type's FullName, or undefined when the class registers none or more
     *          than one.
     */
    private registeredBulletComponent(type: TypeInfo): string | undefined {
        for (const name of this.baseChain(type.fullName)) {
            const current = this.types.get(name);
            if (!current) return undefined;
            const assembly = this.ownerOf.get(current.fullName);
            const builder = current.methods.find(
                (method) => method.name === 'AddComponents' && method.body().length > 0
            );
            if (!builder || !assembly) continue;
            const made: string[] = [];
            for (const instruction of builder.body()) {
                if (instruction.opcode !== OP.newobj || typeof instruction.operand !== 'number') continue;
                const ctor = assembly.callTargetOfToken(instruction.operand);
                const built = ctor?.declaringType;
                if (!built || !this.ancestryOf(built).has(BULLET_COMPONENT)) continue;
                if (!made.includes(built)) made.push(built);
            }
            // An override that builds nothing still answers for the class: the base's own
            // implementation is the one that throws, not one that registers a component.
            return made.length === 1 ? made[0] : undefined;
        }
        return undefined;
    }

    /**
     * Records, for every component rules class the mod declares, which of the kinds the component it
     * builds satisfies. A class that builds none is left out, so the check abstains on it.
     *
     * @param kindNames every kind name, the game's followed by the mod's own.
     * @returns the capabilities by class FullName, as kind names.
     */
    private buildCapabilities(kindNames: readonly string[]): Map<string, readonly string[]> {
        const capabilities = new Map<string, readonly string[]>();
        if (kindNames.length === 0) return capabilities;
        for (const type of this.types.values()) {
            if (type.isInterface || type.isAbstract) continue;
            const isBullet = this.inheritsFrom(type.fullName, BULLET_COMPONENT_RULES);
            if (!isBullet && !this.inheritsFrom(type.fullName, PART_COMPONENT_RULES)) continue;
            if (isBullet) {
                // A bullet component class that registers nothing is answered with an empty list
                // rather than with no entry at all: it satisfies no kind, which is a fact worth
                // stating, while no entry means the walk could not tell and the check abstains.
                const produced = this.registeredBulletComponent(type);
                const ancestry = produced ? this.ancestryOf(produced) : new Set<string>();
                capabilities.set(
                    type.fullName,
                    kindNames.filter((kind) => ancestry.has(kind))
                );
                continue;
            }
            const produced = this.producedComponent(type);
            if (!produced) continue;
            if (produced.gameBase !== undefined) {
                const inherited = this.game.capabilitiesOf(produced.gameBase) ?? [];
                capabilities.set(
                    type.fullName,
                    inherited.map((index) => this.game.kindNames[index]).filter((kind) => kind !== undefined)
                );
                continue;
            }
            const ancestry = this.ancestryOf(produced.produced!);
            capabilities.set(
                type.fullName,
                kindNames.filter((kind) => ancestry.has(kind))
            );
        }
        return capabilities;
    }
}

/**
 * Recover the expected runtime kind of every component slot a mod declares, and which kinds each of
 * its component classes satisfies, from its assemblies alone.
 *
 * @param types every mod type by FullName.
 * @param ownerOf the assembly each mod type was read from.
 * @param game the game's side of the hierarchy, read from the shipped bundle.
 * @returns the analysis.
 */
export const analyzeComponentSlots = (
    types: ReadonlyMap<string, TypeInfo>,
    ownerOf: ReadonlyMap<string, DotNetAssembly>,
    game: GameHierarchy
): ComponentSlotAnalysis => new ComponentSlotPass(types, ownerOf, game).run();
