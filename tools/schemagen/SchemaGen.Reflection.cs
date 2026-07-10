using Mono.Cecil;

internal sealed partial class SchemaGen
{
    static CustomAttribute? Attr(ICustomAttributeProvider m, string full) =>
        m.CustomAttributes.FirstOrDefault(a => a.AttributeType.FullName == full);
    static object? Named(CustomAttribute a, string name) =>
        a.Properties.FirstOrDefault(p => p.Name == name).Argument.Value;
    static bool IsReflective(TypeDefinition t) => Attr(t, REFLECTIVE) != null;

    static bool HasSerializeMembers(TypeDefinition t) =>
        t.Fields.Any(f => !f.IsStatic && Attr(f, SERIALIZE) != null)
        || t.Properties.Any(p => Attr(p, SERIALIZE) != null);

    // A type participates in the .rules schema if it is an explicit reflective node or it contributes
    // [Serialize] members to one. Abstract bases (e.g. BaseQuadEffectRules) carry the real fields —
    // Sprite/Bucket/FadeInTime/… but are not themselves [ReflectiveSerialization]-tagged. Only the
    // concrete leaves are. The reachability prune from ROOT still drops any that aren't actually used.
    static bool Participates(TypeDefinition t) => IsReflective(t) || HasSerializeMembers(t);

    // The nearest ancestor that participates in the schema, skipping non-serializable intermediates,
    // so `extends` links a leaf to its real field-bearing base even when that base lacks the attribute.
    static TypeDefinition? NearestSchemaBase(TypeDefinition t)
    {
        var bd = t.BaseType?.Resolve();
        while (bd != null && bd.FullName != "System.Object" && !Participates(bd)) bd = bd.BaseType?.Resolve();
        return bd != null && bd.FullName != "System.Object" ? bd : null;
    }

    // The registry base for a type's `[SerialDerivedType]` dispatch. A registry base is marked with
    // [SerialBaseType] and may be a class or an interface. Some engine registries (particle updaters,
    // renderers) put [SerialBaseType] on an interface that an abstract base class implements, while the
    // concrete members extend that class so walking the class chain alone never reaches the registry.
    // At each level we therefore also probe the implemented interfaces (transitively) for [SerialBaseType].
    static TypeDefinition? InterfaceRegistry(TypeDefinition t)
    {
        foreach (var i in t.Interfaces)
        {
            var id = i.InterfaceType.Resolve();
            if (id == null) continue;
            if (Attr(id, BASETYPE) != null) return id;
            if (InterfaceRegistry(id) is { } deeper) return deeper;
        }
        return null;
    }

    static TypeDefinition? NearestRegistryBase(TypeDefinition t)
    {
        // The class chain wins over implemented interfaces: a member can extend a class registry
        // while also implementing an orthogonal registry interface (RepeatingEffectRules extends the
        // HitEffectRules registry but implements IResumableHitEffectRules, the save-resume registry),
        // and its `Type=` dispatches within the class registry. Interface probing remains the
        // fallback for the registries that exist only as interfaces (particle updaters/renderers).
        var cur = t;
        while (cur != null && cur.FullName != "System.Object")
        {
            if (Attr(cur, BASETYPE) != null) return cur;
            cur = cur.BaseType?.Resolve();
        }
        cur = t;
        while (cur != null && cur.FullName != "System.Object")
        {
            if (InterfaceRegistry(cur) is { } iface) return iface;
            cur = cur.BaseType?.Resolve();
        }
        return null;
    }
}
