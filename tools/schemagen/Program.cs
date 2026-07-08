using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Xml.Linq;
using Mono.Cecil;
using Mono.Cecil.Cil;

// Full .rules schema extractor (Mono.Cecil over Cosmoteer.dll + HalflingCore.dll), with:
//   - curation table for special OT value types (Range, tuple, Angle, enum-like structs, ...)
//   - reachability pruning from the document root (Cosmoteer.Data.Rules) so non-.rules
//     serialization (MPInput, runtime refs, save-game state) is dropped.
// Both assemblies are scanned because many `*Rules` fields nest engine types from the Halfling
// runtime (a particle effect's whole `Def { … }` body — its updaters, renderers, material). The
// prune keeps only the Halfling types actually reachable from a `.rules` root.
// Emits cosmoteer.schema.json: { meta, registries, types, enums, unresolved }.

const string SERIALIZE  = "Halfling.Serialization.SerializeAttribute";
const string REFLECTIVE = "Halfling.Serialization.ReflectiveSerializationAttribute";
const string BASETYPE   = "Halfling.Serialization.SerialBaseTypeAttribute";
const string DERIVED    = "Halfling.Serialization.SerialDerivedTypeAttribute";
const string OTCTOR     = "Halfling.Serialization.ObjectText.ObjectTextConstructorAttribute";
const string ROOT       = "Cosmoteer.Data.Rules";

// Usage: dotnet run -c Release -- [<Cosmoteer Bin dir>] [<output schema path>] [--mod <dll-or-dir>]...
//   <Cosmoteer Bin dir>  the game's Bin folder (holds Cosmoteer.dll + HalflingCore.dll)
//   <output schema path> where to write cosmoteer.schema.json
//   --mod <dll-or-dir>   one or more code-mod assemblies (a .dll, or a folder scanned for *.dll) whose
//                        serializable types extend the schema, so a mod's custom components/effects
//                        (`Type = AmmoChange`, …) resolve. Repeatable. See tools/schemagen/README.md.
var positionals = new List<string>();
var modPaths = new List<string>();
for (int i = 0; i < args.Length; i++)
{
    if (args[i] == "--mod" && i + 1 < args.Length) modPaths.Add(args[++i]);
    else positionals.Add(args[i]);
}
string bin = positionals.Count > 0 ? positionals[0]
    : @"C:\Program Files (x86)\Steam\steamapps\common\Cosmoteer\Bin";
string dll = Path.Combine(bin, "Cosmoteer.dll");
// Assemblies whose serializable types make up the .rules schema. Cosmoteer.dll holds the `*Rules`
// classes rooted at `Cosmoteer.Data.Rules`, but many fields nest engine types from the Halfling
// runtime (a particle file's whole `Def { … }` body is `Halfling.Particles.ParticleSystemDef`, its
// renderers, materials, initializers, …). Those live in HalflingCore.dll, so it must be scanned too
// or every effect file is unresolved below its top-level fields.
var schemaDlls = new List<string> { dll, Path.Combine(bin, "HalflingCore.dll") };
// A code mod adds new serializable types (parts, components, effects) the base game does not know.
// Each `--mod` path contributes its assemblies so their `[SerialDerivedType]` discriminators register
// into the base registries and their fields are emitted, exactly like the game's own types.
foreach (var mod in modPaths)
{
    if (Directory.Exists(mod)) schemaDlls.AddRange(Directory.GetFiles(mod, "*.dll", SearchOption.AllDirectories));
    else if (File.Exists(mod)) schemaDlls.Add(mod);
    else Console.Error.WriteLine($"warning: --mod path not found, skipping: {mod}");
}
// Default output: the repo's schema seam, resolved relative to this tool's build dir
// (bin/Release/net9.0 → up 5 → repo root), so a bare `dotnet run` regenerates the shipped bundle.
string defaultOut = Path.GetFullPath(Path.Combine(
    AppContext.BaseDirectory, "..", "..", "..", "..", "..",
    "server", "src", "document", "schema", "cosmoteer.schema.json"));
