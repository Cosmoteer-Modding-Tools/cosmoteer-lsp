# schemagen — Cosmoteer `.rules` schema extractor

Extracts the `.rules` **schema** straight from the game's C# assemblies and emits
`server/src/document/schema/cosmoteer.schema.json`, the bundle the language server consumes for
schema-driven completion and validation.

## Why this exists

`.rules` files are deserialized by the game into C# `*Rules` classes (Halfling's reflection
serializer). Those classes — their `[Serialize]` fields, `[SerialBaseType]`/`[SerialDerivedType]`
`Type=` dispatch, enums, and defaults — *are* the schema. This tool reads that metadata directly
from `Cosmoteer.dll` **and `HalflingCore.dll`** with **Mono.Cecil** (no decompiler fragility),
prunes it to everything reachable from the document root (`Cosmoteer.Data.Rules`), and serializes
it to JSON.

`HalflingCore.dll` is scanned alongside `Cosmoteer.dll` because many fields nest engine types from
the Halfling runtime — most visibly a particle effect's entire `Def { … }` body
(`Halfling.Particles.ParticleSystemDef`, its updater/renderer registries, `IMaterial`). Without it
those files have no schema below their top-level fields. Note two Halfling wrinkles the extractor
handles: a registry's `[SerialBaseType]` can sit on an **interface** that an abstract base class
implements (so registry-base resolution probes implemented interfaces, not just the class chain),
and a few enums accept an OT spelling beyond their C# member names (e.g. `ParticleDataType` accepts
`Vector2D`), curated in the `enumAliases` table and kept honest by the vanilla scan.

See the bundle's shape in [`server/src/document/schema/schema.types.ts`](../../server/src/document/schema/schema.types.ts)
and the consumer in [`server/src/document/schema/README.md`](../../server/src/document/schema/README.md).

## Regenerate the schema

Requires the .NET SDK (9.x) and a Cosmoteer install.

```bash
cd tools/schemagen
dotnet run -c Release
```

With no arguments it reads `Cosmoteer.dll` from the default Steam path and writes the bundle to
`server/src/document/schema/cosmoteer.schema.json`. Override either:

```bash
dotnet run -c Release -- "<path to Cosmoteer/Bin>" "<output path>.json"
```

### Field-doc seed (`field-docs.seed.json`)

The extractor also reads the compiler-generated XML doc files shipped next to each assembly
(`Cosmoteer.xml`, `HalflingCore.xml`) and emits every `<summary>` it can match to a serialized field
into `field-docs.seed.json`, written next to the schema output. This is the prose seed for the field
documentation the LSP shows on hover/completion. It is a build intermediate (gitignored); the docs
scaffolder (`tools/docsgen`) turns it into editable `docs/fields/*.md`, which are the committed source
of truth. Regenerate it on a Cosmoteer update, then re-run the scaffolder to fold in newly-documented
fields — see `docs/fields/README.md`.

## Code mods (C# mods)
# This is basically an idea of how to support feature mods, i don't think there is yet a single mod out there that adds new serializable types, but if there were, this is how you would extract them.

A code mod ships a `.dll` that adds new serializable types — parts, components, effects — with their
own `Type=` discriminators (`Type = AmmoChange`, …). Point the extractor at the mod's assemblies so
those types are extracted and merged into the registries exactly like the game's own, producing a
schema that also understands the modded content:

```bash
dotnet run -c Release -- "<path to Cosmoteer/Bin>" "<output path>.json" \
  --mod "<a mod .dll>" \
  --mod "<a folder of mod .dlls>"
```

`--mod` is repeatable and accepts a single `.dll` or a directory (scanned recursively for `*.dll`).
Already-loaded assemblies are de-duplicated; a missing or unreadable path is reported and skipped.

It prints a summary, e.g.:

```
PRUNED: registries=29/55 types=578/1033 enums=61 | curation: unresolvedTypes=14 unresolvedGenerics=3
wrote .../cosmoteer.schema.json (1199 KB)
```

## After regenerating (e.g. a Cosmoteer update)

1. **Re-run the false-positive guard** — validate every shipped vanilla file through the schema; it
   must stay warning-free. The method is recorded in the `schema-extraction-source` project memory
   (parse all `Data/**/*.rules` → `validateSchema` → expect 0 warnings). New warnings mean a
   mis-modelled type to fix here (e.g. an enum-like over-fire, or a discriminator collision).
2. Re-run the server tests: `cd server && npm test`.

## How it works (high level)

- `[ReflectiveSerialization]` class → a schema type; its `[Serialize]` members → fields
  (name via `Alias`, `Optional`, `DefaultValue`, plus inline ctor-IL defaults).
- `[SerialBaseType(TypeFieldName="Type")]` → a registry; `[SerialDerivedType(TypeName=…)]` → its
  members (the `Type=` vocabulary).
- **Custom-constructor reads** → many classes read extra OT keys in a `[GenericConstructor]` via the
  generic reader (`reader.TryReadFromPath<T>("Name")` / `ReadFromPath<T>` / `ReadOptionalFromPath<T>`).
  The extractor scans the method **IL** for those generic calls and recovers each field's name (the
  literal string) and type (the generic argument) — so a class read by a custom constructor contributes
  its fields with no hand-curation.
- C# field type → value kind (enum/reference/group/list/number/asset/…); a small curation table
  handles engine value types (assets, `Range<T>`, `Angle`, enum-like structs like `Direction`).
- Reachability prune from `Cosmoteer.Data.Rules` drops non-`.rules` serialization (multiplayer
  input, runtime object refs) that shares the same `[Serialize]` attribute.

> Note: `[ObjectTextConstructor]` ctors are mostly deserializer *plumbing*
> (`ObjectTextSerializer`/`IOTNode`/`ProgressTracker`), not schema — guarded against so `Modifiable*`
> types don't mis-map.
