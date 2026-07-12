using System.Text.Json.Nodes;
using Mono.Cecil;

internal sealed partial class SchemaGen
{
    void RegisterEnum(TypeDefinition def, IEnumerable<string> members, bool enumLike)
    {
        if (enums.ContainsKey(def.FullName)) return;
        var arr = new JsonArray(); foreach (var m in members) arr.Add(m);
        if (enumAliases.TryGetValue(def.FullName, out var extra)) foreach (var m in extra) arr.Add(m);
        var o = new JsonObject { ["name"] = def.Name, ["members"] = arr };
        if (enumLike) o["enumLike"] = true;
        enums[def.FullName] = o;
    }

    // Whether the type's schema surface depends on generic parameters: any serialized member's type
    // (or the base class) contains one. Such a definition cannot map without an instantiation
    // context. A nested struct under a generic declarer formally INHERITS the declarer's parameters
    // in Cecil without using them, so the formal parameter list is deliberately not consulted, only
    // the members are (BaseValueMapTextureLayer<T>'s ColorPoint carries plain Color/Position).
    static bool UsesGenericParameters(TypeDefinition def)
    {
        if (def.IsEnum) return false;
        if (def.BaseType != null && def.BaseType.ContainsGenericParameter) return true;
        foreach (var f in def.Fields)
            if (Attr(f, SERIALIZE) != null && f.FieldType.ContainsGenericParameter) return true;
        foreach (var p in def.Properties)
            if (Attr(p, SERIALIZE) != null && p.PropertyType.ContainsGenericParameter) return true;
        return false;
    }