string outPathArg = positionals.Count > 1 ? positionals[1] : defaultOut;

var resolver = new DefaultAssemblyResolver();
resolver.AddSearchDirectory(bin);
foreach (var mod in modPaths)
    resolver.AddSearchDirectory(Directory.Exists(mod) ? mod : Path.GetDirectoryName(Path.GetFullPath(mod))!);

var allTypes = new List<TypeDefinition>();
void Collect(TypeDefinition t) { allTypes.Add(t); foreach (var n in t.NestedTypes) Collect(n); }
var seenAssemblies = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
foreach (var path in schemaDlls)
{
    if (!File.Exists(path) || !seenAssemblies.Add(Path.GetFullPath(path))) continue;
    TypeDefinition[] moduleTypes;
    try { moduleTypes = AssemblyDefinition.ReadAssembly(path, new ReaderParameters { AssemblyResolver = resolver }).MainModule.Types.ToArray(); }
    catch (Exception e) { Console.Error.WriteLine($"warning: could not read {Path.GetFileName(path)}: {e.Message}"); continue; }
    foreach (var t in moduleTypes) Collect(t);
}

// ---- XML documentation (prose field descriptions) ----
// The game ships compiler-generated XML doc files next to each assembly (Cosmoteer.xml,
// HalflingCore.xml). Index every member's <summary> by its XML doc-ID (`F:Type.Field` for a field,
// `P:Type.Prop` for a property) so OwnFields can attach the prose to the matching serialized field.
// The descriptions are emitted to a separate `field-docs.seed.json`, never into the schema itself —
// the docs scaffolder turns that seed into editable Markdown (see docs/fields and field-docs.ts). The
// separation keeps a schemagen regen from clobbering hand-written community docs.
var xmlDocs = new Dictionary<string, string>(StringComparer.Ordinal);
// The readable text of a `<summary>`: concatenate its text, resolving `<see cref>`/`<paramref>` to the
// referenced short name and flattening inline tags, then collapse XML-doc indentation to single spaces.
string Summarize(XElement el)
{
    var sb = new StringBuilder();
    void Walk(XElement e)
    {
        foreach (var node in e.Nodes())
        {
            if (node is XText txt) { sb.Append(txt.Value); continue; }
            if (node is not XElement ce) continue;
            switch (ce.Name.LocalName)
            {
                case "see":
                case "seealso":
                    var cref = ce.Attribute("cref")?.Value ?? ce.Attribute("langword")?.Value ?? "";
                    var colon = cref.IndexOf(':'); if (colon >= 0) cref = cref[(colon + 1)..];
                    var tick = cref.IndexOf('`'); if (tick >= 0) cref = cref[..tick];
                    var dot = cref.LastIndexOf('.');
                    sb.Append(dot >= 0 ? cref[(dot + 1)..] : cref);
                    break;
                case "paramref":
                case "typeparamref":
                    sb.Append(ce.Attribute("name")?.Value ?? "");
                    break;
                default:
                    Walk(ce);   // c / para / list / etc. — keep their inner text
                    break;
            }
        }
    }
    Walk(el);
    var text = Regex.Replace(sb.ToString(), @"\s+", " ").Trim();
    // The XML docs are written for engine developers. Two mechanical rewrites make them read as modder
    // field docs: drop the C# copy-plumbing boilerplate (meaningless in a .rules file), and turn the
    // C# property phrasing (`Gets or sets whether …`) into a direct description (`Whether …`).
    text = Regex.Replace(text, @"\s*This (?:property|member) [^.]*?CopySettingsFrom\(\)[^.]*\.?", "");
    text = Regex.Replace(text, @"^Gets(?: or sets)? a value indicating whether ", "Whether ");
    text = Regex.Replace(text, @"^Gets(?: or sets)? ", "");
    text = text.Trim();
    if (text.Length > 0) text = char.ToUpperInvariant(text[0]) + text[1..];
    return text;
}
foreach (var path in schemaDlls)
{
    var xmlPath = Path.ChangeExtension(path, ".xml");
    if (!File.Exists(xmlPath)) continue;
    XDocument xd;
    try { xd = XDocument.Load(xmlPath); }
    catch (Exception e) { Console.Error.WriteLine($"warning: could not read {Path.GetFileName(xmlPath)}: {e.Message}"); continue; }
    foreach (var mem in xd.Descendants("member"))
    {
        var id = mem.Attribute("name")?.Value;
        var summary = mem.Element("summary");
        if (string.IsNullOrEmpty(id) || summary == null) continue;
        var text = Summarize(summary);
        if (!string.IsNullOrEmpty(text)) xmlDocs.TryAdd(id!, text);
    }
}
// Collected prose descriptions, keyed by declaring-type FullName → serialized field name → summary.
// Filled in OwnFields as each field is emitted, written to field-docs.seed.json after the prune.
var docSeed = new Dictionary<string, JsonObject>();

