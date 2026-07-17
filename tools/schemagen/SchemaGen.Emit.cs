using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Mono.Cecil;
using Mono.Cecil.Cil;

internal sealed partial class SchemaGen
{
    // ---- build full graph ----
    void BuildRegistries()
    {
        foreach (var t in allTypes)
        {
            var ba = Attr(t, BASETYPE);
            if (ba == null) continue;
            var members = new JsonObject();
            foreach (var d in allTypes)
            {
                if (d == t || NearestRegistryBase(d)?.FullName != t.FullName) continue;
                // A type can carry several [SerialDerivedType] attributes, one per accepted `Type=`
                // spelling (DefeatShipsObjective answers to both `DefeatShips` and `DestroyShips`), so
                // every attribute registers its name.
                foreach (var da in d.CustomAttributes.Where(a => a.AttributeType.FullName == DERIVED))
                {
                    members[(Named(da, "TypeName") as string) ?? d.Name] = d.FullName;
                }
            }
            // Some registries dispatch on the plain subclass name with no `[SerialDerivedType]` attribute.
            // The engine discovers members by reflection and `Type=` is the class name (e.g. ship-generator
            // stages: `Type = AsteroidStage`). Add every non-abstract participating subclass of this base that
            // wasn't already named via `[SerialDerivedType]`, keyed by its class name, so those `Type=` values
            // resolve to the concrete class and its fields complete/validate.
            foreach (var d in allTypes)
            {
                if (d == t || d.IsAbstract || !Participates(d)) continue;
                if (Attr(d, DERIVED) != null) continue;
                if (NearestRegistryBase(d)?.FullName != t.FullName) continue;
                if (!members.ContainsKey(d.Name)) members[d.Name] = d.FullName;
            }
            registries[t.FullName] = new JsonObject
            {
                ["name"] = t.Name,
                ["typeField"] = (Named(ba, "TypeFieldName") as string) ?? "Type",
                ["valueField"] = (Named(ba, "ValueFieldName") as string) ?? "Value",
                ["members"] = members
            };
        }
    }

    void BuildTypes()
    {
        foreach (var t in allTypes)
        {
            // Custom-read participants (see IsCustomReadParticipant) are emitted with their recovered
            // keys as the field set, but stay out of Participates so the plain-class-name registry
            // member discovery above never picks them up as `Type=` vocabulary.
            if (!Participates(t) && !IsCustomReadParticipant(t)) continue;
            var o = new JsonObject { ["name"] = t.Name, ["namespace"] = t.Namespace };
            if (t.IsAbstract) o["abstract"] = true;
            if (NearestSchemaBase(t) is { } bd) o["extends"] = bd.FullName;
            var da = Attr(t, DERIVED);
            if (da != null)
            {
                o["derivedType"] = (Named(da, "TypeName") as string) ?? t.Name;
                if (NearestRegistryBase(t) is { } reg) o["registry"] = reg.FullName;
            }
            if (Attr(t, BASETYPE) != null) o["isRegistry"] = true;
            if (HasScalarForm(t))
            {
                o["scalarForm"] = true;
                if (ScalarFieldOf(t) is { } scalarField) o["scalarField"] = scalarField;
            }
            else if (scalarStringTargets.Contains(t.FullName)) o["scalarStringForm"] = true;
            if (EmptyAliasMemberType(t) is { } valueMember)
            {
                var vf = MapType(valueMember);
                // A group-typed empty-alias member writes its fields INLINE in the owner's group (a
                // network component's PartNetworkFilter `Categories`, a widget sprite's embedded
                // AtlasSprite `File`), so the owner inherits the member class's fields at load
                // (`inlineFrom`, merged by the server's schema overlay) instead of carrying an
                // unwritable named member plus a group `valueForm` that would mis-describe the value.
                if (vf["kind"]?.GetValue<string>() == "group" && vf["ref"] is { } inlineRef)
                    o["inlineFrom"] = new JsonArray(inlineRef.GetValue<string>());
                else
                    o["valueForm"] = vf;
            }
            if (PurelyReflective(t)) o["purelyReflective"] = true;
            o["fields"] = OwnFields(t);
            types[t.FullName] = o;
        }
    }

