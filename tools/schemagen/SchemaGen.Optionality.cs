using System.Text.Json.Nodes;
using Mono.Cecil;
using Mono.Cecil.Cil;

internal sealed partial class SchemaGen
{
    static Dictionary<string, JsonNode?> InlineDefaults(TypeDefinition t)
    {
        var res = new Dictionary<string, JsonNode?>();
        var ctor = t.Methods.Where(m => m.IsConstructor && !m.IsStatic && m.HasBody)
                            .OrderBy(m => m.Parameters.Count).FirstOrDefault();
        if (ctor == null) return res;
        Instruction? prev = null;
        foreach (var ins in ctor.Body.Instructions)
        {
            if (ins.OpCode == OpCodes.Stfld && ins.Operand is FieldReference fr && prev != null)
            {
                JsonNode? v = prev.OpCode.Code switch
                {
                    Code.Ldc_I4_0 => 0, Code.Ldc_I4_1 => 1, Code.Ldc_I4_2 => 2, Code.Ldc_I4_3 => 3,
                    Code.Ldc_I4_4 => 4, Code.Ldc_I4_5 => 5, Code.Ldc_I4_6 => 6, Code.Ldc_I4_7 => 7,
                    Code.Ldc_I4_8 => 8, Code.Ldc_I4_M1 => -1,
                    Code.Ldc_I4 or Code.Ldc_I4_S => Convert.ToInt32(prev.Operand),
                    Code.Ldc_R4 => float.IsFinite((float)prev.Operand) ? (float)prev.Operand : (JsonNode)((float)prev.Operand).ToString(),
                    Code.Ldc_R8 => double.IsFinite((double)prev.Operand) ? (double)prev.Operand : (JsonNode)((double)prev.Operand).ToString(),
                    Code.Ldstr => (string)prev.Operand,
                    _ => null
                };
                if (v != null && !res.ContainsKey(fr.Name)) res[fr.Name] = v;
            }
            prev = ins;
        }
        return res;
    }

    // The enum member name(s) a raw numeric default stands for. An exact member wins (170 → `Sides`);
    // a [Flags] value with no exact member decomposes into its set bits (`Top, Left`). Returns null
    // when the value has no name or the type is not a real C# enum (enum-like structs have no
    // constants), in which case the default stays numeric.
    static string? EnumDefaultName(TypeReference tr, long value)
    {
        if (tr is GenericInstanceType g && tr.Name == "Nullable`1") tr = g.GenericArguments[0];
        TypeDefinition? def = null;
        try { def = tr.Resolve(); } catch { }
        if (def is not { IsEnum: true }) return null;
        var members = def.Fields.Where(f => f.IsStatic && f.HasConstant)
            .Select(f => (f.Name, Value: Convert.ToInt64(f.Constant))).ToList();
        foreach (var m in members) if (m.Value == value) return m.Name;
        if (!def.CustomAttributes.Any(a => a.AttributeType.FullName == "System.FlagsAttribute")) return null;
        var parts = new List<string>();
        var rest = value;
        foreach (var m in members)
            if (m.Value != 0 && (rest & m.Value) == m.Value) { parts.Add(m.Name); rest &= ~m.Value; }
        return rest == 0 && parts.Count > 0 ? string.Join(", ", parts) : null;
    }

    // Member names the type's constructor assigns any value to (a constant, or `new …()` / another
    // object), with auto-property backing fields normalized to the property name. A field the class
    // initializes has a default, so the ObjectText deserializer tolerates its absence — i.e. it is
    // optional even without an explicit `[Serialize(Optional=true)]`. Mirrors InlineDefaults' choice of
    // the smallest-arity (typically parameterless) constructor, so a parameterized ctor's `this.x = x`
    // parameter copies are not mistaken for defaults.
    static HashSet<string> ConstructorInitializedMembers(TypeDefinition t)
    {
        var res = new HashSet<string>();
        var ctor = t.Methods.Where(m => m.IsConstructor && !m.IsStatic && m.HasBody)
                            .OrderBy(m => m.Parameters.Count).FirstOrDefault();
        if (ctor == null) return res;
        foreach (var ins in ctor.Body.Instructions)
        {
            if (ins.OpCode == OpCodes.Stfld && ins.Operand is FieldReference fr)
            {
                var n = fr.Name;
                // Auto-property backing field `<Foo>k__BackingField` → `Foo`.
                if (n.Length > 1 && n[0] == '<')
                {
                    var end = n.IndexOf('>');
                    if (end > 1) n = n.Substring(1, end - 1);
                }
                res.Add(n);
            }
        }
        return res;
    }