CustomAttribute? Attr(ICustomAttributeProvider m, string full) =>
    m.CustomAttributes.FirstOrDefault(a => a.AttributeType.FullName == full);
object? Named(CustomAttribute a, string name) =>
    a.Properties.FirstOrDefault(p => p.Name == name).Argument.Value;
bool IsReflective(TypeDefinition t) => Attr(t, REFLECTIVE) != null;

bool HasSerializeMembers(TypeDefinition t) =>
    t.Fields.Any(f => !f.IsStatic && Attr(f, SERIALIZE) != null)
    || t.Properties.Any(p => Attr(p, SERIALIZE) != null);

// A type participates in the .rules schema if it is an explicit reflective node or it contributes
// [Serialize] members to one. Abstract bases (e.g. BaseQuadEffectRules) carry the real fields —
// Sprite/Bucket/FadeInTime/… but are not themselves [ReflectiveSerialization]-tagged. Only the
// concrete leaves are. The reachability prune from ROOT still drops any that aren't actually used.
bool Participates(TypeDefinition t) => IsReflective(t) || HasSerializeMembers(t);

// The nearest ancestor that participates in the schema, skipping non-serializable intermediates,
// so `extends` links a leaf to its real field-bearing base even when that base lacks the attribute.
TypeDefinition? NearestSchemaBase(TypeDefinition t)
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
TypeDefinition? InterfaceRegistry(TypeDefinition t)
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
TypeDefinition? NearestRegistryBase(TypeDefinition t)
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

var enums = new Dictionary<string, JsonObject>();

// Extra spellings the Halfling OT deserializer accepts for an enum beyond its C# member names, when
// they carry no alias attribute to extract. Validated against the vanilla scan: e.g. particle data
// fields write `DataType = Vector2D` for the `Vector2` member, so without this the 29 vanilla files
// using it would false-positive. Keep entries evidence-based (a spelling vanilla actually uses).
var enumAliases = new Dictionary<string, string[]>
{
    ["Halfling.Particles.ParticleDataType"] = new[] { "Vector2D" },
};

// The OT name a reflective field is written under when it differs from its C# member name and no
// `[Serialize(Alias=…)]` carries it. The float colour components serialize as `Rf`/`Gf`/`Bf`/`Af`
// (vanilla writes them ~1900×) while the C# fields are `R`/`G`/`B`/`A`; without this, completion and
// hover inside a `Color { … }` offer the wrong names. The original member name is kept as an alias.
// Keyed by declaring type FullName, then C# member name → OT name. Evidence-based (a spelling vanilla
// actually uses); a wrong entry would surface as a vanilla mis-hint, not a false diagnostic.
var fieldNameOverrides = new Dictionary<string, Dictionary<string, string>>
{
    ["Halfling.Graphics.Color"] = new() { ["R"] = "Rf", ["G"] = "Gf", ["B"] = "Bf", ["A"] = "Af" },
};

