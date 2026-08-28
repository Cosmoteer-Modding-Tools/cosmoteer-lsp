using Mono.Cecil;
using Mono.Cecil.Cil;

internal sealed partial class SchemaGen
{
    // ---- component-slot kinds ----
    // A slot is a `[Serialize]` member typed `ID<PartComponentRules>` (or a nullable, list, array or
    // tuple of those). Every one of them maps to the same schema value type, the registry base, so
    // the schema alone cannot say which kind of component belongs there. The game can: the value is
    // resolved at runtime through `Part.GetComponent<T>` or `Part.TryGetComponent<T>`, and `T` is the
    // kind. `GetComponent<T>` throws `"Component '{id}' in part '{id}' is not of type '{T}'."` when
    // the component is of another kind, so a mis-slotted component is a crash when the part is built.
    //
    // This pass recovers that `T` by a local abstract interpretation of every method body: one
    // operand stack and one local array, each value carrying the set of slots it came from. A field
    // or getter load of a slot member starts a tag, the tag rides through `Nullable.GetValueOrDefault`,
    // indexers and enumerators, merges at branch targets, and a call to one of the lookups with a
    // tagged argument records the pair. Nothing interprocedural is needed: in the game's code every
    // such path stays inside one method body.
    //
    // What is deliberately refused, because the game's own files contradict it:
    //  - the blueprint and wreck containers (`BlueprintPart`, `DestroyedPart`), where a slot pointing
    //    at a component with no blueprint half is the ordinary case and fails silently by design.
    //  - the rules-level shape, where a class looks its slot up in `ComponentsByID` and tests the
    //    rules object with `is IBlueprintComponentToggle`. That throw is real but conditional on
    //    blueprint rendering, and honouring it flags values the game itself ships.
    //  - the kind `PartComponent`, which every component satisfies, so it can never fire.
    // Everything the pass cannot place is left without an entry, which is what tells the language
    // server to say nothing rather than to guess.

    /// <summary>The runtime kind names, in emission order. A slot entry stores an index into this.</summary>
    readonly List<string> componentKindNames = new();

    /// <summary>Kind index by kind FullName, so the same kind is emitted once.</summary>
    readonly Dictionary<string, int> componentKindIndex = new(StringComparer.Ordinal);

    /// <summary>
    /// The recovered kind of each slot, keyed `declaringTypeFullName::serializedName`. `Throws` is
    /// true when every call site reads the slot through `GetComponent`, which fails the part load,
    /// and false when the only sites are `TryGetComponent`, which silently does nothing.
    /// </summary>
    readonly Dictionary<string, (int Kind, bool Throws)> componentSlotKinds = new(StringComparer.Ordinal);

    /// <summary>
    /// Which kinds each component rules class satisfies, keyed by its FullName, as indices into
    /// {@link componentKindNames}. A class that builds no physical component has no entry at all,
    /// which is what makes the check abstain on it rather than report.
    /// </summary>
    readonly Dictionary<string, List<int>> componentCapabilities = new(StringComparer.Ordinal);

    const string PART_COMPONENT_RULES = "Cosmoteer.Ships.Parts.PartComponentRules";
    const string LIVE_PART = "Cosmoteer.Ships.Parts.Part";
    const string PART_COMPONENT = "Cosmoteer.Ships.Parts.PartComponent";
    const string BULLET_COMPONENT_RULES = "Cosmoteer.Bullets.BulletComponentRules";
    const string BULLET_COMPONENT = "Cosmoteer.Bullets.IBulletComponent";

    /// <summary>
    /// Whether a call is made on the dictionary a bullet holds its own components in. Read from the
    /// key type rather than from the value, since the dictionary's members are declared in terms of
    /// its type parameters and the instantiated value type never appears on the call itself.
    /// </summary>
    /// <param name="declaring">The type the call is made on.</param>
    /// <returns>True for the bullet's component dictionary.</returns>
    static bool IsBulletComponentMap(TypeReference declaring) =>
        declaring is GenericInstanceType map
        && map.GenericArguments.Count >= 1
        && map.GenericArguments[0] is GenericInstanceType key
        && key.Name.StartsWith("ID`", StringComparison.Ordinal)
        && key.GenericArguments[0].FullName == BULLET_COMPONENT_RULES;

