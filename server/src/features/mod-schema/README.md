# Code mod schema

Reads the `.rules` schema surface a **code mod** adds, directly out of the mod's own `.dll`.

## Why

A code mod ships a .NET assembly declaring new serializable types: part components, bullet
components, hit effects, each with its own `Type=` discriminator. The game loads them exactly like
its own, so the mod's `.rules` files legitimately write `Type = DroneLaunchController` and a field
set the shipped schema has never heard of. Before this, every one of those was reported as an
unknown discriminator or an unknown field, which is a false positive on content the game accepts.

`tools/schemagen` already knew how to extract a mod's assemblies (its `--mod` flag), but it is a C#
tool run offline against the game install. A mod's assembly only exists on the user's machine, so
the same extraction has to run there, and requiring a .NET runtime for it would be a dependency
nothing else in the language server has. So the extraction is ported to TypeScript here, on top of a
metadata reader that parses the assembly itself.

## Layout

| file                  | what it does                                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| `dotnet-metadata.ts`  | ECMA-335 plumbing: PE sections, the CLI header, the `#~` table stream and the `#Strings`/`#Blob`/`#US` heaps |
| `dotnet-assembly.ts`  | the object model over those tables: types, fields, properties, methods, custom attributes, IL       |
| `extract.ts`          | the schemagen port: participation, registries, value-type mapping, field emission, reachability prune |
| `xml-docs.ts`         | the author's own `///` doc comments, from the XML doc file beside the assembly                       |
| `workshop-link.ts`    | the mod's Steam Workshop page, recovered from the path Steam unpacked it into                        |
| `mod-schema.ts`       | discovery, the on-disk cache, and the build the server calls at startup and from the command        |
| `watch.ts`            | the file watch that re-runs the build when an assembly or its doc file changes                       |

The merge itself lives in `document/schema/schema.ts` (`extendSchemaWithMods`), which is additive
and game-first: a mod can add a type or a discriminator, never redefine one, so a broken or hostile
assembly cannot turn valid vanilla content into diagnostics.

## Resolving game types

This is the one deliberate difference from schemagen. That tool has `Cosmoteer.dll` open and
resolves every reference into it. Here the **shipped schema plays that role**: it already describes
every game type under the same FullName, records each type's `extends`, and names every registry. So
a mod class extending `OperationalPartComponentRules` finds its registry by walking the shipped
schema's own `extends` chain, and a field typed as a game class is answered from the shipped types.
Nothing about the game assemblies is parsed at run time.

A reference the shipped schema does not know degrades to an `opaque` value. That costs completion
detail on that one field and never invents a rule that could flag a valid file.

## Documentation

The game's field prose is community-maintained in `docs/fields/*.md` and keyed by game class, so a
mod class gets none of it, and nobody is going to hand-write docs for someone else's mod. The mod
author already has the right place to put it though: their own C# source.

```csharp
/// <summary>How many drones the bay can hold at once.</summary>
[Serialize(Optional = true)] public int BayMaxDrones = 6;
```

With `<GenerateDocumentationFile>true</GenerateDocumentationFile>` the compiler writes that summary
to `<assembly>.xml` beside the `.dll`, and `xml-docs.ts` reads it onto the extracted field, so it
shows up on hover and completion in the mod's `.rules` files. Same rendering as schemagen applies to
`Cosmoteer.xml` (crefs to short names, `Gets or sets whether …` to `Whether …`), pinned by the second
oracle test below. A mod without the documentation file simply gets no prose, everything else works.

The doc pass runs **after** extraction, in `mod-schema.ts`, so `extract.ts` output stays directly
comparable to schemagen's (which writes prose to a separate seed file, never into the schema).

The one place the OT name and the C# member name diverge is an aliased member, so the extraction
records `memberNames` for the doc lookup to bridge.

## The hover footer

A schema hover ends with a link to whatever documents the field's owning class. For a game class
that is the specialized modding-wiki page; for a mod class the wiki documents none of it, so the
mod's own Steam Workshop page is linked instead, by its manifest name:

```
BayMaxDrones: int · default 6
[Drone Tender on the Steam Workshop ↗]
```