// Abstract sprite/material interfaces that are always deserialized as a single concrete class. A field
// typed as the interface is rewritten to reference the concrete impl, which carries the full field set
// (the interface reflects only a subset). `Sprite`/`Material` are extracted normally; `AnimatedSprite`
// is a curated type (its frame fields are custom-deserialized, no `[Serialize]`).
var ConcreteImpl = new Dictionary<string, (string full, string name)>
{
    ["Halfling.Graphics.ISprite"] = ("Halfling.Graphics.Sprite", "Sprite"),
    ["Halfling.Graphics.IMaterial"] = ("Halfling.Graphics.Material", "Material"),
    ["Halfling.Graphics.IAnimatedSprite"] = ("Halfling.Graphics.AnimatedSprite", "AnimatedSprite"),
};

// Engine value types that are deserialized inline — they have no `[Serialize]` members (a custom
// deserializer reads sibling keys from the parent), so reflection yields an `opaque` blob and the
// real fields are invisible. A particle updater's `Range` (`FlexRange`) is written as `ValueType` +
// `FromValue` + `ToValue` directly in the updater group, and `Value` (`FlexValue`) as `ValueType` +
// `Value`. We splice those fields into the parent at extraction time (keyed by the opaque type name),
// so completion/hover see them. The component values are runtime-polymorphic on `ValueType`
// (Angle→number, Vector2→group, Color→{Rf…}), so they stay permissive (`opaque`, no validation); only
// `ValueType` is a closed enum, kept honest by the vanilla scan.
const string FLEX_VALUE_TYPE = "Halfling.Particles.Updaters.FlexValueType";
JsonObject Field(string name, JsonObject valueType) => new() { ["name"] = name, ["valueType"] = valueType, ["optional"] = true };
JsonObject EnumRef(string fullName) => new() { ["kind"] = "enum", ["ref"] = fullName, ["name"] = fullName.Split('.').Last() };
JsonObject OpaqueRef(string type) => new() { ["kind"] = "opaque", ["type"] = type };
var inlineFieldExpansions = new Dictionary<string, Func<JsonObject[]>>
{
    ["FlexRange"] = () => new[] { Field("ValueType", EnumRef(FLEX_VALUE_TYPE)), Field("FromValue", OpaqueRef("FlexValueComponent")), Field("ToValue", OpaqueRef("FlexValueComponent")) },
    ["FlexValue"] = () => new[] { Field("ValueType", EnumRef(FLEX_VALUE_TYPE)), Field("Value", OpaqueRef("FlexValueComponent")) },
};
// The `ValueType` discriminator a FlexRange/FlexValue carries. No reflective enum is reachable for it
// (the type is custom-deserialized), so it is curated from the vanilla vocabulary plus the sibling
// dimensional names; the 954-file scan keeps it false-positive-free.
enums[FLEX_VALUE_TYPE] = new JsonObject
{
    ["name"] = "FlexValueType",
    ["members"] = new JsonArray("Float", "Int", "Angle", "Color", "Vector2", "Vector2D", "Vector3", "Vector4", "IntVector2", "IntVector3", "IntVector4", "Interpolated", "Raw"),
};
// The modification mode of an inline buff/status/effect-scale modifier inside a Modifiable group form.
// The enum (`Cosmoteer.Ships.ValueModificationMode`) is `internal` and reached only through the
// custom inline-modifier deserializer (no `[Serialize]` slot), so it is curated from the decompiled
// member list and kept honest by the vanilla scan.
const string VALUE_MOD_MODE = "Cosmoteer.Ships.ValueModificationMode";
const string MODIFIABLE_VALUE = "Cosmoteer.Ships.ModifiableValue";
enums[VALUE_MOD_MODE] = new JsonObject
{
    ["name"] = "ValueModificationMode",
    ["members"] = new JsonArray("Replace", "Add", "Subtract", "Multiply", "Divide", "Lerp", "ReverseLerp"),
};
// When an animated AtlasSprite's animation clock starts. Nested enum reached only via the sprite's
// custom deserializer (no `[Serialize]` slot), so curated from the decompiled member list.
const string ANIM_START_MODE = "Cosmoteer.Ships.Rendering.AtlasSprite/AnimStartTimeMode";
enums[ANIM_START_MODE] = new JsonObject
{
    ["name"] = "AnimStartTimeMode",
    ["members"] = new JsonArray("Zero", "MinValue", "WhenSpawned", "Random", "Default"),
};