    /// <summary>A slot member: the class that declares it, and what the OT calls it.</summary>
    sealed record SlotMember(string Declaring, string Serialized);

    /// <summary>One recovered lookup of a slot: the runtime kind asked for, and whether it throws.</summary>
    sealed record SlotLookup(string Kind, bool Throws);

    /// <summary>Every slot member found, keyed `declaringTypeFullName::memberName`.</summary>
    readonly Dictionary<string, SlotMember> slotMembers = new(StringComparer.Ordinal);

    /// <summary>Getter method keys (`declaringType::get_Name`) to the slot members they read.</summary>
    readonly Dictionary<string, List<string>> slotGetters = new(StringComparer.Ordinal);

    /// <summary>Auto-property backing fields to the member key they belong to.</summary>
    readonly Dictionary<string, string> slotBackingFields = new(StringComparer.Ordinal);

    /// <summary>The lookups recorded per slot key, filled by the walk.</summary>
    readonly Dictionary<string, List<SlotLookup>> slotLookups = new(StringComparer.Ordinal);

    /// <summary>Where a slot's value is stored on to, so a key read from a path reaches its member.</summary>
    readonly Dictionary<string, List<string>> slotAliasEdges = new(StringComparer.Ordinal);

    /// <summary>
    /// Recovers the expected runtime kind of every component slot and which kinds each component
    /// class satisfies, both from the assemblies alone. Fills {@link componentSlotKinds},
    /// {@link componentKindNames} and {@link componentCapabilities}, which the field emission and the
    /// bundle writer read.
    /// </summary>
    void AnalyzeComponentSlots()
    {
        CollectSlotMembers();
        // Two rounds, because a key read from a path can be created by a method analysed after the
        // one that consumes it. The second round is a replay with the key table already complete, not
        // a fixpoint.
        for (var round = 0; round < 2; round++)
        {
            slotLookups.Clear();
            slotAliasEdges.Clear();
            foreach (var type in allTypes)
                foreach (var method in type.Methods)
                    if (method.HasBody) WalkForSlots(method);
        }
        BuildSlotTable();
        BuildComponentCapabilities();
    }

    /// <summary>
    /// Whether a type reference is an `ID<PartComponentRules>;` or an `ID<BulletComponentRules>`,
    /// directly or wrapped. A bullet owns its components the way a part does, and the slots on both
    /// sides are resolved through a typed lookup, so both are walked as the same shape.
    /// </summary>
    /// <param name="tr">The type to test.</param>
    /// <returns>1 for a single id, 2 for a collection or tuple carrying one, 0 for anything else.</returns>
    static int ComponentIdShape(TypeReference? tr)
    {
        switch (tr)
        {
            case null:
                return 0;
            case ByReferenceType byRef:
                return ComponentIdShape(byRef.ElementType);
            case ArrayType array:
                return ComponentIdShape(array.ElementType) != 0 ? 2 : 0;
            case GenericInstanceType generic:
                if (generic.Name.StartsWith("ID`", StringComparison.Ordinal)
                    && (generic.GenericArguments[0].FullName == PART_COMPONENT_RULES
                        || generic.GenericArguments[0].FullName == BULLET_COMPONENT_RULES)) return 1;
                if (generic.Name.StartsWith("Nullable`", StringComparison.Ordinal))
                    return ComponentIdShape(generic.GenericArguments[0]) == 1 ? 1 : 0;
                foreach (var argument in generic.GenericArguments)
                    if (ComponentIdShape(argument) != 0) return 2;
                return 0;
            default:
                return 0;
        }
    }