    // True when a member carries a C# nullable-reference annotation marking the member's own type as
    // nullable (`Foo?`). The compiler emits `[Nullable(b)]` where b (a lone byte, or the first entry of a
    // per-component byte[]) is 2 for nullable, 1 for non-null, 0 for oblivious — so only 2 means optional.
    static bool IsNullableReference(ICustomAttributeProvider cap)
    {
        var na = cap.CustomAttributes.FirstOrDefault(a => a.AttributeType.Name == "NullableAttribute");
        if (na == null || na.ConstructorArguments.Count == 0) return false;
        var v = na.ConstructorArguments[0].Value;
        if (v is byte single) return single == 2;
        if (v is CustomAttributeArgument[] arr && arr.Length > 0 && arr[0].Value is byte first) return first == 2;
        return false;
    }

    // True when deserializing a void (valueless) OT node into this declared type is legal at runtime.
    // The serializer treats a void source as null (`ObjectTextSerializer.SourceIsNull`) and
    // `BaseSerializer.Read` throws a DeserializeException for any non-nullable value type. A type
    // carrying `[DisableNullSerialization]` skips that check and handles the void itself, so it is
    // treated as tolerant. Unresolvable references stay tolerant to avoid false `nullable = false`.
    static bool VoidAssignable(TypeReference tr)
    {
        // An array is itself a reference type, and `Resolve()` on it would resolve the element type,
        // misreading a struct-element array (`EditorGroupRules[]`) as a non-nullable struct.
        if (tr.IsArray) return true;
        if (tr is GenericInstanceType git && git.ElementType.Name == "Nullable`1") return true;
        TypeDefinition? def;
        try { def = tr.Resolve(); } catch { def = null; }
        if (def == null) return !tr.IsValueType;
        if (!def.IsValueType) return true;
        return def.CustomAttributes.Any(a => a.AttributeType.FullName == "Halfling.Serialization.DisableNullSerializationAttribute");
    }

    // Fields a custom deserializer reads through the generic reader rather than as reflected `[Serialize]`
    // members. Many `Rules` classes have a `[GenericConstructor]`/`Read` method that pulls extra OT keys
    // with `reader.TryReadFromPath<T>("Name")` / `ReadFromPath<T>` / `ReadOptionalFromPath<T>`. Because the
    // generic argument is baked into the IL, we recover both the OT key (the literal path string) and its
    // value type (the generic argument) by scanning the type's method bodies. This replaces a large amount
    // of hand-curation: the same fields used to be supplied by the TypeScript schema overlay.
    static IEnumerable<(string name, TypeReference type)> CustomReadCalls(TypeDefinition t)
    {
        var readers = new HashSet<string> { "ReadFromPath", "TryReadFromPath", "ReadOptionalFromPath" };
        foreach (var m in t.Methods)
        {
            if (!m.HasBody) continue;
            foreach (var ins in m.Body.Instructions)
            {
                if (ins.OpCode != OpCodes.Call && ins.OpCode != OpCodes.Callvirt) continue;
                if (ins.Operand is not GenericInstanceMethod gim) continue;
                // `*FromPath<T>` is read from the generic reader (`reader.TryReadFromPath<T>("Name")`) or, for
                // a few classes, the serializer's node-first overload (`s.TryReadFromPath<T>(node, "Name", out)`).
                // The path is still the only string argument, so the nearest preceding `ldstr` finds it either way.
                if (!readers.Contains(gim.ElementMethod.Name) || gim.GenericArguments.Count == 0) continue;
                // The path is the call's first argument, so it is the nearest preceding `ldstr` (the other
                // arguments — the out value, flags, an optional numeric default — are never strings).
                string? path = null;
                for (var p = ins.Previous; p != null; p = p.Previous)
                    if (p.OpCode == OpCodes.Ldstr) { path = p.Operand as string; break; }
                if (!string.IsNullOrEmpty(path)) yield return (path!, gim.GenericArguments[0]);
            }
        }
    }
}
