using System.Text.Json.Nodes;
using Mono.Cecil;

internal sealed partial class SchemaGen
{
    JsonArray OwnFields(TypeDefinition t)
    {
        var arr = new JsonArray();
        var inl = InlineDefaults(t);
        var ctorInitialized = ConstructorInitializedMembers(t);
        var members = t.Fields.Where(f => !f.IsStatic)
            .Select(f => ((IMemberDefinition)f, (ICustomAttributeProvider)f, f.FieldType))
            .Concat(t.Properties.Select(p => ((IMemberDefinition)p, (ICustomAttributeProvider)p, p.PropertyType)));
        foreach (var (mem, cap, type) in members)
        {
            var sa = Attr(cap, SERIALIZE);
            if (sa == null) continue;
            var alias = Named(sa, "Alias") as string;
            var name = string.IsNullOrEmpty(alias) ? mem.Name : alias!;
            var aliasNames = new List<string>();
            if (Named(sa, "AlternateAliases") is CustomAttributeArgument[] alts && alts.Length > 0)
                aliasNames.AddRange(alts.Select(a => a.Value?.ToString() ?? ""));
            // A curated OT name for a field the engine serializes under a different spelling than its C#
            // member (e.g. colour `R` → `Rf`). Keep the original name reachable as an alias.
            if (fieldNameOverrides.TryGetValue(t.FullName, out var overrides) && overrides.TryGetValue(name, out var otName))
            {
                aliasNames.Add(name);
                name = otName;
            }
            var vt = MapType(type);
            // An inline-flattened engine value type contributes its fields to this group instead of a
            // single opaque field (the OT has no sub-group for it).
            if (vt["kind"]?.GetValue<string>() == "opaque" && vt["type"]?.GetValue<string>() is string ot
                && inlineFieldExpansions.TryGetValue(ot, out var expand))
            {
                foreach (var inlineField in expand()) arr.Add(inlineField);
                continue;
            }
            var fo = new JsonObject { ["name"] = name, ["valueType"] = vt };
            // A field is optional (its absence from the OT is legal) when any of these hold. Only the
            // explicit `Optional=true` attribute was previously honored, which marked ~2300 fields required
            // and produced false positives across vanilla; the other signals recover the fields that are
            // optional in practice but carry no `Optional=true`:
            //   - the class constructor-initializes it (it has a default value);
            //   - an explicit empty `Alias` — the member is serialized inline/unnamed (its content merges
            //     into the parent, e.g. a proxy's embedded `ProxyRules` or a sprite's `AtlasSprite`), so it
            //     is never written as a named field and can never be "missing";
            //   - the C# type is nullable: a `[Nullable]`-annotated reference (byte 2) or a `Nullable<T>`
            //     value type, where null/absent is a legal value;
            //   - a collection (array / list / map): an absent collection is simply empty.
            var vtKind = vt["kind"]?.GetValue<string>();
            fo["optional"] =
                (Named(sa, "Optional") is bool opt && opt)
                || ctorInitialized.Contains(mem.Name)
                || (Named(sa, "Alias") is string ax && ax.Length == 0)
                || IsNullableReference(cap)
                || type.Name == "Nullable`1"
                || vtKind == "list"
                || vtKind == "map";
            // A bare valueless field (`ScaleIn` with no `=`) deserializes as null, so mark the fields
            // where that is a game load error and the language server can flag them.
            if (!VoidAssignable(type)) fo["nullable"] = false;
            // A per-field deserializer override whose Read body branches on OTFieldNode grants only
            // this field a scalar string form: the written word is looked up by name (a Widget
            // Anchor's `TopLeft` preset), so a number still throws in game.
            if (Named(sa, "OverrideDeserializer") is TypeReference overrideDeserializer)
            {
                TypeDefinition? wrapperDef = null;
                try { wrapperDef = overrideDeserializer.Resolve(); } catch { }
                if (WrapperReadsScalar(wrapperDef)) fo["scalarStringForm"] = true;
            }
            if (aliasNames.Count > 0)
                fo["aliases"] = new JsonArray(aliasNames.Select(a => (JsonNode)JsonValue.Create(a)).ToArray());
            // `DefaultValue` is an object-typed attribute property, so Cecil boxes the constant in a
            // CustomAttributeArgument; unwrap it before emitting or ToString() prints the wrapper's
            // class name instead of the value.
            var dv = Named(sa, "DefaultValue");
            while (dv is CustomAttributeArgument boxed) dv = boxed.Value;
            if (dv != null) fo["default"] = dv switch
            {
                bool b => b,
                byte or sbyte or short or ushort or int or uint or long =>
                    vtKind == "bool" ? Convert.ToInt64(dv) != 0 : JsonValue.Create(Convert.ToInt64(dv)),
                float f => float.IsFinite(f) ? f : (JsonNode)f.ToString(),
                double d => double.IsFinite(d) ? d : (JsonNode)d.ToString(),
                _ => dv.ToString(),
            };
            else if (inl.TryGetValue(mem.Name, out var idv) && idv != null)
            {
                if (vtKind == "bool" && idv is JsonValue jv && jv.TryGetValue<int>(out var bi))
                    fo["default"] = bi != 0;
                else fo["default"] = idv;
            }
            // A numeric enum default is the C# constant's raw value (`AllowedContiguity = 170`), useless
            // in a hover; translate it to the member name(s) — exact member first (170 → `Sides`), else
            // the [Flags] decomposition. Untranslatable values stay numeric.
            if (vtKind == "enum" && fo["default"] is JsonValue defVal)
            {
                long? raw = defVal.TryGetValue<long>(out var dl) ? dl : defVal.TryGetValue<int>(out var di) ? di : null;
                if (raw != null && EnumDefaultName(type, raw.Value) is string named) fo["default"] = named;
            }
            // Attach the member's XML <summary>, if any, keyed by the serialized name (post alias/override)
            // so it lines up with the schema field the scaffolder documents. A field's doc-ID uses `F:` when
            // the member is a field and `P:` when it is a property; nested types use `.` (Cecil's `/`).
            var docId = (mem is FieldDefinition ? "F:" : "P:") + t.FullName.Replace('/', '.') + "." + mem.Name;
            if (xmlDocs.TryGetValue(docId, out var memSummary))
            {
                if (!docSeed.TryGetValue(t.FullName, out var typeDocs)) docSeed[t.FullName] = typeDocs = new JsonObject();
                typeDocs[name] = memSummary;
            }
            arr.Add(fo);
        }
        // Append the custom-deserializer reads (see CustomReadCalls) not already emitted as reflected
        // members. All are marked optional even when read with the throwing `ReadFromPath`: such a
        // read may sit in a branch the IL scan cannot see (Color's alpha only when four values are
        // written), so requiredness is not provable here and a wrong `required` flags valid files.
        var emitted = new HashSet<string>();
        foreach (var node in arr)
            if (node is JsonObject existing && existing["name"] is JsonValue nv) emitted.Add(nv.GetValue<string>());
        foreach (var (cname, ctype) in CustomReadCalls(t))
        {
            if (cname == "Type" || !emitted.Add(cname)) continue;
            var co = new JsonObject { ["name"] = cname, ["valueType"] = MapType(ctype), ["optional"] = true };
            // `TryReadFromPath` only tolerates an absent node. A present-but-void one still throws for a
            // non-nullable generic argument, so the same nullability marking applies.
            if (!VoidAssignable(ctype)) co["nullable"] = false;
            arr.Add(co);
        }
        return arr;
    }
}