    /// <summary>The OT name a member is written under, which is its alias when it declares one.</summary>
    /// <param name="provider">The member's attribute provider.</param>
    /// <param name="fallback">The C# member name, used when no alias is declared.</param>
    /// <returns>The serialized name.</returns>
    string SerializedNameOf(ICustomAttributeProvider provider, string fallback)
    {
        var serialize = Attr(provider, SERIALIZE);
        if (serialize == null) return fallback;
        return Named(serialize, "Alias") is string alias && alias.Length > 0 ? alias : fallback;
    }

    /// <summary>Collects every field and property carrying a component id, with their getters.</summary>
    void CollectSlotMembers()
    {
        void AddGetter(string getterKey, string memberKey)
        {
            if (!slotGetters.TryGetValue(getterKey, out var keys)) slotGetters[getterKey] = keys = new List<string>();
            if (!keys.Contains(memberKey)) keys.Add(memberKey);
        }

        foreach (var type in allTypes)
        {
            foreach (var field in type.Fields)
            {
                if (ComponentIdShape(field.FieldType) == 0) continue;
                // A compiler-generated backing field is reached through its property instead.
                if (field.Name.StartsWith("<", StringComparison.Ordinal)) continue;
                slotMembers[type.FullName + "::" + field.Name] =
                    new SlotMember(type.FullName, SerializedNameOf(field, field.Name));
            }
            foreach (var property in type.Properties)
            {
                if (ComponentIdShape(property.PropertyType) == 0) continue;
                var key = type.FullName + "::" + property.Name;
                slotMembers[key] = new SlotMember(type.FullName, SerializedNameOf(property, property.Name));
                if (property.GetMethod != null) AddGetter(type.FullName + "::" + property.GetMethod.Name, key);
                slotBackingFields[type.FullName + "::<" + property.Name + ">k__BackingField"] = key;
            }
        }

        // A slot read through an interface reference dispatches to the interface's getter, so that
        // getter has to reach every implementing class's own member.
        foreach (var type in allTypes)
        {
            if (type.IsInterface) continue;
            foreach (var property in type.Properties)
            {
                if (ComponentIdShape(property.PropertyType) == 0 || property.GetMethod == null) continue;
                var key = type.FullName + "::" + property.Name;
                foreach (var iface in ImplementedInterfaces(type))
                {
                    TypeDefinition? definition = null;
                    try { definition = iface.Resolve(); } catch { }
                    var declared = definition?.Properties.FirstOrDefault(p => p.Name == property.Name && p.GetMethod != null);
                    if (declared != null) AddGetter(definition!.FullName + "::" + declared.GetMethod.Name, key);
                }
            }
        }
    }