    void PruneAndEmit()
    {
        // ---- reachability prune from ROOT ----
        var reachable = new HashSet<string>();
        var reachEnums = new HashSet<string>();
        var queue = new Queue<string>();
        void Enq(string? fn) { if (!string.IsNullOrEmpty(fn)) queue.Enqueue(fn!); }
        void EnqMembers(string baseFn)
        {
            if (registries[baseFn] is JsonObject rg && rg["members"] is JsonObject mm)
                foreach (var m in mm) Enq(m.Value?.GetValue<string>());
        }
        void Visit(JsonNode? vt)
        {
            if (vt is not JsonObject o) return;
            switch (o["kind"]?.GetValue<string>())
            {
                case "group": Enq(o["ref"]?.GetValue<string>()); break;
                case "polymorphicGroup":
                    var rf = o["ref"]?.GetValue<string>(); Enq(rf); if (rf != null) EnqMembers(rf); break;
                case "reference":
                    var tg = o["target"]?.GetValue<string>(); Enq(tg); if (tg != null) EnqMembers(tg); break;
                case "enum": if (o["ref"]?.GetValue<string>() is { } er) reachEnums.Add(er); break;
                case "number": case "int": case "float": Enq(o["groupForm"]?.GetValue<string>()); break;
                case "list": case "range": case "interpolated": Visit(o["element"]); break;
                case "map": Visit(o["key"]); Visit(o["value"]); break;
                case "tuple": foreach (var e in (JsonArray)o["elements"]!) Visit(e); break;
                case "constructed": foreach (var p in (JsonArray)o["params"]!) Visit(((JsonObject)p!)["valueType"]); break;
                case "generic": if (o["args"] is JsonArray ga) foreach (var a in ga) Visit(a); break;
            }
        }
        Enq(ROOT);
        while (queue.Count > 0)
        {
            var fn = queue.Dequeue();
            if (!reachable.Add(fn)) continue;
            if (registries[fn] is JsonObject) EnqMembers(fn);
            if (types[fn] is not JsonObject T) continue;
            Enq(T["extends"]?.GetValue<string>());
            Enq(T["registry"]?.GetValue<string>());
            if (T["inlineFrom"] is JsonArray inlined) foreach (var i in inlined) Enq(i?.GetValue<string>());
            // A value-form delegation is a reachability edge like a field: a wrapper whose only
            // registry reference is its empty-alias member (a stat widget's IShipStatWidgetRules)
            // must keep that registry and its members alive.
            Visit(T["valueForm"]);
            foreach (var f in (JsonArray)T["fields"]!) Visit(((JsonObject)f!)["valueType"]);
        }

        JsonObject Prune(JsonObject src, HashSet<string> keep)
        {
            var o = new JsonObject();
            foreach (var kv in src) if (keep.Contains(kv.Key)) o[kv.Key] = kv.Value!.DeepClone();
            return o;
        }
        var pTypes = Prune(types, reachable);
        var pRegs = Prune(registries, reachable);
        var pEnums = new JsonObject();
        foreach (var kv in enums.OrderBy(k => k.Key)) if (reachEnums.Contains(kv.Key)) pEnums[kv.Key] = kv.Value.DeepClone();

        // ---- recompute curation surface over pruned types only ----
        var unkTypes = new Dictionary<string, int>(); var unkGen = new Dictionary<string, int>();
        void Bump(Dictionary<string, int> d, string k) => d[k] = d.TryGetValue(k, out var c) ? c + 1 : 1;
        void Scan(JsonNode? vt)
        {
            if (vt is not JsonObject o) return;
            switch (o["kind"]?.GetValue<string>())
            {
                case "opaque": if (o["reason"] == null) Bump(unkTypes, o["type"]!.GetValue<string>()); break;
                case "generic": Bump(unkGen, o["type"]!.GetValue<string>()); if (o["args"] is JsonArray g) foreach (var a in g) Scan(a); break;
                case "list": case "range": case "interpolated": Scan(o["element"]); break;
                case "map": Scan(o["key"]); Scan(o["value"]); break;
                case "tuple": foreach (var e in (JsonArray)o["elements"]!) Scan(e); break;
                case "constructed": foreach (var p in (JsonArray)o["params"]!) Scan(((JsonObject)p!)["valueType"]); break;
            }
        }
        foreach (var t in pTypes) foreach (var f in (JsonArray)((JsonObject)t.Value!)["fields"]!) Scan(((JsonObject)f!)["valueType"]);

        // ---- builtin ids: literal ID<T>("…") constructions in game code ----
        // The engine hardcodes a handful of ids in C# (DamageType's three instances, the sim-object tags
        // the game modes register at runtime, the crew-job component ids), so no `.rules` file declares
        // them. The language server serves them alongside the file-harvested declarations for completion
        // and existence checks. Every such id compiles to a `ldstr` immediately followed by
        // `newobj ID<T>(string)`, so the sweep is mechanical and follows a game update through a normal
        // regeneration. Primitive type arguments (`ID<float>` data channels) are not schema references and
        // are skipped.
        var builtinIds = new Dictionary<string, SortedSet<string>>(StringComparer.Ordinal);
        foreach (var t in allTypes)
        {
            foreach (var m in t.Methods)
            {
                if (!m.HasBody) continue;
                var ins = m.Body.Instructions;
                for (int i = 1; i < ins.Count; i++)
                {
                    if (ins[i].OpCode != OpCodes.Newobj || ins[i].Operand is not MethodReference ctor) continue;
                    if (ctor.DeclaringType is not GenericInstanceType git || git.ElementType.FullName != "Cosmoteer.Data.ID`1") continue;
                    if (ctor.Parameters.Count != 1 || ctor.Parameters[0].ParameterType.FullName != "System.String") continue;
                    if (ins[i - 1].OpCode != OpCodes.Ldstr || ins[i - 1].Operand is not string idValue) continue;
                    // A double-underscore id is an internal engine sentinel (`__stackable`), not something a
                    // `.rules` file should reference or complete.
                    if (idValue.StartsWith("__")) continue;
                    var target = git.GenericArguments[0].FullName;
                    if (target.StartsWith("System.")) continue;
                    if (!builtinIds.TryGetValue(target, out var set)) builtinIds[target] = set = new SortedSet<string>(StringComparer.Ordinal);
                    set.Add(idValue);
                }
            }
        }
        var builtinIdsJson = new JsonObject();
        foreach (var kv in builtinIds)
            builtinIdsJson[kv.Key] = new JsonArray(kv.Value.Select(v => (JsonNode)v).ToArray());

        var root = new JsonObject
        {
            ["meta"] = new JsonObject
            {
                ["source"] = "Cosmoteer.dll + HalflingCore.dll",
                ["root"] = ROOT,
                ["registries"] = pRegs.Count,
                ["types"] = pTypes.Count,
                ["enums"] = pEnums.Count,
                ["typesBeforePrune"] = types.Count,
                ["registriesBeforePrune"] = registries.Count
            },
            ["registries"] = pRegs,
            ["types"] = pTypes,
            ["enums"] = pEnums,
            ["builtinIds"] = builtinIdsJson,
            ["unresolved"] = new JsonObject
            {
                ["types"] = new JsonObject(unkTypes.OrderByDescending(k => k.Value).Select(k => new KeyValuePair<string, JsonNode?>(k.Key, k.Value))),
                ["generics"] = new JsonObject(unkGen.OrderByDescending(k => k.Value).Select(k => new KeyValuePair<string, JsonNode?>(k.Key, k.Value)))
            }
        };

        Directory.CreateDirectory(Path.GetDirectoryName(outPath)!);
        var json = root.ToJsonString(new JsonSerializerOptions { WriteIndented = true });
        File.WriteAllText(outPath, json, new UTF8Encoding(false));
        Console.WriteLine($"PRUNED: registries={pRegs.Count}/{registries.Count} types={pTypes.Count}/{types.Count} " +
            $"enums={pEnums.Count} | curation: unresolvedTypes={unkTypes.Count} unresolvedGenerics={unkGen.Count}");
        Console.WriteLine($"wrote {outPath} ({json.Length / 1024} KB)");

        // Audit trail for the dead-field scan (SchemaGen.DeadFields.cs): every declared-but-unread
        // member that survived the prune, one line each, so a regeneration review sees the flagged
        // set at a glance and a game update that changes it is noticed.
        var deadPairs = new SortedSet<string>(StringComparer.Ordinal);
        foreach (var t in pTypes)
            foreach (var f in (JsonArray)((JsonObject)t.Value!)["fields"]!)
                if (f is JsonObject fo && fo["dead"] is { } d && d.GetValue<bool>())
                    deadPairs.Add($"{t.Key}.{fo["name"]!.GetValue<string>()}");
        Console.WriteLine($"dead fields: {deadPairs.Count}");
        foreach (var pair in deadPairs) Console.WriteLine($"  dead: {pair}");

        // ---- emit the field-docs seed (prose descriptions for reachable types only) ----
        // Alongside the schema, next to it. Keyed by type FullName → serialized field name → XML summary.
        // Only types that survived the reachability prune are kept, so the seed lines up 1:1 with the shipped
        // schema. The docs scaffolder reads this to pre-fill Markdown; it is a build intermediate, not shipped.
        var seedRoot = new JsonObject();
        foreach (var kv in docSeed.OrderBy(k => k.Key, StringComparer.Ordinal))
            if (reachable.Contains(kv.Key)) seedRoot[kv.Key] = kv.Value;
        var seedPath = Path.Combine(Path.GetDirectoryName(outPath)!, "field-docs.seed.json");
        var seedJson = seedRoot.ToJsonString(new JsonSerializerOptions { WriteIndented = true });
        File.WriteAllText(seedPath, seedJson, new UTF8Encoding(false));
        int seedFields = seedRoot.Sum(t => ((JsonObject)t.Value!).Count);
        Console.WriteLine($"wrote {seedPath} ({seedRoot.Count} types, {seedFields} documented fields)");
    }
}
