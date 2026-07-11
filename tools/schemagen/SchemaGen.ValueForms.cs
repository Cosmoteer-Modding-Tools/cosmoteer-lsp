using Mono.Cecil;
using Mono.Cecil.Cil;

internal sealed partial class SchemaGen
{
    // ---- value-form detection ----
    // The engine's structured mechanisms that let a group type read shapes beyond `{ … }`, each
    // extracted so the validator follows a game update through a schema regeneration:
    //   1. `scalarForm` (type): the [ObjectTextConstructor] constructor or the
    //      ReadContentFrom(ObjectTextSerializer, …) implementation (the
    //      IObjectTextContentDeserializable hook, explicit or named) branches on OTFieldNode, so a
    //      plain scalar value is read directly (`Time = 10`, `Default = White`).
    //   2. `valueForm` (type): a `[Serialize(Alias = "")]` member. The empty OT path resolves to the
    //      node itself (`OTNode.TryFindAtPath("")`), so the type reads every written shape its
    //      member type reads: ShipFile's AbsolutePath makes `File = x.ship.png` legal, a
    //      MultiHitEffectRules' `HitEffectRules[]` makes the list form legal, and a proxy's
    //      group-only ProxyRules keeps a scalar illegal. Emitted as the member's mapped value type;
    //      the validator derives the legal shapes from the kind, following group delegations.
    //   3. `scalarStringForm` (type or field): a name-lookup wrapper serializer whose Read body
    //      branches on OTFieldNode. Registered globally via [DefaultSerializer] + CanRead (emitted
    //      on the target type), or per field via `[Serialize(OverrideDeserializer = …)]` (emitted on
    //      that field, a Widget Anchor's `TopLeft`). The word is looked up by name, so only strings
    //      are legal.
    // Verified against the decompiled engine (2026-07): every scalar-capable engine type follows one
    // of these patterns, and the Vector2 family, Material and Sprite (which throw on a scalar) match
    // none.
    static bool BodyMentionsFieldNode(MethodDefinition? m) =>
        m?.HasBody == true && m.Body.Instructions.Any(i =>
            (i.Operand is TypeReference tr && tr.FullName == "Halfling.ObjectText.OTFieldNode")
            || (i.Operand is MemberReference mr && mr.DeclaringType?.FullName == "Halfling.ObjectText.OTFieldNode"));

    static TypeReference? EmptyAliasMemberType(TypeDefinition t)
    {
        foreach (var f in t.Fields)
            if (Attr(f, SERIALIZE) is { } fa && Named(fa, "Alias") as string == "") return f.FieldType;
        foreach (var p in t.Properties)
            if (Attr(p, SERIALIZE) is { } pa && Named(pa, "Alias") as string == "") return p.PropertyType;
        return null;
    }

    static bool HasScalarForm(TypeDefinition t) =>
        BodyMentionsFieldNode(t.Methods.FirstOrDefault(m => m.IsConstructor && Attr(m, OTCTOR) != null))
        || BodyMentionsFieldNode(t.Methods.FirstOrDefault(m =>
            m.Name.EndsWith("ReadContentFrom")
            && m.Parameters.Any(p => p.ParameterType.FullName == "Halfling.Serialization.ObjectText.ObjectTextSerializer")));

