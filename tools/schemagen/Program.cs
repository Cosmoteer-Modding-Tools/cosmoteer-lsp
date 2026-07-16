// Full .rules schema extractor (Mono.Cecil over Cosmoteer.dll + HalflingCore.dll), with:
//   - curation table for special OT value types (Range, tuple, Angle, enum-like structs, ...)
//   - reachability pruning from the document root (Cosmoteer.Data.Rules) so non-.rules
//     serialization (MPInput, runtime refs, save-game state) is dropped.
// Both assemblies are scanned because many `*Rules` fields nest engine types from the Halfling
// runtime (a particle effect's whole `Def { … }` body: its updaters, renderers, material). The
// prune keeps only the Halfling types actually reachable from a `.rules` root.
// Emits cosmoteer.schema.json: { meta, registries, types, enums, builtinIds, unresolved }.
// The extraction itself lives in the SchemaGen partial class, one file per concern (see SchemaGen.cs).

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

new SchemaGen(bin, schemaDlls, modPaths, outPathArg).Run();