The published file id is the folder Steam unpacked the mod into
(`workshop/content/799600/3768401176/`), which is the only place it is recorded on disk. A mod being
developed locally has no published id and gets no link, which is right: there is nothing to point at
yet. The gate is on the class the group resolves to, so a *game* class written inside a modded group
(a `BeamHitEffects { … }` block) keeps its wiki link.

## The decompiler hover link

`features/hover/decompiler-link.ts` (the opt-in `decompiler.showInHover` power-user link) resolves
its target assembly through `modAssemblyOfClass`, so a mod class opens from the mod's own `.dll`.
Extraction records `assemblyOf` per type for exactly that. Without it the link sent every class to
`Cosmoteer.dll`, which does not contain a mod's types at all.

## Keeping the two in sync

Two implementations of the same rules drift silently, so
`server/test/features/mod-schema/extract.oracle.test.ts` pins them: it runs `schemagen --mod` over
the same assemblies and requires byte-equal types, enums and discriminators. It self-skips without a
Cosmoteer install, the .NET SDK, or an installed code mod, and reuses a generated oracle keyed by
the assemblies' timestamps.

Point `COSMOTEER_MOD_SCHEMA_ORACLE` at an existing schemagen output to skip the generation step:

```bash
cd tools/schemagen
dotnet run -c Release -- "<Cosmoteer/Bin>" /tmp/oracle.schema.json --mod "<the mod .dll>"
COSMOTEER_MOD_SCHEMA_ORACLE=/tmp/oracle.schema.json npx vitest run test/features/mod-schema
```

When the extraction changes, the workshop false-positive guard
(`server/test/document/schema/schema-modscan.mods.test.ts`) is the other side of the contract: it
validates every installed mod with the extraction applied and must stay at zero unexpected findings.

## Where a code mod can be

Three roots are searched, because all three hold mods the game loads and the edited files name:

- every open workspace folder — the mod being developed;
- the installed workshop tree (`workshop/content/799600`) — a subscribed mod, which the user is
  usually *not* editing, and which is the common case: someone writing
  `Type = DroneLaunchController` in their own mod against a mod they merely have installed;
- the user's own `Mods` folder (`<user data>/<steam id>/Mods`, plus the same path inside a Proton
  prefix) — a hand-installed mod, just as loaded as a subscribed one.

## Cache

Extraction is cached under the OS-local app data directory, keyed by the running server build and by
every contributing assembly's path, size and mtime — **and by the size and mtime of the XML doc file
beside it**, since that file's prose is part of the extraction. Without the doc stamp, adding
documentation next to an unchanged assembly changed nothing the key looked at and the stale, prose-
less extraction stayed hot. A session with unchanged mods merges the cached result with no assembly
read at all.

## Staying in step with disk

A merged extraction only prevents unknown-discriminator false positives while it matches the
assemblies. A mod installed, updated or rebuilt after startup would leave it behind, and every
`Type=` the new build added would be reported as invalid on content the game accepts — so the
assemblies are watched and the build re-runs itself:

- inside the workspace, by the client (the server registers a `**/*.{dll,xml}` watcher alongside the
  rules and asset ones);
- outside it, by `watch.ts`: the directory of each discovered assembly, for a mod updated in place,
  and each search root, for a mod installed or uninstalled. Non-recursive on purpose — a recursive
  watch of the workshop tree would fire for every file of every installed mod, and both events that
  matter are one level below a directory already watched.

A refresh trusts the cache (the changed file's stamp no longer matches, so its build misses anyway)
and compares `modSchemaSignature()` before and after, so an event that changed nothing relevant
costs a stat sweep instead of invalidating every diagnostic, hover and inlay cache in the session.

`cosmoteer.buildModSchema` remains the manual escape hatch, and still forces a re-read: it is what
picks up a mod rebuilt without its timestamp moving.

## The switches

Two settings, both on by default, both live (no restart):

| setting | off means |
| --- | --- |
| `codeMods.enabled` | no discovery walk, no assembly read, nothing merged — and an already-merged extension is unmerged on the spot. The user gets exactly the shipped schema, which also means a mod's types are reported as unknown again. The command reports `disabled` rather than silently re-enabling the feature. |
| `codeMods.autoRefresh` | the startup merge still happens, but nothing is watched; the command is the only way to pick up a change. |

The point of the first one is that "off" is free, not merely quiet: the walk is the only recurring
cost of the feature, so it must not run for a user who does not want it.