    /// <summary>Every interface a type implements, its bases' included.</summary>
    /// <param name="type">The type to walk.</param>
    /// <returns>The interface references, each once.</returns>
    static IEnumerable<TypeReference> ImplementedInterfaces(TypeDefinition type)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var current = type;
        while (current != null)
        {
            foreach (var iface in current.Interfaces)
                if (seen.Add(iface.InterfaceType.FullName)) yield return iface.InterfaceType;
            TypeDefinition? next = null;
            try { next = current.BaseType?.Resolve(); } catch { }
            current = next;
        }
    }

    /// <summary>Records one recovered lookup against a slot key.</summary>
    /// <param name="key">The slot key the tag names.</param>
    /// <param name="lookup">The kind asked for and whether the call throws.</param>
    void RecordLookup(string key, SlotLookup lookup)
    {
        if (!slotLookups.TryGetValue(key, out var found)) slotLookups[key] = found = new List<SlotLookup>();
        found.Add(lookup);
    }

    /// <summary>Records that one slot's value is stored into another slot member.</summary>
    /// <param name="from">The slot the value came from.</param>
    /// <param name="to">The member it is stored into.</param>
    void RecordAliasEdge(string from, string to)
    {
        if (from == to) return;
        if (!slotAliasEdges.TryGetValue(from, out var edges)) slotAliasEdges[from] = edges = new List<string>();
        if (!edges.Contains(to)) edges.Add(to);
    }

    /// <summary>The lookups a slot reaches, following the members its value is stored into.</summary>
    /// <param name="key">The slot key.</param>
    /// <param name="seen">Keys already visited, which stops a cycle.</param>
    /// <returns>Every lookup recorded for the slot or for what it feeds.</returns>
    List<SlotLookup> LookupsOf(string key, HashSet<string>? seen = null)
    {
        seen ??= new HashSet<string>(StringComparer.Ordinal);
        var found = new List<SlotLookup>();
        if (!seen.Add(key)) return found;
        if (slotLookups.TryGetValue(key, out var direct)) found.AddRange(direct);
        if (slotAliasEdges.TryGetValue(key, out var next))
            foreach (var edge in next) found.AddRange(LookupsOf(edge, seen));
        return found;
    }

    /// <summary>
    /// Turns the recovered lookups into the emitted table: one kind per slot, with the enforcement
    /// the call sites agree on. A slot whose sites disagree on the kind is dropped rather than
    /// guessed at, and so is the kind every component satisfies.
    /// </summary>
    void BuildSlotTable()
    {
        var recovered = new List<(string Slot, string Kind, bool Throws)>();
        foreach (var (key, member) in slotMembers)
        {
            var lookups = LookupsOf(key);
            if (lookups.Count == 0) continue;
            var kinds = lookups.Select(l => l.Kind).Distinct().ToList();
            if (kinds.Count != 1) continue;
            var kind = kinds[0];
            // The base of each side satisfies every slot on that side, so it separates nothing.
            if (kind == PART_COMPONENT || kind == BULLET_COMPONENT) continue;
            // A kind stated as a generic instantiation cannot be matched against a component's
            // ancestry, which is read from the resolved definitions and so names the open type. The
            // only slots it covers are the network route endpoints, whose value is a dictionary key
            // rather than a component of a particular kind.
            if (kind.Contains('<')) continue;
            // One site that throws is enough to make a wrong component a failed part load.
            recovered.Add((member.Declaring + "::" + member.Serialized, kind, lookups.Any(l => l.Throws)));
        }
        // The indices are written into the shipped bundle, so they are assigned from the sorted kind
        // names rather than from the order the walk happened to meet them in.
        foreach (var kind in recovered.Select(r => r.Kind).Distinct().OrderBy(k => k, StringComparer.Ordinal))
        {
            componentKindIndex[kind] = componentKindNames.Count;
            componentKindNames.Add(kind);
        }
        foreach (var (slot, kind, throws) in recovered) componentSlotKinds[slot] = (componentKindIndex[kind], throws);
    }

    /// <summary>
    /// The runtime component class a rules class builds, read from the single `newobj` in its
    /// `CreateComponent` override. A class that does not override it inherits its base's answer.
    /// </summary>
    /// <param name="type">The component rules class.</param>
    /// <returns>The produced type, or null when the class builds no physical component.</returns>
    static TypeDefinition? ProducedComponent(TypeDefinition type)
    {
        var current = type;
        while (current != null)
        {
            var factory = current.Methods.FirstOrDefault(m => m.Name == "CreateComponent" && m.HasBody);
            if (factory != null)
            {
                TypeDefinition? made = null;
                foreach (var ins in factory.Body.Instructions)
                {
                    if (ins.OpCode.Code != Code.Newobj || ins.Operand is not MethodReference ctor) continue;
                    // The base implementation's only `newobj` is the exception it throws.
                    if (ctor.DeclaringType.FullName.EndsWith("Exception", StringComparison.Ordinal)) continue;
                    try { made = ctor.DeclaringType.Resolve(); } catch { made = null; }
                }
                if (made != null) return made;
            }
            TypeDefinition? next = null;
            try { next = current.BaseType?.Resolve(); } catch { }
            current = next;
        }
        return null;
    }

    /// <summary>Every class and interface in a type's ancestry, itself included.</summary>
    /// <param name="type">The type to walk.</param>
    /// <returns>The FullNames it satisfies.</returns>
    static HashSet<string> Ancestry(TypeDefinition type)
    {
        var names = new HashSet<string>(StringComparer.Ordinal);
        var queue = new Stack<TypeDefinition>();
        queue.Push(type);
        while (queue.Count > 0)
        {
            var current = queue.Pop();
            if (!names.Add(current.FullName)) continue;
            foreach (var iface in current.Interfaces)
            {
                TypeDefinition? definition = null;
                try { definition = iface.InterfaceType.Resolve(); } catch { }
                if (definition != null) queue.Push(definition);
            }
            TypeDefinition? next = null;
            try { next = current.BaseType?.Resolve(); } catch { }
            if (next != null) queue.Push(next);
        }
        return names;
    }

    /// <summary>
    /// Records, for every component rules class, which of the recovered kinds the component it
    /// builds satisfies. A class that builds none is left out, so the check abstains on it.
    /// </summary>
    void BuildComponentCapabilities()
    {
        if (componentKindNames.Count == 0) return;
        foreach (var type in allTypes)
        {
            if (type.IsInterface || type.IsAbstract) continue;
            var isBullet = InheritsFrom(type, BULLET_COMPONENT_RULES);
            if (!isBullet && !InheritsFrom(type, PART_COMPONENT_RULES)) continue;
            var produced = isBullet ? RegisteredBulletComponent(type) : ProducedComponent(type);
            // A bullet component class that registers nothing is answered with an empty list rather
            // than with no entry at all: it satisfies no kind, which is a fact worth stating, while
            // no entry means the walk could not tell and the check abstains.
            if (produced == null && !isBullet) continue;
            var ancestry = produced == null ? new HashSet<string>(StringComparer.Ordinal) : Ancestry(produced);
            var satisfied = new List<int>();
            for (var index = 0; index < componentKindNames.Count; index++)
                if (ancestry.Contains(componentKindNames[index])) satisfied.Add(index);
            componentCapabilities[type.FullName] = satisfied;
        }
    }

    /// <summary>
    /// The runtime component a bullet component rules class puts into the bullet's dictionary. A
    /// bullet component has no `CreateComponent` factory: it builds itself inside `AddComponents`
    /// and registers under its own id, so the class is read off the one component that method makes.
    /// A class making none registers nothing, and a class making several is left undecided rather
    /// than guessed at.
    /// </summary>
    /// <param name="type">The bullet component rules class.</param>
    /// <returns>The registered type, or null when the class registers none or more than one.</returns>
    static TypeDefinition? RegisteredBulletComponent(TypeDefinition type)
    {
        var current = type;
        while (current != null)
        {
            var builder = current.Methods.FirstOrDefault(m => m.Name == "AddComponents" && m.HasBody);
            if (builder != null)
            {
                var made = new List<TypeDefinition>();
                foreach (var ins in builder.Body.Instructions)
                {
                    if (ins.OpCode.Code != Code.Newobj || ins.Operand is not MethodReference ctor) continue;
                    TypeDefinition? built = null;
                    try { built = ctor.DeclaringType.Resolve(); } catch { built = null; }
                    if (built == null || !Ancestry(built).Contains(BULLET_COMPONENT)) continue;
                    if (!made.Any(m => m.FullName == built.FullName)) made.Add(built);
                }
                if (made.Count > 1) return null;
                if (made.Count == 1) return made[0];
                // An override that builds nothing still answers for the class: the base's own
                // implementation is the one that throws, not one that registers a component.
                return null;
            }
            TypeDefinition? next = null;
            try { next = current.BaseType?.Resolve(); } catch { }
            current = next;
        }
        return null;
    }

    /// <summary>Whether a type derives from a named class.</summary>
    /// <param name="type">The type to test.</param>
    /// <param name="baseName">The base class FullName.</param>
    /// <returns>True when the base is in the type's chain.</returns>
    static bool InheritsFrom(TypeDefinition type, string baseName)
    {
        TypeDefinition? current = type;
        while (current != null)
        {
            if (current.FullName == baseName) return true;
            try { current = current.BaseType?.Resolve(); } catch { return false; }
        }
        return false;
    }
}