    JsonObject MapType(TypeReference tr)
    {
        var o = new JsonObject();
        if (tr is GenericParameter) { o["kind"] = "opaque"; o["reason"] = "typeParam"; o["type"] = tr.Name; return o; }
        if (tr.IsArray) { o["kind"] = "list"; o["element"] = MapType(((ArrayType)tr).ElementType); return o; }

        if (tr is GenericInstanceType git)
        {
            var n = tr.Name; var ga = git.GenericArguments;
            if (n.StartsWith("Nullable`")) return MapType(ga[0]);
            if (n.StartsWith("MPValue`")) return MapType(ga[0]);                 // unwrap multiplayer wrapper
            if (n.StartsWith("ID`"))
            {
                o["kind"] = "reference";
                var td = ga[0].Resolve();
                o["target"] = td?.FullName ?? ga[0].FullName; o["targetName"] = ga[0].Name;
                return o;
            }
            if (n.StartsWith("Range`")) { o["kind"] = "range"; o["element"] = MapType(ga[0]); return o; }
            if (n.StartsWith("Interpolated`")) { o["kind"] = "interpolated"; o["element"] = MapType(ga[0]); return o; }
            if (n.StartsWith("ValueTuple`"))
            { o["kind"] = "tuple"; o["elements"] = new JsonArray(ga.Select(a => (JsonNode)MapType(a)).ToArray()); return o; }
            if (n.StartsWith("List`") || n.StartsWith("IList`") || n.StartsWith("IReadOnlyList`")
                || n.StartsWith("IReadOnlyCollection`") || n.StartsWith("ICollection`") || n.StartsWith("IEnumerable`")
                || n.StartsWith("ImmutableArray`") || n.StartsWith("HashSet`") || n.StartsWith("SortedSet`"))
            { o["kind"] = "list"; o["element"] = MapType(ga[0]); return o; }
            if (n.StartsWith("Dictionary`") || n.StartsWith("IDictionary`") || n.StartsWith("IReadOnlyDictionary`")
                || n.StartsWith("SortedDictionary`"))
            { o["kind"] = "map"; o["key"] = MapType(ga[0]); o["value"] = MapType(ga[1]); return o; }

            // A type reference that merely CARRIES a declarer's generic arguments while the resolved
            // definition's own serialized members never use them: a generic base's nested types
            // (`BaseValueMapTextureLayer<T>`'s `ColorPoint` struct and `InterpolateMode` enum) reach
            // this branch as instances, but they are plain types, so they map like any other and the
            // texture-generator layers get concrete groups/enums instead of an opaque `generic`.
            TypeDefinition? gdef = null;
            try { gdef = git.Resolve(); } catch { }
            if (gdef != null && !UsesGenericParameters(gdef)) return MapType(gdef);
            o["kind"] = "generic"; o["type"] = tr.Name;
            o["args"] = new JsonArray(ga.Select(a => (JsonNode)MapType(a)).ToArray());
            return o;
        }

        switch (tr.FullName)
        {
            case "System.Boolean": o["kind"] = "bool"; return o;
            case "System.String": o["kind"] = "string"; return o;
            case "System.Byte": case "System.SByte":
            case "System.Int16": case "System.UInt16":
            case "System.Int32": case "System.UInt32":
            case "System.Int64": case "System.UInt64": o["kind"] = "int"; return o;
            case "System.Single": case "System.Double": case "System.Decimal": o["kind"] = "float"; return o;
        }

        var def = tr.Resolve();
        if (def != null)
        {
            if (def.IsEnum)
            {
                o["kind"] = "enum"; o["ref"] = def.FullName; o["name"] = def.Name;
                RegisterEnum(def, def.Fields.Where(f => f.IsLiteral && f.Name != "value__").Select(f => f.Name), false);
                return o;
            }
            if (Attr(def, BASETYPE) != null)   // registry base, incl. interfaces without [ReflectiveSerialization]
            { o["kind"] = "polymorphicGroup"; o["ref"] = def.FullName; o["name"] = def.Name; return o; }
            // A class-level [ReflectiveSerialization] or a type that merely carries [Serialize] members
            // (e.g. PartNetworkOverlayIcon) is deserialized field-by-field, so model it as a group whose
            // fields we can complete/validate. `Participates` already keeps these in the graph. This just
            // lets MapType point at them instead of falling through to opaque.
            if (IsReflective(def) || HasSerializeMembers(def))
            {
                // A slot typed as one of these abstract sprite/material interfaces is always deserialized
                // as the single concrete impl, which carries more fields (Sprite extends Material; the
                // animated sprite has the FrameCount/FrameSize/… set). Point the field at the concrete so
                // completion/hover/validation see the full shape (and the prune keeps the concrete type).
                var (rf, rn) = ConcreteImpl.TryGetValue(def.FullName, out var c) ? c : (def.FullName, def.Name);
                o["kind"] = "group"; o["ref"] = rf; o["name"] = rn; return o;
            }
            // A type with no [Serialize] surface whose deserialization hook still reads named OT keys
            // (a [GenericConstructor] like MediaEffectBucketsRules, an [ObjectTextConstructor] like
            // DirectionalCrewSpeeds) is a group of those recovered keys, and BuildTypes emits it with
            // that field set. Its scalar branch, when it has one, surfaces as the type's `scalarForm`
            // through the normal detection. Two curated exclusions stay ahead of this branch:
            // Modifiable* keeps its scalar-first dual form (`number` + `groupForm`, below) so numeric
            // completion, validation and the computed-value inlays keep working on the dominant
            // bare-scalar spelling, and the inline-expansion types (FlexRange/FlexValue) must stay
            // opaque here because their keys are written flat on the OWNING group (`FromValue = 0`
            // directly in a particle updater, never a subgroup), which OwnFields expands in place.
            if (IsCustomReadParticipant(def) && !def.Name.StartsWith("Modifiable")
                && !inlineFieldExpansions.ContainsKey(def.Name))
            {
                o["kind"] = "group"; o["ref"] = def.FullName; o["name"] = def.Name; return o;
            }
            // enum-like: struct/class exposing >=2 public static fields of its own type (Direction, etc.)
            // but not numeric value types that merely expose a few named constants (e.g. Angle: Zero/
            // Ninety/…) those accept arbitrary numbers (incl. Infinity). Exclude anything with a
            // numeric conversion operator, so they fall through to `number`.
            var numericNames = new HashSet<string> { "Single", "Double", "Decimal", "Int32", "Int64", "Int16", "Byte", "UInt32" };
            var hasNumericConversion = def.Methods.Any(m => m.IsStatic
                && (m.Name == "op_Implicit" || m.Name == "op_Explicit") && numericNames.Contains(m.ReturnType.Name));
            var consts = def.Fields.Where(f => f.IsStatic && f.IsPublic && f.FieldType.FullName == def.FullName)
                                   .Select(f => f.Name).ToList();
            if (consts.Count >= 2 && !hasNumericConversion && def.Name != "Angle")
            {
                o["kind"] = "enum"; o["ref"] = def.FullName; o["name"] = def.Name; o["enumLike"] = true;
                RegisterEnum(def, consts, true);
                return o;
            }
            // [ObjectTextConstructor]: deserialized via a constructor it's data parameters are the schema.
            // Skip ctors that take serializer plumbing (those are deserialize methods, e.g. ModifiableFloat).
            var plumbing = new HashSet<string> { "ObjectTextSerializer", "IOTNode", "OTNode", "ProgressTracker",
                "IObjectTextDeserializer", "IObjectTextContentDeserializer", "ITrackingContext", "MemberInfo" };
            var otc = def.Methods.FirstOrDefault(m => m.IsConstructor && Attr(m, OTCTOR) != null
                && !m.Parameters.Any(p => plumbing.Contains(p.ParameterType.Name)));
            if (otc != null)
            {
                o["kind"] = "constructed"; o["type"] = def.Name;
                o["params"] = new JsonArray(otc.Parameters
                    .Select(p => (JsonNode)new JsonObject { ["name"] = p.Name, ["valueType"] = MapType(p.ParameterType) }).ToArray());
                return o;
            }
        }

        var nm = tr.Name;
        switch (nm)
        {
            case "Angle": o["kind"] = "number"; o["unit"] = "degrees"; o["type"] = nm; return o;
            // Halfling.Geometry.Direction deserializes from a single angle scalar: float.TryParse, else
            // ExpressionEvaluator.Evaluate<float> (handles `90d`, expressions, references). Its static
            // Up/Down/... fields are C# API only, never OT-parseable names, so it is purely numeric.
            case "Direction": o["kind"] = "number"; o["unit"] = "degrees"; o["type"] = nm; return o;
            case "KeyString": o["kind"] = "string"; o["semantic"] = "localizationKey"; return o;
            case "AbsolutePath": case "RelativePath": case "FilePath":
                o["kind"] = "string"; o["semantic"] = "path"; return o;
            // engine asset references (custom deserializers in HalflingCore) — feed the asset feature
            case "Texture": o["kind"] = "asset"; o["assetKind"] = "image"; return o;
            case "Sound": o["kind"] = "asset"; o["assetKind"] = "sound"; return o;
            case "Shader": o["kind"] = "asset"; o["assetKind"] = "shader"; return o;
            // Fonts and cursors are group-only values: their deserializers (FontFactory,
            // CursorManager) throw on a scalar, so they map to curated groups (see
            // SchemaGen.Curation.cs), whose `File` members carry the asset kind instead.
            case "Font": return GroupOf(FONT_CLASS, "Font");
            case "Cursor": return GroupOf(CURSOR_CLASS, "Cursor");
            case "CompiledCode": o["kind"] = "code"; o["lang"] = "python"; return o;
            // An external/internal virtual cell pair, modeled as a curated group (see SchemaGen.Curation.cs).
            case "VirtualInternalCell":
                return GroupOf("Cosmoteer.Ships.Parts.VirtualInternalCell", "VirtualInternalCell");
            // A sysgen part conversion pair `{ From = <part id>  To = <part id> }`, a record struct with no
            // serialization attributes or deserialization hook (curated, see SchemaGen.Curation.cs).
            case "PartConversion":
                return GroupOf(PART_CONVERSION, nm);
            // A hotkey / input button is written as a list of key names (`[Control, N]`), each a ViKey.
            case "IInputButton":
                o["kind"] = "list";
                o["element"] = new JsonObject { ["kind"] = "enum", ["ref"] = "Halfling.Input.ViKey", ["name"] = "ViKey" };
                return o;
        }
        // A Modifiable<T> (ModifiableFloat/Int/Time/Angle) has two valid written forms: a bare scalar
        // (`Damage = 5`), or a group carrying the unmodified `BaseValue` plus inline buff/status/effect
        // modifiers and Min/Max clamps (`Damage { BaseValue = 5  BuffType = …  BuffMode = Multiply }`).
        // We keep the primary kind `number` (so scalar completion/inlay/numeric validation work) and point
        // `groupForm` at a curated group type so completion/hover/validation also work inside the `{ }`.
        if (nm.StartsWith("Modifiable")) { o["kind"] = "number"; o["type"] = nm; o["groupForm"] = MODIFIABLE_VALUE; return o; }

        o["kind"] = "opaque"; o["type"] = nm;   // custom hand-written deserializer, accept-any, no field validation
        return o;
    }
}
