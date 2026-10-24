using System.Text.Json.Nodes;
using Mono.Cecil;

internal sealed partial class SchemaGen
{
    // ---- rules scripts ----
    // Since 0.30.5 the game compiles the script fields of music and codex rules with its own small
    // expression language (Cosmoteer.Scripting.ScriptCompiler) instead of Python. A script sees only the
    // members of its context type marked [ScriptVariable], and the public instance properties and
    // methods declared directly on types marked [ScriptAccessible]. This pass records that surface, so
    // the language server binds names and types exactly as the compiler does.
    const string SCRIPT_FUNC       = "Cosmoteer.Scripting.ScriptFunc`2";
    const string SCRIPT_ACTION     = "Cosmoteer.Scripting.ScriptAction`1";
    const string SCRIPT_VARIABLE   = "Cosmoteer.Scripting.ScriptVariableAttribute";
    const string SCRIPT_ACCESSIBLE = "Cosmoteer.Scripting.ScriptAccessibleAttribute";

    // The context types a script field was mapped against, filled by MapType.
    readonly HashSet<TypeDefinition> scriptContexts = new();

    // How a script surface names a type: the FullName, with a `?` suffix for a Nullable<T>.
    static string ScriptTypeKey(TypeReference tr)
    {
        if (tr is ByReferenceType br) return ScriptTypeKey(br.ElementType) + "&";
        if (tr is GenericInstanceType git && git.ElementType.FullName == "System.Nullable`1")
            return ScriptTypeKey(git.GenericArguments[0]) + "?";
        return tr.FullName;
    }

    // The doc summary of a member, by its XML doc-ID. Methods are matched on name and parameter
    // count, since Cecil and the XML file spell generic parameter lists differently.
    string? ScriptDoc(MemberReference m)
    {
        var owner = m.DeclaringType.FullName.Replace('/', '.');
        switch (m)
        {
            case PropertyDefinition: return xmlDocs.GetValueOrDefault($"P:{owner}.{m.Name}");
            case FieldDefinition: return xmlDocs.GetValueOrDefault($"F:{owner}.{m.Name}");
            case MethodDefinition md:
                if (md.Parameters.Count == 0) return xmlDocs.GetValueOrDefault($"M:{owner}.{m.Name}");
                var prefix = $"M:{owner}.{m.Name}(";
                return xmlDocs.FirstOrDefault(kv => kv.Key.StartsWith(prefix, StringComparison.Ordinal)
                    && kv.Key.Count(c => c == ',') == md.Parameters.Count - 1).Value;
        }
        return null;
    }

    JsonObject ScriptMethod(MethodDefinition m, HashSet<TypeReference> seen)
    {
        var o = new JsonObject
        {
            ["name"] = m.Name,
            ["returns"] = ScriptTypeKey(m.ReturnType),
            ["params"] = new JsonArray(m.Parameters.Select(p =>
            {
                seen.Add(p.ParameterType);
                var po = new JsonObject { ["name"] = p.Name, ["type"] = ScriptTypeKey(p.ParameterType) };
                if (p.HasDefault) po["optional"] = true;
                return (JsonNode)po;
            }).ToArray()),
        };
        seen.Add(m.ReturnType);
        if (ScriptDoc(m) is { } doc) o["doc"] = doc;
        return o;
    }

    JsonObject ScriptValue(MemberReference m, TypeReference type, HashSet<TypeReference> seen)
    {
        seen.Add(type);
        var o = new JsonObject { ["name"] = m.Name, ["type"] = ScriptTypeKey(type) };
        if (ScriptDoc(m) is { } doc) o["doc"] = doc;
        return o;
    }

