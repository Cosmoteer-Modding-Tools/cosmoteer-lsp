using System.Text.Json.Nodes;
using Mono.Cecil;

internal sealed partial class SchemaGen
{
    /// <summary>
    /// Builds the schema field list a type declares itself, without its base classes' fields. Each
    /// `[Serialize]` field and property becomes an entry carrying its OT name and aliases, mapped
    /// value type, optionality (`optional`, `absentThrows`, `nullable`), default and default source,
    /// dead-member flag and scalar string form. Inline-expanded engine value types contribute their
    /// fields in place of a single opaque one, members serialized under an empty alias are dropped in
    /// favour of the type-level emission, and keys recovered from custom deserializer reads are
    /// appended. Any XML summary matched to a member is collected into the field-doc seed.
    /// </summary>
    /// <param name="t">The type whose declared serialized members are extracted.</param>
    /// <returns>The type's own schema fields, in declaration order with the custom reads last.</returns>
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
            // A dictionary member can carry custom entry-form names (`[KeyValuePairNames(Key="Old",
            // Value="New")]`), used when the map is written as a list of entry groups. Recorded on
            // the map type so the entry members type (the engine's defaults are `Key`/`Value`).
            if (vt["kind"]?.GetValue<string>() == "map"
                && Attr(cap, "Halfling.Serialization.DefaultSerializers.KeyValuePairNamesAttribute") is { } kvp)
            {
                if (Named(kvp, "Key") is string entryKey) vt["entryKey"] = entryKey;
                if (Named(kvp, "Value") is string entryValue) vt["entryValue"] = entryValue;
            }
            // A group-typed member with an explicit empty `Alias` writes its fields inline in the
            // owner's group, never under its C# member name. The type-level `inlineFrom` emission
            // (see the type loop) models it, so the unwritable named field is dropped here. A
            // polymorphic one (a name-generator entry's `NameGenerator`, a stat widget wrapper's
            // `IShipStatWidgetRules`) is dropped for the same reason, with the type-level
            // `valueForm` carrying the registry the node dispatches through.
            if (alias == ""
                && (vt["kind"]?.GetValue<string>() == "group" || vt["kind"]?.GetValue<string>() == "polymorphicGroup"))
            {
                continue;
            }
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
            // and produced false positives across vanilla. The other signals recover the fields that are
            // optional in practice but carry no `Optional=true`:
            //   - the class constructor-initializes it (it has a default value).
            //   - an explicit empty `Alias`. The member is serialized inline/unnamed (its content merges
            //     into the parent, e.g. a proxy's embedded `ProxyRules` or a sprite's `AtlasSprite`), so it
            //     is never written as a named field and can never be "missing".
            //   - the C# type is nullable: a `[Nullable]`-annotated reference (byte 2) or a `Nullable<T>`
            //     value type, where null/absent is a legal value.
            //   - a collection (array / list / map): an absent collection is simply empty.
            var vtKind = vt["kind"]?.GetValue<string>();
            fo["optional"] =
                (Named(sa, "Optional") is bool opt && opt)
                || ctorInitialized.Contains(mem.Name)
                || alias == ""
                || IsNullableReference(cap)
                || type.Name == "Nullable`1"
                || vtKind == "list"
                || vtKind == "map";
            // The deserializer's own optionality, which is not the same question as `optional` above.
            // `BaseSerializer.FieldDeserializationInfo` does `Optional = attr?.Optional ?? true`, and
            // every member here carries a `[Serialize]`, so a member that does not set `Optional = true`
            // is required: `ReflectiveRead` hits
            //     if (!Optional || forceNoOption) throw new DeserializeException(…);
            //     if (DefaultValue != null) SetValue(target, DefaultValue);
            // It throws before any default is applied. `optional` above is deliberately broader (it
            // also counts ctor-initialized / nullable / collection members) because it feeds the
            // required-field check, where the strict reading produced false positives. That breadth is
            // wrong for anyone asking "is deleting this field safe": such a field may still be one the
            // game load requires. Emitted only when true, so absence means "absence is legal".
            if (!(Named(sa, "Optional") is bool serializeOptional && serializeOptional)) fo["absentThrows"] = true;
            // A bare valueless field (`ScaleIn` with no `=`) deserializes as null, so mark the fields
            // where that is a game load error and the language server can flag them.
            if (!VoidAssignable(type)) fo["nullable"] = false;
            // A member no game code ever reads (see SchemaGen.DeadFields.cs) is flagged so the
            // language server can hint that writing it is dead weight. Absent otherwise.
            if (MemberIsUnread(mem, name, aliasNames)) fo["dead"] = true;
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
            // CustomAttributeArgument. Unwrap it before emitting or ToString() prints the wrapper's
            // class name instead of the value.
            //
            // The two sources are not equally strong, so `defaultSource` records which one won:
            //   - "attribute": `[Serialize(DefaultValue = …)]`. The engine's own declaration of the
            //     absent-value, and BaseSerializer's reflective read applies it literally. When the
            //     field is missing from the source and the member is Optional, it does
            //     `SetValue(target, DefaultValue)` (BaseSerializer.ReflectiveRead). True regardless of
            //     how the object was constructed.
            //   - "initializer": the constant stores of the smallest-arity constructor, which in
            //     practice is a C# field initializer compiled into the parameterless ctor. This equals
            //     the absent-value only when the game really constructs the class that way and fills it
            //     reflectively, so a consumer must gate it on `purelyReflective`.
            // The distinction exists because optionality (what this was first extracted for) only needs
            // to know that a default exists, while "is writing this field a no-op" needs to know that
            // the recorded value is what an absent field yields.
            var dv = Named(sa, "DefaultValue");
            while (dv is CustomAttributeArgument boxed) dv = boxed.Value;
            if (dv != null)
            {
                fo["default"] = dv switch
                {
                    bool b => b,
                    byte or sbyte or short or ushort or int or uint or long =>
                        vtKind == "bool" ? Convert.ToInt64(dv) != 0 : JsonValue.Create(Convert.ToInt64(dv)),
                    float f => float.IsFinite(f) ? f : (JsonNode)f.ToString(),
                    double d => double.IsFinite(d) ? d : (JsonNode)d.ToString(),
                    _ => dv.ToString(),
                };
                fo["defaultSource"] = "attribute";
            }
            else if (inl.TryGetValue(mem.Name, out var idv) && idv != null)
            {
                if (vtKind == "bool" && idv is JsonValue jv && jv.TryGetValue<int>(out var bi))
                    fo["default"] = bi != 0;
                else fo["default"] = idv;
                fo["defaultSource"] = "initializer";
            }
            // A numeric enum default is the C# constant's raw value (`AllowedContiguity = 170`), useless
            // in a hover. Translate it to the member name(s), exact member first (170 → `Sides`), else
            // the [Flags] decomposition. Untranslatable values stay numeric.
            if (vtKind == "enum" && fo["default"] is JsonValue defVal)
            {
                long? raw = defVal.TryGetValue<long>(out var dl) ? dl : defVal.TryGetValue<int>(out var di) ? di : null;
                if (raw != null && EnumDefaultName(type, raw.Value) is string named) fo["default"] = named;
            }
            // Attach the member's XML <summary>, if any, keyed by the serialized name (post alias/override)
            // so it lines up with the schema field the scaffolder documents. A field's doc-ID uses `F:` when
            // the member is a field and `P:` when it is a property. Nested types use `.` (Cecil's `/`).
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