    // The member a scalar value lands in. The scalar branch of the OT constructor (or ReadContentFrom)
    // reads the whole node with a direct `s.Read<T>(node)` and stores it into one member
    // (`ID = s.Read<ID<PartComponentRules>>(node)` in ComponentTriggerReferenceRules, `Parent = …` in
    // EditorParentPart). In IL that is a Read call on the serializer followed by a stfld into the type
    // itself, possibly through a conversion. ReadFromPath calls belong to the list/tuple form and are
    // excluded by name. Types whose scalar branch parses instead of storing (Color's named colors)
    // yield null and keep the digit-field fallback.
    static string? ScalarFieldOf(TypeDefinition t)
    {
        var m = t.Methods.FirstOrDefault(m => m.IsConstructor && Attr(m, OTCTOR) != null)
            ?? t.Methods.FirstOrDefault(m =>
                m.Name.EndsWith("ReadContentFrom")
                && m.Parameters.Any(p => p.ParameterType.FullName == "Halfling.Serialization.ObjectText.ObjectTextSerializer"));
        if (m?.HasBody != true) return null;
        // The receiving member may be declared on the type itself or inherited (MultiSpawnedObjectSearch
        // stores into SpawnedObjectSearch's Tag).
        bool OwnOrBase(TypeReference? declaring)
        {
            for (TypeDefinition? cur = t; cur != null; cur = cur.BaseType?.Resolve())
                if (declaring?.FullName == cur.FullName) return true;
            return false;
        }
        var ins = m.Body.Instructions;
        for (int i = 0; i < ins.Count; i++)
        {
            // The serializer's whole-node Read<T> resolves on the BaseSerializer generic base.
            if (ins[i].OpCode.Code is not (Code.Call or Code.Callvirt)
                || ins[i].Operand is not MethodReference read
                || read.Name != "Read"
                || read.DeclaringType?.FullName.StartsWith("Halfling.Serialization.Base.BaseSerializer") != true) continue;
            for (int j = i + 1; j < ins.Count && j <= i + 3; j++)
            {
                if (ins[j].OpCode.Code == Code.Stfld && ins[j].Operand is FieldReference fr
                    && OwnOrBase(fr.DeclaringType)) return fr.Name;
                // A property-backed member stores through its setter.
                if (ins[j].OpCode.Code is Code.Call or Code.Callvirt && ins[j].Operand is MethodReference set
                    && set.Name.StartsWith("set_") && OwnOrBase(set.DeclaringType)) return set.Name["set_".Length..];
                // Only conversions and nullable wrapping may sit between the read and the store.
                if (ins[j].OpCode.Code is not (Code.Conv_R4 or Code.Conv_R8 or Code.Conv_I4 or Code.Newobj)) break;
            }
        }
        return null;
    }

    // Whether a wrapper serializer type reads a scalar (its Read(ObjectTextSerializer, …) branches
    // on OTFieldNode). Shared by both registration paths of mechanism 3.
    static bool WrapperReadsScalar(TypeDefinition? wrapper) =>
        wrapper != null && BodyMentionsFieldNode(wrapper.Methods.FirstOrDefault(m =>
            m.Name == "Read"
            && m.Parameters.FirstOrDefault()?.ParameterType.FullName
                == "Halfling.Serialization.ObjectText.ObjectTextSerializer"));

    // Globally registered wrappers: collect the CanRead targets of [DefaultSerializer] classes. Only
    // the simple `type == typeof(X)` shape (exactly one ldtoken) is taken. A wrapper with a complex
    // CanRead (the generic ID-dictionary serializer) yields no unambiguous target and is skipped.
    // A scalar-reading wrapper additionally seeds `scalarStringTargets` (mechanism 3 above). Every
    // wrapper, scalar or not, seeds `customSerializerTargets`, because a bespoke serializer reads
    // shapes the reflected member list does not capture, so the target is not purely reflective.
    void CollectScalarStringTargets()
    {
        foreach (var t in allTypes)
        {
            if (Attr(t, "Halfling.Serialization.DefaultSerializerAttribute") == null) continue;
            var canRead = t.Methods.FirstOrDefault(m => m.Name == "CanRead" && m.HasBody);
            if (canRead == null) continue;
            var targets = canRead.Body.Instructions
                .Where(i => i.OpCode == OpCodes.Ldtoken && i.Operand is TypeReference)
                .Select(i => ((TypeReference)i.Operand).FullName)
                .Distinct()
                .ToList();
            if (targets.Count != 1) continue;
            customSerializerTargets.Add(targets[0]);
            if (WrapperReadsScalar(t)) scalarStringTargets.Add(targets[0]);
        }
    }

