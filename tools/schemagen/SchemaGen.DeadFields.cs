using Mono.Cecil;
using Mono.Cecil.Cil;

internal sealed partial class SchemaGen
{
    // ---- dead-field detection ----
    // A [Serialize] member the game declares but whose value no game code ever reads is dead weight
    // in a mod: the deserializer stores it and nothing looks at it again. Those members are flagged
    // `dead: true` on their schema field so the language server can hint them, replacing a hand-kept
    // list that rotted silently on game updates. The verdict comes from one whole-assembly IL scan
    // over every scanned assembly (the same set the rest of the extraction walks: Cosmoteer.dll,
    // HalflingCore.dll, every --mod assembly). A member counts as read, deliberately over-broadly,
    // when any method body anywhere:
    //   - loads the field (Ldfld / Ldflda, the by-ref load covering `ref`/`out` passing) or takes
    //     its runtime handle (Ldtoken). Operands are resolved to the field definition so a load
    //     through a generic instantiation still matches; an unresolvable reference falls back to a
    //     name match so resolution failure can never produce a false dead flag.
    //   - calls a property's getter. The call is matched by resolved definition AND by bare
    //     `get_<Name>` spelling, the latter so a read through a base-class or interface reference
    //     (whose callvirt resolves to the base definition, not the override) still counts.
    //   - loads the field's compiler-generated property backing field (`<Name>k__BackingField`).
    //   - loads a string equal to the member's C# name, its serialized name, or any alias. The
    //     reflection guard: the buff/stat and other string-keyed paths read members by name, and a
    //     name mentioned anywhere in code is reason enough to assume a reflective read.
    // A member is flagged only when it survives every guard. Constructors are scanned like any other
    // method; they only Stfld (write), so they never mark their own member as read.

    // Resolved FullNames of every field some method body loads (Ldfld/Ldflda/Ldtoken).
    readonly HashSet<string> readFieldSignatures = new(StringComparer.Ordinal);
    // Bare names of field loads whose reference did not resolve, the conservative fallback.
    readonly HashSet<string> readFieldNames = new(StringComparer.Ordinal);
    // Resolved FullNames of every called property getter.
    readonly HashSet<string> calledGetterSignatures = new(StringComparer.Ordinal);
    // Bare `get_<Name>` spellings of every getter call, covering virtual/interface dispatch.
    readonly HashSet<string> calledGetterNames = new(StringComparer.Ordinal);
    // Every string literal loaded by any method body (Ldstr), the reflection/name-lookup guard.
    readonly HashSet<string> loadedStrings = new(StringComparer.Ordinal);

    void ScanMemberReads()
    {
        foreach (var t in allTypes)
        {
            foreach (var m in t.Methods)
            {
                if (!m.HasBody) continue;
                foreach (var ins in m.Body.Instructions)
                {
                    var code = ins.OpCode.Code;
                    if (code is Code.Ldfld or Code.Ldflda or Code.Ldtoken)
                    {
                        if (ins.Operand is not FieldReference fr) continue;
                        FieldDefinition? fd = null;
                        try { fd = fr.Resolve(); } catch { }
                        if (fd != null) readFieldSignatures.Add(fd.FullName);
                        else readFieldNames.Add(fr.Name);
                    }
                    else if (code is Code.Call or Code.Callvirt)
                    {
                        if (ins.Operand is not MethodReference mr || !mr.Name.StartsWith("get_", StringComparison.Ordinal)) continue;
                        calledGetterNames.Add(mr.Name);
                        MethodDefinition? md = null;
                        try { md = mr.Resolve(); } catch { }
                        if (md != null) calledGetterSignatures.Add(md.FullName);
                    }
                    else if (code == Code.Ldstr && ins.Operand is string s)
                    {
                        loadedStrings.Add(s);
                    }
                }
            }
        }
    }

    // Whether the scan found no read of the member anywhere: not by field load, getter call,
    // backing-field load, or name mention. Any uncertainty (an unresolvable reference, a matching
    // name elsewhere) answers false, so only a provably unread member is flagged.
    bool MemberIsUnread(IMemberDefinition mem, string serializedName, IEnumerable<string> aliases)
    {
        if (loadedStrings.Contains(mem.Name) || loadedStrings.Contains(serializedName)) return false;
        foreach (var alias in aliases)
            if (loadedStrings.Contains(alias)) return false;
        if (mem is FieldDefinition fd)
            return !readFieldSignatures.Contains(fd.FullName) && !readFieldNames.Contains(fd.Name);
        if (mem is PropertyDefinition pd)
        {
            // Only a compiler-generated auto-property can be judged through its getter and backing
            // field. A hand-written accessor consumes the value itself: a setter with side effects
            // (Widget's Percentile* recompute the rect on assignment) or a get-only property
            // aliasing a live object the deserializer populates in place (WidgetRules' widget
            // templates return static defaults). Both always count as read.
            var backing = pd.DeclaringType.Fields.FirstOrDefault(f => f.Name == "<" + pd.Name + ">k__BackingField");
            if (backing == null) return false;
            if (calledGetterNames.Contains("get_" + pd.Name)) return false;
            if (pd.GetMethod != null && calledGetterSignatures.Contains(pd.GetMethod.FullName)) return false;
            if (readFieldSignatures.Contains(backing.FullName) || readFieldNames.Contains(backing.Name)) return false;
            return true;
        }
        return false;
    }
}