    // What the language server needs of a type a script can meet: its message name, whether it is a
    // value type (which decides `is None`), whether its members are visible, and every type it is
    // assignable to (for argument conversion and `==` between related types).
    static JsonObject ScriptTypeInfo(TypeReference tr)
    {
        var o = new JsonObject();
        var nullable = tr is GenericInstanceType git && git.ElementType.FullName == "System.Nullable`1";
        var inner = nullable ? ((GenericInstanceType)tr).GenericArguments[0] : tr;
        o["name"] = inner.Name + (nullable ? "?" : "");
        TypeDefinition? def = null;
        try { def = inner.Resolve(); } catch { }
        o["valueType"] = !nullable && (def?.IsValueType ?? inner.IsValueType);
        if (def != null && !nullable && Attr(def, SCRIPT_ACCESSIBLE) != null) o["accessible"] = true;
        if (def != null && !nullable)
        {
            var bases = new List<string>();
            void Interfaces(TypeDefinition t)
            {
                foreach (var i in t.Interfaces)
                {
                    bases.Add(i.InterfaceType.FullName);
                    try { if (i.InterfaceType.Resolve() is { } id) Interfaces(id); } catch { }
                }
            }
            for (var cur = def; cur != null;)
            {
                Interfaces(cur);
                if (cur.BaseType == null) break;
                bases.Add(cur.BaseType.FullName);
                try { cur = cur.BaseType.Resolve(); } catch { cur = null; }
            }
            if (bases.Count > 0) o["bases"] = new JsonArray(bases.Distinct().Select(b => (JsonNode)b).ToArray());
        }
        // The ordering operators a type declares, which `<` and its kin need for anything but numbers.
        // A nullable value is lifted to the operators of what it wraps.
        TypeDefinition? opDef = null;
        try { opDef = inner.Resolve(); } catch { }
        var ordering = new (string Op, string Method)[] { ("<", "op_LessThan"), ("<=", "op_LessThanOrEqual"), (">", "op_GreaterThan"), (">=", "op_GreaterThanOrEqual") };
        var declared = ordering.Where(p => opDef?.Methods.Any(m => m.IsStatic && m.Name == p.Method) == true).Select(p => (JsonNode)p.Op).ToArray();
        if (declared.Length > 0) o["ordering"] = new JsonArray(declared);
        return o;
    }

    // The `scripting` section: every context's variables, every accessible type's members, and the
    // facts of every type either of them names.
    JsonObject BuildScripting()
    {
        var seen = new HashSet<TypeReference>();
        var contexts = new JsonObject();
        foreach (var ctx in scriptContexts.Where(c => c != null).OrderBy(c => c.FullName, StringComparer.Ordinal))
        {
            var vars = new JsonArray();
            IEnumerable<IMemberDefinition> members = ctx.Properties.Cast<IMemberDefinition>()
                .Concat(ctx.Fields).Concat(ctx.Methods);
            foreach (var m in members)
                foreach (var a in m.CustomAttributes.Where(a => a.AttributeType.FullName == SCRIPT_VARIABLE))
                {
                    var name = (string)a.ConstructorArguments[0].Value;
                    JsonObject v = m switch
                    {
                        MethodDefinition md => ScriptMethod(md, seen),
                        PropertyDefinition pd => ScriptValue(pd, pd.PropertyType, seen),
                        FieldDefinition fd => ScriptValue(fd, fd.FieldType, seen),
                        _ => new JsonObject(),
                    };
                    v["kind"] = m is MethodDefinition ? "function" : "variable";
                    v["name"] = name;
                    vars.Add(v);
                }
            contexts[ScriptTypeKey(ctx)] = new JsonObject { ["variables"] = vars };
            seen.Add(ctx);
        }

        // Accessible types reach further accessible types through their own members, so the walk
        // runs until it stops finding new ones.
        var accessible = new JsonObject();
        var queue = new Queue<TypeReference>(seen);
        var visited = new HashSet<string>(StringComparer.Ordinal);
        while (queue.Count > 0)
        {
            var tr = queue.Dequeue();
            TypeDefinition? def = null;
            try { def = tr.Resolve(); } catch { }
            if (def == null || Attr(def, SCRIPT_ACCESSIBLE) == null || !visited.Add(def.FullName)) continue;
            var found = new HashSet<TypeReference>();
            var props = new JsonArray(def.Properties
                .Where(p => p.GetMethod is { IsPublic: true, IsStatic: false } && !p.HasParameters)
                .OrderBy(p => p.Name, StringComparer.Ordinal)
                .Select(p => (JsonNode)ScriptValue(p, p.PropertyType, found)).ToArray());
            var methods = new JsonArray(def.Methods
                .Where(m => m.IsPublic && !m.IsStatic && !m.IsSpecialName && !m.IsConstructor && !m.HasGenericParameters)
                .OrderBy(m => m.Name, StringComparer.Ordinal)
                .Select(m => (JsonNode)ScriptMethod(m, found)).ToArray());
            var entry = new JsonObject { ["properties"] = props, ["methods"] = methods };
            if (xmlDocs.TryGetValue("T:" + def.FullName.Replace('/', '.'), out var doc)) entry["doc"] = doc;
            accessible[def.FullName] = entry;
            foreach (var f in found) { seen.Add(f); queue.Enqueue(f); }
        }

        var typeInfo = new JsonObject();
        foreach (var tr in seen.GroupBy(ScriptTypeKey).OrderBy(g => g.Key, StringComparer.Ordinal))
            typeInfo[tr.Key] = ScriptTypeInfo(tr.First());
        return new JsonObject { ["contexts"] = contexts, ["types"] = accessible, ["typeInfo"] = typeInfo };
    }
}