    // Whether the type's own OT deserialization is anything other than plain reflective member reads.
    // Any of these means the emitted `[Serialize]` member list is not the complete set of keys the
    // engine reads for the type, so a written key absent from the member list cannot be trusted to mean
    // the game ignores it. The hooks are:
    //   1. a custom `[ObjectTextConstructor]` or `…ReadContentFrom(ObjectTextSerializer, …)` method
    //      that reads content by hand (the scalar forms, and any bespoke group parsing).
    //   2. a `[GenericConstructor]` read path, detected by a constructor taking a `GenericSerialReader`,
    //      own or inherited through a `base(reader, …)` chain. MusicTrackRules reads `MaxConsecutivePlays`
    //      through its reader rather than as a reflected member.
    //   3. an empty-alias `valueForm` member, where the node itself is read as that member's type.
    //   4. a globally registered custom wrapper serializer reading the type.
    //   5. a generic `*FromPath` read of extra OT keys. These are recovered as synthetic fields, but
    //      still signal a hand-written read path whose completeness cannot be fully vouched for.
    bool HasCustomDeserialization(TypeDefinition t) =>
        HasDeserializationHook(t)
        || EmptyAliasMemberType(t) != null
        || customSerializerTargets.Contains(t.FullName)
        || CustomReadCalls(t).Any();

    // Whether the engine deserializes the type through a hand-written hook: an [ObjectTextConstructor],
    // an IObjectTextContentDeserializable `ReadContentFrom`, or a [GenericConstructor] read path
    // (a constructor taking a GenericSerialReader, own or via a `base(reader)` chain).
    static bool HasDeserializationHook(TypeDefinition t) =>
        t.Methods.Any(m => m.IsConstructor && Attr(m, OTCTOR) != null)
        || t.Methods.Any(m => m.Name.EndsWith("ReadContentFrom")
            && m.Parameters.Any(p => p.ParameterType.FullName == "Halfling.Serialization.ObjectText.ObjectTextSerializer"))
        || t.Methods.Any(m => m.IsConstructor && m.Parameters.Any(p =>
            p.ParameterType.FullName == "Halfling.Serialization.Generic.GenericSerialReader"));

    // A type with no reflective surface at all (no [ReflectiveSerialization], no [Serialize] members)
    // that the engine still provably deserializes: it has a deserialization hook AND that hook reads
    // named OT keys the CustomReadCalls scan recovers. Such a type is modeled as a group of those
    // recovered keys (MediaEffectBucketsRules' bucket lists, DirectionalCrewSpeeds' four directions)
    // instead of landing opaque. Deliberately not folded into Participates: that predicate also feeds
    // the plain-class-name registry member discovery in BuildRegistries, and a runtime type must not
    // enter a `Type=` vocabulary just because some method of it reads a path. Memoized, the IL scan is
    // not free and MapType asks per field.
    static readonly Dictionary<string, bool> customReadParticipantMemo = new(StringComparer.Ordinal);
    static bool IsCustomReadParticipant(TypeDefinition t)
    {
        if (customReadParticipantMemo.TryGetValue(t.FullName, out var cached)) return cached;
        var participates = !Participates(t) && HasDeserializationHook(t) && CustomReadCalls(t).Any();
        return customReadParticipantMemo[t.FullName] = participates;
    }

    // Whether the type and its whole schema-inheritance chain read purely by reflection over their
    // `[Serialize]` members, so the emitted member set is the complete set of keys the engine reads.
    // This is the sound basis for the ignored-field validator: only under this guarantee does a written
    // key absent from the member list provably go unread by the game. Walking the same `NearestSchemaBase`
    // chain the `extends` links follow catches a custom read hook inherited from a base
    // (`LitParticleQuadRenderer` through `BaseQuadRenderer`). Replaces the former hand-kept namespace
    // allowlist in the validator, so it tracks a game update through schema regeneration.
    bool PurelyReflective(TypeDefinition t)
    {
        for (TypeDefinition? cur = t; cur != null; cur = NearestSchemaBase(cur))
            if (HasCustomDeserialization(cur)) return false;
        return true;
    }
}
