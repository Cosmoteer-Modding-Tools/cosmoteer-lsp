using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Mono.Cecil;

// The schema extractor behind `Program.cs`, split into one partial file per concern:
//   SchemaGen.cs            fields, construction, the Run() pipeline
//   SchemaGen.XmlDocs.cs    XML documentation loading (prose field descriptions)
//   SchemaGen.Reflection.cs attribute probing, schema participation, base/registry resolution
//   SchemaGen.Curation.cs   hand-curated tables and synthetic types, with their evidence notes
//   SchemaGen.TypeMapping.cs C# type reference → schema value type
//   SchemaGen.Optionality.cs defaults, nullability and custom-deserializer reads
//   SchemaGen.DeadFields.cs whole-assembly read scan flagging declared-but-never-read members
//   SchemaGen.ValueForms.cs  scalar/value/scalar-string form detection from deserializer bodies
//   SchemaGen.Fields.cs     the per-type field emission
//   SchemaGen.Emit.cs       graph assembly, reachability prune, builtin-id sweep, output
internal sealed partial class SchemaGen
{
    const string SERIALIZE  = "Halfling.Serialization.SerializeAttribute";
    const string REFLECTIVE = "Halfling.Serialization.ReflectiveSerializationAttribute";
    const string BASETYPE   = "Halfling.Serialization.SerialBaseTypeAttribute";
    const string DERIVED    = "Halfling.Serialization.SerialDerivedTypeAttribute";
    const string OTCTOR     = "Halfling.Serialization.ObjectText.ObjectTextConstructorAttribute";
    const string ROOT       = "Cosmoteer.Data.Rules";

    readonly List<string> schemaDlls;
    readonly string outPath;
    readonly DefaultAssemblyResolver resolver = new();

    readonly List<TypeDefinition> allTypes = new();
    readonly Dictionary<string, string> xmlDocs = new(StringComparer.Ordinal);
    // Collected prose descriptions, keyed by declaring-type FullName → serialized field name → summary.
    // Filled in OwnFields as each field is emitted, written to field-docs.seed.json after the prune.
    readonly Dictionary<string, JsonObject> docSeed = new();
    readonly Dictionary<string, JsonObject> enums = new();
    readonly HashSet<string> scalarStringTargets = new();
    // Types read by a globally registered custom wrapper serializer (any [DefaultSerializer]), a
    // superset of scalarStringTargets. Such a type is not purely reflective (see PurelyReflective).
    readonly HashSet<string> customSerializerTargets = new();
    readonly JsonObject registries = new();
    readonly JsonObject types = new();

    public SchemaGen(string bin, List<string> schemaDlls, List<string> modPaths, string outPath)
    {
        this.schemaDlls = schemaDlls;
        this.outPath = outPath;
        resolver.AddSearchDirectory(bin);
        foreach (var mod in modPaths)
            resolver.AddSearchDirectory(Directory.Exists(mod) ? mod : Path.GetDirectoryName(Path.GetFullPath(mod))!);
    }

    public void Run()
    {
        LoadAssemblies();
        ScanMemberReads();
        LoadXmlDocs();
        SeedCuratedEnums();
        BuildRegistries();
        CollectScalarStringTargets();
        BuildTypes();
        AddCuratedTypes();
        PruneAndEmit();
    }

    void LoadAssemblies()
    {
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
    }
}