void RegisterEnum(TypeDefinition def, IEnumerable<string> members, bool enumLike)
{
    if (enums.ContainsKey(def.FullName)) return;
    var arr = new JsonArray(); foreach (var m in members) arr.Add(m);
    if (enumAliases.TryGetValue(def.FullName, out var extra)) foreach (var m in extra) arr.Add(m);
    var o = new JsonObject { ["name"] = def.Name, ["members"] = arr };
    if (enumLike) o["enumLike"] = true;
    enums[def.FullName] = o;
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
        case "Texture": case "Cursor": o["kind"] = "asset"; o["assetKind"] = "image"; return o;
        case "Sound": o["kind"] = "asset"; o["assetKind"] = "sound"; return o;
        case "Shader": o["kind"] = "asset"; o["assetKind"] = "shader"; return o;
        case "Font": o["kind"] = "asset"; o["assetKind"] = "font"; return o;
        case "CompiledCode": o["kind"] = "code"; o["lang"] = "python"; return o;
        // An external/internal virtual cell pair, modeled as a curated group (see above).
        case "VirtualInternalCell":
            return GroupOf("Cosmoteer.Ships.Parts.VirtualInternalCell", "VirtualInternalCell");
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

Dictionary<string, JsonNode?> InlineDefaults(TypeDefinition t)
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
string? EnumDefaultName(TypeReference tr, long value)
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

// Member names the type's constructor assigns ANY value to (a constant, or `new …()` / another
// object), with auto-property backing fields normalized to the property name. A field the class
// initializes has a default, so the ObjectText deserializer tolerates its absence — i.e. it is
// optional even without an explicit `[Serialize(Optional=true)]`. Mirrors InlineDefaults' choice of
// the smallest-arity (typically parameterless) constructor, so a parameterized ctor's `this.x = x`
// parameter copies are not mistaken for defaults.
HashSet<string> ConstructorInitializedMembers(TypeDefinition t)
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
bool IsNullableReference(ICustomAttributeProvider cap)
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
bool VoidAssignable(TypeReference tr)
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
IEnumerable<(string name, TypeReference type)> CustomReadCalls(TypeDefinition t)
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
        // Attach the member's XML <summary>, if any, keyed by the SERIALIZED name (post alias/override)
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
    // members. They are optional (read via Try/Optional or with a default) and never the discriminator.
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

// ---- build full graph ----
var registries = new JsonObject();
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
    // Some registries dispatch on the plain subclass name with no `[SerialDerivedType]` attribute —
    // the engine discovers members by reflection and `Type=` is the class name (e.g. ship-generator
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
bool BodyMentionsFieldNode(MethodDefinition? m) =>
    m?.HasBody == true && m.Body.Instructions.Any(i =>
        (i.Operand is TypeReference tr && tr.FullName == "Halfling.ObjectText.OTFieldNode")
        || (i.Operand is MemberReference mr && mr.DeclaringType?.FullName == "Halfling.ObjectText.OTFieldNode"));

TypeReference? EmptyAliasMemberType(TypeDefinition t)
{
    foreach (var f in t.Fields)
        if (Attr(f, SERIALIZE) is { } fa && Named(fa, "Alias") as string == "") return f.FieldType;
    foreach (var p in t.Properties)
        if (Attr(p, SERIALIZE) is { } pa && Named(pa, "Alias") as string == "") return p.PropertyType;
    return null;
}

bool HasScalarForm(TypeDefinition t) =>
    BodyMentionsFieldNode(t.Methods.FirstOrDefault(m => m.IsConstructor && Attr(m, OTCTOR) != null))
    || BodyMentionsFieldNode(t.Methods.FirstOrDefault(m =>
        m.Name.EndsWith("ReadContentFrom")
        && m.Parameters.Any(p => p.ParameterType.FullName == "Halfling.Serialization.ObjectText.ObjectTextSerializer")));

// Whether a wrapper serializer type reads a scalar (its Read(ObjectTextSerializer, …) branches
// on OTFieldNode). Shared by both registration paths of mechanism 3.
bool WrapperReadsScalar(TypeDefinition? wrapper) =>
    wrapper != null && BodyMentionsFieldNode(wrapper.Methods.FirstOrDefault(m =>
        m.Name == "Read"
        && m.Parameters.FirstOrDefault()?.ParameterType.FullName
            == "Halfling.Serialization.ObjectText.ObjectTextSerializer"));

// Globally registered wrappers: collect the CanRead targets of scalar-reading [DefaultSerializer]
// classes. Only the simple `type == typeof(X)` shape (exactly one ldtoken) is taken; a wrapper
// with a complex CanRead (the generic ID-dictionary serializer) yields no unambiguous target and
// is skipped.
var scalarStringTargets = new HashSet<string>();
foreach (var t in allTypes)
{
    if (Attr(t, "Halfling.Serialization.DefaultSerializerAttribute") == null) continue;
    var canRead = t.Methods.FirstOrDefault(m => m.Name == "CanRead" && m.HasBody);
    if (canRead == null || !WrapperReadsScalar(t)) continue;
    var targets = canRead.Body.Instructions
        .Where(i => i.OpCode == OpCodes.Ldtoken && i.Operand is TypeReference)
        .Select(i => ((TypeReference)i.Operand).FullName)
        .Distinct()
        .ToList();
    if (targets.Count == 1) scalarStringTargets.Add(targets[0]);
}

var types = new JsonObject();
foreach (var t in allTypes)
{
    if (!Participates(t)) continue;
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
    if (HasScalarForm(t)) o["scalarForm"] = true;
    else if (scalarStringTargets.Contains(t.FullName)) o["scalarStringForm"] = true;
    if (EmptyAliasMemberType(t) is { } valueMember) o["valueForm"] = MapType(valueMember);
    o["fields"] = OwnFields(t);
    types[t.FullName] = o;
}

// ---- curated synthetic group types ----
// A few structs are deserialized field-by-field but carry no [Serialize]/[ReflectiveSerialization]
// (plain public fields read by a custom ObjectTextConstructor), so reflection can't see their shape
// and they would land as opaque. Their field set is fixed and unambiguous, so we inject it here and
// point the matching MapType case at it. Only model structs with a SINGLE, non-dual written form
// (a struct that is sometimes a scalar/list and sometimes a group — e.g. DirectionalCrewSpeeds — is
// left opaque so completion is not misled). Only model structs with a single, non-dual written form.
// The reachability prune keeps these only if actually used.
JsonObject CuratedField(string name, JsonObject valueType) =>
    new() { ["name"] = name, ["valueType"] = valueType, ["optional"] = false };
JsonObject GroupOf(string fullName, string name) => new() { ["kind"] = "group", ["ref"] = fullName, ["name"] = name };
// VirtualInternalCell: always `{ ExternalCell=[x, y]; InternalCell=[x, y] }`, both IntVector2.
types["Cosmoteer.Ships.Parts.VirtualInternalCell"] = new JsonObject
{
    ["name"] = "VirtualInternalCell",
    ["namespace"] = "Cosmoteer.Ships.Parts",
    ["fields"] = new JsonArray(
        CuratedField("ExternalCell", GroupOf("Halfling.Geometry.IntVector2", "IntVector2")),
        CuratedField("InternalCell", GroupOf("Halfling.Geometry.IntVector2", "IntVector2")))
};
// ModifiableValue: the GROUP form of a Modifiable<T> field (the `groupForm` target above). Its
// reflective members are BaseValue/Modifiers/MinValue/MaxValue; the buff/status/effect-scale keys are
// read inline by the custom deserializer (`_TryReadInlineModifierData`). BaseValue/Min/Max are the
// generic `T`, modeled as a plain `number` (good for any variant). Modifiers stays a permissive list
// so its polymorphic elements are never falsely flagged. All optional — the scalar shorthand is the
// common form, so none of these is required.
JsonObject OptField(string name, JsonObject valueType) => new() { ["name"] = name, ["valueType"] = valueType, ["optional"] = true };
JsonObject NumberType() => new() { ["kind"] = "number" };
JsonObject RefType(string target, string name) => new() { ["kind"] = "reference", ["target"] = target, ["targetName"] = name };
JsonObject ModeEnum() => new() { ["kind"] = "enum", ["ref"] = VALUE_MOD_MODE, ["name"] = "ValueModificationMode" };
types[MODIFIABLE_VALUE] = new JsonObject
{
    ["name"] = "ModifiableValue",
    ["namespace"] = "Cosmoteer.Ships",
    ["fields"] = new JsonArray(
        OptField("BaseValue", NumberType()),
        OptField("Modifiers", new JsonObject { ["kind"] = "list", ["element"] = OpaqueRef("ValueModifier") }),
        OptField("MinValue", NumberType()),
        OptField("MaxValue", NumberType()),
        OptField("BuffType", RefType("Cosmoteer.Ships.Buffs.BuffType", "BuffType")),
        OptField("BuffMode", ModeEnum()),
        OptField("BuffMinValue", NumberType()),
        OptField("BuffMaxValue", NumberType()),
        OptField("StatusType", RefType("Cosmoteer.Ships.Statuses.StatusType", "StatusType")),
        OptField("StatusMode", ModeEnum()),
        OptField("StatusMinValue", NumberType()),
        OptField("StatusMaxValue", NumberType()),
        OptField("EffectScaleExponent", NumberType()),
        OptField("EffectScaleMode", ModeEnum()))
};
// AtlasSprite: the engine's quad-sprite, a custom-deserialized group (`IObjectTextContentDeserializable`,
// no `[Serialize]` members) so reflection yields an empty field set. It is referenced as a group by
// ~5700 vanilla field-slots (every `…Sprite { File=… Size=… }`), so its fields are transcribed from
// the deserializer (`ReadContentFrom`) here. All optional (every key is read with Try/ReadOptional).
JsonObject AssetImage() => new() { ["kind"] = "asset", ["assetKind"] = "image" };
JsonObject ListOfImages() => new() { ["kind"] = "list", ["element"] = AssetImage() };
JsonObject Vector2Type() => GroupOf("Halfling.Geometry.Vector2", "Vector2");
JsonObject BoolType() => new() { ["kind"] = "bool" };
types["Cosmoteer.Ships.Rendering.AtlasSprite"] = new JsonObject
{
    ["name"] = "AtlasSprite",
    ["namespace"] = "Cosmoteer.Ships.Rendering",
    ["fields"] = new JsonArray(
        OptField("File", AssetImage()),
        OptField("AnimationFiles", ListOfImages()),
        OptField("NormalsFile", AssetImage()),
        OptField("NormalsAnimationFiles", ListOfImages()),
        OptField("Size", Vector2Type()),
        OptField("Offset", Vector2Type()),
        OptField("Z", NumberType()),
        OptField("VertexColor", GroupOf("Halfling.Graphics.Color", "Color")),
        OptField("UVRotation", new JsonObject { ["kind"] = "int" }),
        OptField("MirrorU", BoolType()),
        OptField("MirrorV", BoolType()),
        OptField("AnimationInterval", NumberType()),
        OptField("AnimationStartTime", new JsonObject { ["kind"] = "enum", ["ref"] = ANIM_START_MODE, ["name"] = "AnimStartTimeMode" }),
        OptField("ClampAnimation", BoolType()),
        OptField("RotSpeed", NumberType()),
        // Texture-loading options the sprite reads inline alongside its `File`.
        OptField("SampleMode", new JsonObject { ["kind"] = "enum", ["ref"] = "Halfling.Graphics.TextureSampleMode", ["name"] = "TextureSampleMode" }),
        OptField("MipLevels", new JsonObject { ["kind"] = "string", ["semantic"] = "mipLevels" }),
        OptField("FixTransparentColors", BoolType()),
        OptField("PreMultiplyByAlpha", BoolType()))
};
// AnimatedSprite: the concrete IAnimatedSprite impl (IGenericContentDeserializable, no `[Serialize]`).
// Either splits a source `AtlasSprite` into FrameCount frames of FrameSize, or takes explicit `Frames`,
// with a `Duration`/`FramesPerSecond`/`Interval` clock and a `WrapMode`. Transcribed from its
// ReadContentFrom; the `IAnimatedSprite` slot resolves here (see CONCRETE_IMPL in schema-context.ts).
JsonObject IntType2() => new() { ["kind"] = "int" };
JsonObject IntVec2() => GroupOf("Halfling.Geometry.IntVector2", "IntVector2");
types["Halfling.Graphics.AnimatedSprite"] = new JsonObject
{
    ["name"] = "AnimatedSprite",
    ["namespace"] = "Halfling.Graphics",
    ["fields"] = new JsonArray(
        OptField("AtlasSprite", GroupOf("Halfling.Graphics.Sprite", "Sprite")),
        OptField("FrameCount", IntType2()),
        OptField("FrameSize", IntVec2()),
        OptField("FramePadding", IntVec2()),
        OptField("FramesOffset", IntVec2()),
        OptField("FramesPerRow", IntType2()),
        OptField("Frames", new JsonObject { ["kind"] = "list", ["element"] = GroupOf("Halfling.Graphics.Sprite", "Sprite") }),
        OptField("Duration", NumberType()),
        OptField("FramesPerSecond", NumberType()),
        OptField("Interval", NumberType()),
        OptField("WrapMode", new JsonObject { ["kind"] = "enum", ["ref"] = "Halfling.Graphics.AnimationWrapMode", ["name"] = "AnimationWrapMode" }))
};

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

// ---- recompute curation surface over PRUNED types only ----
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
    ["unresolved"] = new JsonObject
    {
        ["types"] = new JsonObject(unkTypes.OrderByDescending(k => k.Value).Select(k => new KeyValuePair<string, JsonNode?>(k.Key, k.Value))),
        ["generics"] = new JsonObject(unkGen.OrderByDescending(k => k.Value).Select(k => new KeyValuePair<string, JsonNode?>(k.Key, k.Value)))
    }
};

var outPath = outPathArg;
Directory.CreateDirectory(Path.GetDirectoryName(outPath)!);
var json = root.ToJsonString(new JsonSerializerOptions { WriteIndented = true });
File.WriteAllText(outPath, json, new UTF8Encoding(false));
Console.WriteLine($"PRUNED: registries={pRegs.Count}/{registries.Count} types={pTypes.Count}/{types.Count} " +
    $"enums={pEnums.Count} | curation: unresolvedTypes={unkTypes.Count} unresolvedGenerics={unkGen.Count}");
Console.WriteLine($"wrote {outPath} ({json.Length / 1024} KB)");

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
