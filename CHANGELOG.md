# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

### Added

- Writing `Flammable` on a part now hints that the game removed the field and points at the replacement: fire immunity is the `non_flammable` part category (`TypeCategories = [non_flammable]`). Hover on the field shows the same migration, and the remove quick fix deletes the dead line.

## 0.5.0 Beta

### Added

- Fields the game ignores now fade out instead of carrying an underline. The whole assignment greys, value included, matching what the remove quick fix deletes.
- A field written at the game's own default now fades the same way, with a remove quick fix. Only fields inside groups that do not inherit are faded, since an explicitly written default can deliberately override a base's value. Turn it off with `cosmoteerLSPRules.diagnostics.validateDefaultValues`.
- Field-name completion now works while typing. A partially typed name (`Ig` inside a sound effect) used to return nothing on every keystroke, so the suggestion popup only ever appeared on Ctrl+Space at an empty line. The typed prefix now gets the same field suggestions and the fully typed name no longer vanishes from the popup at its last character.
- Groups inheriting a whole file (`: /BASE_SHAKE`, whose macro aliases a rootless fragment carrying `Type = ScreenShake` at the file's top level) now know their class, so completion and hover work inside them like in any typed group.
- Field hover now follows cross-file inheritance: hovering `Volume` or `RampUpTime` inside a `: /BASE_SOUNDS/AudioExterior { … }` group shows the field's schema signature, where before only same-file bases resolved.
- Files that enter the game only through mod.rules actions now get full intelligence from the action's target: an `AddMany` or `Add` fragment types as the target list's element, an `AddBase` fragment as the target's own class, a whole-file `Overrides` fragment as the target file's class, and inline action values (`ToAdd { … }`) complete, hover and validate inside the manifest itself. Action entries also learned the game's optional `Index` field, and `<./…>` targets outside `Data` now resolve against the install root like the game does.
- Hover and completion on a group-typed field now show a generated `{ … }` example next to the type name: the `Type =` discriminator for a polymorphic slot, the required fields with placeholder values, and a count of the remaining optional fields. A `Modifiable` field shows both its scalar and group forms.
- Lists of ids and enum values show an inline example too: a `PartCategory[]` field renders `TypeCategories = [ftl, ...]` with a comment naming the entries, and a `list<enum>` field lists the legal members in its signature (capped with a total for very large enums).
- Asset fields show their written form: an `asset (shader)` field renders `Shader = "effect.shader"` with a note that the path resolves relative to the declaring file, with matching sample extensions for image, sound and font assets.
- Positional-form types show their inline list the way the game's files write them: a `Color` field renders `VertexColor = [255, 255, 255, 255]  // R, G, B, A` with the named-color and `{ Rf Gf Bf Af }` group alternatives, and a `Vector2` renders `= [0, 0]` with its `{ X, Y }` alternative, both as the field's own example and as placeholders inside bigger examples.
- Color swatches and the color picker now also appear on the positional list form (`VertexColor = [255, 255, 255, 217]`), the form the game itself saves. Detection is schema-typed, so a four-number rect never gets a swatch.
- A group whose `Type=` uses a pre-rename name (`Type = AmmoDrain`, now `ResourceDrain`) no longer goes dark: hover, completion and validation inside the group work through the current class, while the rename hint and its quick fix stay on the `Type =` line.
- Shared munition fragments inherited through a mod's convenience globals (`BeamEmitter : &/SW_SHOTS/…/Beam_name`) now root to the inheriting component's class, so hover, completion and validation work inside them. Previously such a group was dark or mis-typed by its legacy `Type =` line.
- A `Range` field written in its group forms now resolves: `Speed { BaseValue = … }` reads as the element's group form, and the `{ Min = …, Max = … }` and `{ Value = … }` keys type as the range's element, so a background's `TwinkleAddColor` colors get hover, validation and swatches.
- Fragments inherited through a same-file alias (`BASE = &<shots.rules>/Shot` then `Bullet : &BASE`) now root to the deriver's class, the dominant macro idiom in shot mods.
- Font definitions are a modeled group now: `DefaultFont { File Passes [ { Effects [ … ] } ] }` completes and validates, including the font-effect `Type = Blur/Color/OuterStroke` registry with each effect's fields.
- Cursor groups are modeled: `{ File, HotSpot, Scale }` or `{ OSCursor = Arrow }` complete and validate with the full OS-cursor vocabulary, instead of being mistaken for textures.
- Sound groups accept their custom-read keys: `Sound = "x.wav"`, `RandomSounds` and `Db` now complete and validate beside `Sounds`/`Volume`/`Speed`.
- A part's and a bullet's `Components` map is typed now, so every component knows its registry from the slot alone. A partial override fragment whose only component carries no `Type=` still gets completion, hover and `Type=` validation.
- Shader values written in group form (`Shader { File = "…" }`) resolve to the shader group class with `File`/`VertexEntryPoint`/`PixelEntryPoint` completion, like the texture group form.
- A base that is both a typed slot and an inheritance base (vanilla's `FollowCommand`) now resolves to the slot's class when it fits best, instead of a shallow common ancestor of its derivers.
- Hover and validation now follow same-file inheritance: a component deriving a sibling template (`BulletEmitter : ~/EMITTER` or `X : SiblingName`) knows its class everywhere, not only in completion.
- Classes that embed a group member with an empty alias (network components' filter, widget sprites, name-generator entries, 21 engine classes in all) now inline that member's fields, so `Categories` on a network component or `File` on a widget icon completes and validates.
- Maps written in their entry-list form now type their entries: `Upgrades [ { Old = … New = … } ]` resolves `Old` and `New` (or the engine's default `Key`/`Value` spellings) to the map's key and value types.
- The codex tip and lore container files root as the codex class, so the pages they inline get full completion, hover and validation.
- Fixed a deep include (`Delay = &<base_ship.rules>/FtlEffects/TotalDuration`) mis-typing the whole `FtlEffects` group of the included file as a time value.
- Shader-constant validation accepts a constant declared by a sibling variant of the material's shader family (`X.shader` beside `X_diffuse.shader`), fixing false warnings on vanilla's construction materials.
- Types nested under generic classes resolve concretely: a background or planet texture generator's gradient `Colors [ { Color … Position … } ]` and `Interpolate` complete and validate (with color swatches on the stops) instead of being opaque.
- The game root `cosmoteer.rules` and the loading screen file root to their classes, so their top-level groups (`Game`, `Simulation`, `Roles`, the loading `Background`) get completion, hover and validation.
- Wrapper classes that dispatch their value through an embedded polymorphic member resolve to whichever side fits the written fields: a stat widget's `Type = StatBar` group gets `StatBarRules`' fields, a designer brush keeps its wrapper's `NameKey`/`Icon`, and a name-generator entry dispatches its `Type = Markov`.
- Fields the game declares but provably never reads (`FireDamageFactor`, `PathfindRadius`, `SupplierSearchInterval` and 27 more) now get the dead-field hint with a remove quick fix. The set is extracted straight from the game's code by the schema generator, so it follows game updates instead of a hand-kept list.
- A group whose unread fields outnumber its real ones now still gets the ignored-field hints when its slot and its `Type =` agree on the class: a beam media effect carrying legacy fields like `ExtraEndLength` and `ThicknessOverIntensity` reports every one of them instead of staying silent.
- Macro-alias container files (`COMMON_EFFECTS = &<common_effects.rules>`, `PRIORITIES = &<priorities.rules>`) now root their members from the slots that read them: a `&/COMMON_EFFECTS/PowerOn` usage in a media-effects field types the container's `PowerOn` list, so hover, completion and validation work inside the container itself.
- A mod's own convenience containers get the same treatment: the manifest actions that add a named member to `cosmoteer.rules` and merge container files into it (`Name = SW_SHOTS`, `OverrideIn = <cosmoteer.rules>/SW_SHOTS`) declare the macro, and every `Bullet = &/SW_SHOTS/redlasershot` style usage types that member of the mod's container file.
- Deep container paths type their leaf now: a `&/SW_PARTICLES/Shot/Laser/Hit/Med/Blue` usage in a media-effects slot types the nested `Blue` prefab where it lives, so its entries get completion, hover and validation. The folder-like groups along the path stay untyped, since the game gives them no class.
- Overclock shot fragments root fully now: a bullet file whose macro anchors outnumber its real fields still roots (the flak field), a member-qualified macro base (`BEAM = &<overclock.rules>/Beam` inherited via `~/OVERCLOCK/BEAM`) roots the named group from its deriver, and a `~/NAME` base naming a top-level macro that points at a component resolves through it (the chaingun beam).
- A component base file whose deriver's `Type` comes through the inheritance itself now roots by dispatching its own top-level `Type =` in the deriver's slot registry: parts deriving `BlueprintWalls : <blueprint_walls.rules>` root the walls file as its blueprint-sprite class.
- Field documentation for the most-modded gameplay and GUI classes, written from the game's own code: parts, ships, crew, weapons, beams, bullets, resources, the data root, and the widget, game, build, resource, sim, crew, menu, missions and galaxy-map GUI rules.
- A reference to a group with a `BaseValue` member now shows that value as an inlay hint: `Arc = &~/Part/Components/ArcShield/Arc` renders `/BaseValue = 160d` after the reference. Toggleable via the new `inlayHints.showBaseValue` setting, on by default.
- The `Modifiers` entries of a `BaseValue` group are now fully understood: `Type =` completes with the twelve modifier kinds the game knows, each entry's fields complete, hover and validate, and a typo gets the usual did-you-mean fix.
- Per-direction crew speed groups (`CrewSpeedFactor { Left Right Up Down }`) now complete and validate, alongside the bare single-factor form.
- `effect_buckets.rules` completes its five bucket-list fields, and a sysgen `ConvertTypeStage`'s `Conversions` entries complete `From`/`To` with part-id navigation.
- Types the game reads only through a hand-written deserializer, such as the `Dashes` entries of a GUI circle renderer, now complete and validate too.
- Hover on a dual-form field now says so: a `Modifiable` field reads `number | ModifiableValue group` instead of just `number`.
- Interactive part grid editor. An "Edit part grid" CodeLens on every `Part` opens a visual editor that shows the part's sprites split into the in-game cell grid.
- Clicking the grid authors the per-cell fields instead of hand-typing coordinates: allowed door locations, blocked travel cells, walls per cell edge, crew destinations, virtual internal cells, `PhysicalRect`/`SaveRect` and `Size`.
- Every click writes the change to the `.rules` file immediately and undoes with the normal editor undo. Values inherited from a base part render as ghosts until the first edit overrides them.
- The editor view can be rotated and flipped to preview other orientations, and the rotation fields (`IsRotateable`, `IsFlippable`, flip mappings) are editable from the sidebar.
- The editor also covers the component geometry: `Location` and `Rotation` gizmos, collider vertices, network ports, resource grid rects, prohibit rects, buff areas, tile score lines, storage points, airlock and button positions, railgun segments and the `AllowedContiguity` flags.
- Edge-distance regions like the heat exchanger's heat absorption area draw as a halo around the part, and dragging the boundary sets how far the region reaches.
- The part grid editor is also available in the JetBrains plugin as a tool window, with a gutter marker on `Part` lines.
- References into other workshop mods now recommend the `<./Data/../../../workshop/…>` game-root form, with a quick fix that rewrites the path.
- A `mod.rules` manifest can build its `Actions` list from other files' action lists (`Actions: &<launcher.rules>/Actions`). Those included files are now validated like the manifest itself.
- A file pulled into a manifest's `Actions` by reference now counts as reachable content, so it and the parts its actions add are no longer reported as unreachable.
- `^/N` references into a base that a mod's `AddBase` action appends now resolve, so go-to-definition, hover, completion and validation give one consistent answer.
- Reference-path completion now completes the segment at the cursor, so editing a middle segment of a long path offers that segment's members.
- Reference-path completion now matches member names case-insensitively, like the game.
- References to a member a mod's action merges into a game node (a nested `Overrides`, or an `Add` with a `Name`) now resolve in go-to-definition, completion and validation.
- The virtual-inheritance `:` path segment now resolves to the derived versions it selects: go-to-definition on `&Base/:/Member` jumps to every inheriting group's value, and completion after `:/` offers the members the deriving overrides supply.
- The shader preview now runs the real per-vertex math of ship part, roof, wall, crew and indicator shaders, including the atlas sprite animation, instead of a generic stand-in quad.
- Shaders that sample the engine's screen targets (`_diffuseTarget`, `_normalsTarget`, `_stencilTarget`, `_capturedBackBuffer`) render against plausible stand-ins instead of going black or blank.
- Crew shader previews render with shirt, skin and hair colours, and the include-library base shaders (`base.shader`, `base_particle.shader`, …) preview their default pipeline instead of failing.
- The preview renders on WebGL2 when available: real explicit-LOD sampling and texture-size queries, Min/Max blend modes, and repeat wrapping and mipmaps for non-power-of-two textures.
- More engine-fed constants start at their in-game values in the preview controls (`_shipBounds`, roof opacity and colours, specular shape, interaction clocks).
- Engine clocks now animate in the preview the way the game drives them (blueprint flicker, planet rotation, GUI highlight sweeps, the crew animation clock), each with an "auto" toggle.
- Preprocessor completion in `.shader` files: directive keywords after `#`, macro names in `#ifdef`/`#if defined(…)`, guard names after `#define`, and paths inside `#include "…"`.
- Hover on preprocessor macros: engine feature-level gates are explained, defined macros show their replacement, and guards tested by an included base shader explain the define-before-include pattern.
- A numeric `MipLevels = N` on a texture now caps the preview's sampled mip chain at N levels, like the engine.
- Preview sliders fit their range, step and precision to the written value, so a tiny constant like `_midTexScale = 0.0005` no longer shows as `0.00` or snaps to a coarse grid.
- Full mXparser operator support in `.rules` math: modulo `#`, tetration `^^`, the boolean families (`&`, `&&`, `~&`, `|`, `||`, `~|`, `(+)`, `-->`, `<--`, `<->`, `-/>`, `</-`), the binary relations and the bitwise operators. Expressions using them parse, validate and show computed-value inlay hints with the game's exact evaluation order.
- Computed-value inlay hints also cover the `d`/`r` number suffixes: `90d` converts degrees to radians like the game, and results snap to the game's almost-integer rounding (`0.1 * 30` shows `= 3`).
- Part ids are now first-class references: `EditorParentParts` (both the flat and the `[part, order]` spelling) and part-keyed maps like `PartIDTileCosts` complete, with go-to-definition, hover, find-references and rename included.
- Component name completion inside `Components` blocks: ids the part references but never declares are offered as new component names, scaffolded with a `Type =` block. Works in mode fragments too.
- Component ids written in route tuples (`Routes [ [from, to, cost] ]`) now complete and navigate, and an endpoint that names no component gets the missing-component warning with a did-you-mean fix.
- Reference-keyed maps written in the `[{ Key, Value }]` entry form now complete and navigate their `Key` values (a ship's `RenderLayers`, resistances).
- Spawner tags in sector-generation files (`Tags`, `RootLocationTag`, `MinDistanceFromTags`) now complete, navigate to the declaring entry and warn when nothing declares them.
- Part ids that resolve nowhere now warn too. Parts declared by installed workshop mods and `OtherIDs` aliases count, and label fields like `SelectionTypeID` are never checked.
- Damage-type keys (`DamageResistances { fire = … }`) now complete with every damage type the project's hit effects deal plus the engine's built-in ones, and navigate to the declaring `DamageType = …`.
- A resistance key naming a damage type nothing deals now gets a warning with a did-you-mean fix, since such an entry silently never applies in game.
- Scalar trigger and toggle references (`FireTrigger = Turret`, `AutoOffTrigger = …`) now complete with the part's component ids, jump to the component and warn when the component is missing.
- The group spelling's inner `TriggerID`/`ToggleID` completes with the engine's registered trigger and toggle provider names (`HitIntervalElapsed`, `IsRunning`, …).
- Mods that write rules content in `.txt` files are now fully indexed: declarations in `.txt` complete, validate and navigate like `.rules` files, and `<file.txt>` references resolve.
- Sparse override-patch files (a `Part { }` a manifest action merges into a vanilla part) now resolve their component references against the merged result, removing false missing-component warnings.
- Go-to-definition on component ids now works part-wide: a component declared in an inherited base part, an included components block or an override target resolves across files.
- The engine's hardcoded ids (runtime spawner tags, crew-job component ids like `ConstructionTracker`, the built-in damage types) are known, so they never flag as unresolved.
- An unknown id the base game's own files also reference stays quiet, so a new game version's leftovers never produce false warnings while a modder's typo still flags.
- Cross-file id validation now covers every id class: buffs, resources, statuses, editor groups, doodads, factions, career techs, nebula types and part features validate alongside the existing kinds. Ids declared by dependency mods count everywhere.
- Reference lists nested inside tuple slots (the career map picker's faction candidates) resolve, complete and navigate too.
- Resource ids now complete inside a part's cost tuples (`Resources [ [bullet, 20] ]`), with go-to-definition, hover, find-references and rename.
- Component id completion is now part-wide: `OperationalToggle = ` and `ComponentID = ` offer every component the part declares, including ones from inherited base parts and include-merged `Components` blocks.
- Fields the game ignores now get an editor hint with a remove quick fix, such as a leftover `Filename` on a `ValueCurve` that the game silently drops. Toggleable via `diagnostics.validateIgnoredFields`.

### Changed

- Reopening a project is about 30% faster to become fully usable. The mod-action indexes used to read and parse the whole mod folder once each. They now share one pass over it.
- Whole-workspace validation is several times faster on mods that reference ids from other installed mods, and the repeated "Indexing mentions" popups during validation are gone.
- Id existence checks for dotted ids (`cosmoteer.rock_1x1`, faction-prefixed part ids) no longer read every file in the project.
- Whole-workspace validation is about a quarter faster. Working out which class a group is no longer rebuilds the group's member list once for every field in it.

### Fixed

- A `.txt` file no rules file references is no longer parsed as rules, so the game's own `credits.txt`, the roof-decal whitelists, readmes and stale backups stop filling the Problems panel with parse errors. Mods do keep real rules in `.txt` files, so any `.txt` something pulls in through an include, an inheritance base or a mod action still validates as before.
- An id a mod creates from its manifest is no longer reported as unknown. Such an id is written in no `.rules` file of the mod, so every use of it was flagged. The action's target now says the name is a declaration, in every shape a manifest uses: an `Add` that names the new member, an override that creates one with `CreateIfNotExisting`, and a whole-file or single-member override that merges the mod's own copy of a collection (its buffs, its editor groups) over the game's. Those ids now also autocomplete.
- A components fragment that another part pulls in (`Components : <wire_stuff.rules>/Part/Components`) now resolves its component ids against that part. The fragment brings the wiring and the part brings the components it wires, so judging the fragment on its own flagged every id the part supplies.
- Built-in ship ids are now checked. A ship declares no `ID`: the game composes it from the ship's filename and the declaring file's `IDPrefix`, so nothing was ever harvested and every `ShipID` went unvalidated. A trade ship that names a ship the builtins file does not declare under that id is now flagged with a did-you-mean fix, which catches the crash a mod hits when its civilian builtins file carries an `IDPrefix` its `ShipID`s omit.
- A list inheriting a cross-file list (`Ships : <faction_ships.rules>/Ships`) now roots that base file, so a mod that fans its ships out over per-category files gets completion, hover and validation in all of them instead of leaving them silently unvalidated.
- Effect-bucket names are now checked. A bucket exists only by being named in `effect_buckets.rules` (`LowerBuckets [ BulletLower1, … ]`), a shape nothing harvested, so every `Bucket`/`RenderBucket` reference in the game went unvalidated. A bucket the file does not name is now flagged (a bare `RenderBucket = Upper` where only `Upper1`…`Upper5` exist).
- Files the game root pulls in through a list of file aliases (`Ships [ &<ships/terran/terran.rules>/Terran ]`) now root. The forward alias walk only followed `Field = &<file>` assignments, so ships, sectors, background styles, doors and mission categories were unrooted and their ids unchecked. A mod referencing a ship or sector that does not exist got no warning.
- Bullet target categories and blueprint network signals are now checked. The category a bullet writes (`TargetCategory = laser`) is what brings it into existence, so the lists that reference it (`OnlyBulletCategories`, `AccelerateTowardsBulletCategories`, `ValidSignals`) are now validated against the categories the project actually declares. This catches a bullet id passed where a category is expected, which silently does nothing in game.
- Planet styles and part-network route lines are now checked: their ids are the keys of a collection inside a whole-file-aliased fragment (`Styles { alien = … }`), which the id harvest could not see.
- Bullet component references are now checked against the bullet that owns them, the same part-local check a part's components get. They are not global ids: a bullet's components are named per bullet, so one bullet's `DamagePool` must not vouch for a reference in another bullet that has none. A reference to a component the bullet does not declare is flagged with a did-you-mean fix.
- Component references written outside a component group are now checked too: an indicator's `Toggle`, a converter's `From [ { Storage = … } ]`, a weapon's `AutoTargets`, a multi-toggle's `Toggles = [ … ]` list and the part's own `SignificanceToggle`. Only references sitting directly in a component were checked before, so a wire to a component that was renamed, commented out or never brought along stayed silent.
- Ship render layers, ship AIs, mission metatypes and the other ids a map declares through its keys are now checked wherever they are used (`Layer = "indicators"` on a part sprite, `AI = trader` on a trade ship). The key that declares an instance is still never flagged, so adding one stays free.
- Ids a mod declares by adding entries to a map from its manifest (`AddTo = "<…>/RenderLayers"` with a `ManyToAdd` of `{ Key = … Value { … } }` pairs) are now recognized as declarations, and the entries themselves get completion, hover and validation from the map they land in.
- Encounter files root on their folder, so a new encounter gets completion, hover and validation before it is wired into a sector. Previously a file nothing referenced yet stayed dark.
- Deriving a nested group (`… : <file>/AttackCommand/Circle`) no longer mis-types the whole top-level group as the nested class, which broke hover and completion in vanilla's command files.
- Completion with the cursor directly behind a group's closing `}` now offers the surrounding container's suggestions instead of leaking the just-closed group's field names.
- Path completion in game-root references now accepts any casing of the `<./Data/` prefix.
- File extensions in paths and asset values now match with any casing, like the game's own file loading: `<Foo.Rules>` references resolve, `sound.WAV` values classify as assets and uppercase-extension files appear in completion.
- Completion now works inside cross-mod workshop references: after `&<./Data/../../../workshop/…/file.rules>/` the target file's members are offered and nested paths drill in.
- Accepting a completion whose snippet lands the cursor at a value slot (a scaffolded `Type = `, an enum or a component reference) now reopens the suggestion popup there.
- An empty completion answer is now marked incomplete, so typing further brings the suggestions back instead of the popup staying empty until closed and reopened.
- An in-progress empty field (`Type = ` with the value not yet typed) no longer desyncs the parser and breaks every suggestion, hover and diagnostic in the container. The empty value now parses as an empty field, like the game.
- Syntax highlighting no longer misreads bare identifiers: a dotted string id like `flash.laser_blaster` colours as a value, asset paths colour as strings, and keys, group names and references written inside quotes (`AddTo = "<…rules>/Path"`) all colour correctly.
- Percentages (`50%`, `-0.6%`) and `Infinity` now colour as numbers instead of plain values.
- A quoted all-digits value like `SituationCode = "0000"` is treated as text, keeping its leading zeros.
- Division glued to a subtraction inside a list expression (`[4*166/64-0.6, …]`) is no longer misread as a reference and falsely reported as unresolved.
- Enum field hovers show the default as the member name instead of its raw number (`AllowedContiguity` default `Sides`, not `170`), decomposing flag combinations without a single name (`Ships, Parts`).
- A handful of schema defaults declared via attributes rendered as `Mono.Cecil.CustomAttributeArgument` in hovers. They now show their real values.
- The boolean `&` operator between parenthesized operands (`(&A) & (&B)`) parses as part of the value instead of producing a bogus `Unknown function "&"` error.
- A quoted expression argument like `ceil("(&A) / (&B)")` is no longer flagged as an invalid argument type.
- Function-call validation no longer runs in language-strings files, where text like `Desejado(s)` was misread as an unknown math function.
- "Asset not found" is no longer reported for a field the game ignores, such as the vanilla reactor shockwaves' `Filename`.
- The ignored-field hint no longer flags a wrapper-read field like a stat widget's `ToggleButtonID` in a fragment file wired in through mod actions, where the wrapper class that reads it is invisible to the resolver.
- The HLSL `%` operator, `isinf`, integer locals and `(int)` casts of function calls now translate to GLSL, fixing the crew shader preview silently falling back to a plain textured quad.
- Shader `#if defined(…)` conditions are now evaluated during preview preprocessing instead of being ignored.
- The stand-in vertex tangent no longer zeroes the normal map's x channel in lit shader previews.

## 0.4.1 Beta

### Added

- Incremental text synchronization. Only the changed range of a document is sent per keystroke.
- Pull diagnostics answer with `unchanged` when nothing was edited since the last request.
- Semantic token deltas and range requests, so only the changed slice of the token array is sent after an edit.
- Large completion lists are narrowed to the typed prefix, and documentation is resolved lazily per selected item.
- Validation of bare valueless fields (`ScaleIn` with no `=`) when the game cannot read them as null.
- Positional list-form values (`BaseSize = [7.2, 7.2]`) now get validation, hover and completion, including nested entry lists like `EditorParentParts`.
- Validation of values the game silently never reads: unknown members inside a group-typed field's list form, extra list elements and value shapes the field cannot read. Legal dual forms stay silent.
- Bare `&…` reference list elements are now validated like any other reference.
- A bare `&…` reference in group or document position is now a parse error, like in the game.
- A warning when a list element name and its body share a line without a separator, since the game reads the whole line as one text element. A quick fix removes the name.

### Changed

- The extension and language server now ship as native ES module bundles (`.mjs`). No functional change, unlocks ESM-only dependencies going forward.
- Faster cold and warm starts through more caching and less re-parsing, while keeping everything up to date when files change.
- Startup no longer reads the whole project twice: the find-all-references word index is built during the main project walk instead of its own read pass.
- Startup index builds share one file-system sweep instead of each walking and statting the same folders.
- The persisted word index is about half as large and loads faster.
- Whole-workspace validation results are persisted across restarts. Reopening an unchanged project restores all problems in under a second instead of re-validating every file.
- Reinstalling or rebuilding an identical server no longer invalidates the startup caches.
- The server logs startup and validation timings to the output channel.
- Whole-workspace scans reuse per-file results and skip unchanged files.
- On-disk files are validated through the same path as open documents.
- Fewer lexer token allocations and reduced GC spikes.
- Typing only invalidates the caches that actually read the edited file, instead of wiping them on every keystroke.

### Fixed

- Automatic Cosmoteer detection now finds installations in secondary Steam library folders.
- Automatic detection now also works on Linux and macOS, including Flatpak and Snap installs.
- A wrong or unreadable detected path now shows a warning instead of a stuck progress notification.
- Field-name completion no longer re-offers fields already written in their bare form and no longer suggests positional digit fields inside `{ }` group form.
- Completions inside `[ … ]` no longer offer the outer group's field names. A list position now completes as what its elements are.
- Effect lists on group-typed fields (`HitEffects [ … ]`) now carry full schema intelligence, with completion and validation inside each element.
- A crash in the document symbols caused by a `[`.
- A parser problem when continuing a math expression.
- Whole-workspace validation no longer leaks problems from out-of-scope files into the Problems panel.
- Reference false positives from files validated while the game data was still loading no longer stick until the next edit.
- Go-to-definition on the inheritance reference of an empty group (`Components : ^/0/Components { }`) did nothing.
- An identifier element in a list followed by a body or inheritance on a later line was wrongly glued into one named container, deviating from the game.

## 0.4.0 Beta

### Added

-   Code formatting for `.rules` and `.shader` files (Format Document, VS Code and JetBrains). The `.rules` formatter changes whitespace only (indentation from nesting, spacing around `=`, `:`, `,` and brackets, trailing whitespace, blank-line runs) and verifies that the result lexes to the identical token stream, otherwise it changes nothing. Controlled by `formatting.enabled` (default on) and `formatting.formatOnSave` (default off).
-   Schema intelligence for `.rules` files. A schema of every `.rules` type (field names, value types, required/optional, defaults, enums, polymorphic `Type=` registries) is extracted from the game's own classes, including the Halfling engine types, and ships with the extension. It powers:
    -   Field-name completion with type, default and enum documentation, inserted as ready-to-fill snippets, including inherited base-class fields
    -   Value completion for `Type=` discriminators, enums, booleans, sibling component references and cross-file `ID<…>` references, with auto-popup after `=`
    -   An "Insert N required fields" completion that scaffolds all missing required fields at once
    -   Validation of invalid enum values, booleans, `Type=` discriminators and non-numeric or fractional values in numeric/integer fields, each with a "Did you mean …?" quick fix
    -   Hover showing a field's schema signature, the class a `Type=` selects and what a reference resolves to
    -   A document outline annotated with each group's resolved schema class
-   Missing-required-field validation (`diagnostics.validateRequiredFields`), checking the full inheritance chain so a field supplied by a base never counts as missing
-   Cross-file `ID<…>` reference intelligence (completion, go-to-definition, find-references, rename, hover) for whole-file root entities, list-element entities (factions, GUI toggles/colors/targeters/triggers, techs, encounters, ship doors and more), group-name-keyed entities (buffs, part features), map keys and references inside lists and math expressions
-   Validators for component references (`validateComponentReferences`), cross-file GUI ids (`validateCrossFileReferences`), shader constants (`validateShaderConstants`), shader code (`validateShaderCode`) and localization keys (`validateLocalizationKeys`)
-   Localization-key intelligence for `KeyString` fields (`NameKey`, …): completion from the declared strings, hover showing the text in every available language, and validation with an insert-into-all-strings quick fix
-   Separator diagnostics: a warning when two fields on one line have no `,`/`;` between them (the game silently reads them as one value) and when a run of numbers is read as a single list element, each with an insert-separator quick fix, plus a subtle hint (`diagnostics.validateRedundantSeparators`) on a separator a line break already makes redundant, with a remove quick fix
-   `.shader` files as a first-class language: HLSL highlighting, semantic tokens, hover for uniforms, intrinsics and file-defined functions, context-aware completion (swizzles, struct members, texture methods, parameters and locals in scope), signature help for intrinsics and the file's own functions, go-to-definition through `#include`s and a document outline. Works in VS Code and JetBrains
-   Live WebGL shader preview ("Preview shader" CodeLens / `Cosmoteer: Preview Shader`): translates the shader's HLSL pixel stage, and its own vertex stage when it defines one, to GLSL, resolves textures, tint and blend mode, exposes every constant as a live control and re-renders on edit, including unsaved edits. Shaders that cannot be translated fall back to a textured, tinted render
-   Shader-constant completion and hover in a material's `Shader = …` block (the `_`-prefixed uniforms the referenced shader declares, typed and with defaults)
-   Mod overview report ("Show mod overview" CodeLens on `mod.rules` / `Cosmoteer: Show Mod Overview`): the manifest's header and actions with target resolution, plus a file-reachability section listing the files the game cannot load, with referencer annotations that separate dead chains from orphaned files
-   Reachability-scoped validation: `diagnostics.workspaceValidationScope` (`allFiles` or `modRulesReachable`) limits the whole-workspace pass to the files the game can load
-   Semantic-token highlighting for `.rules` files: references, bareword enum values, math functions, field names and entity declarations colored by the real parse, identically in VS Code and JetBrains
-   Full `mod.rules` manifest support: parsing, validation (unknown verbs, missing required fields, target existence) and completion for `Actions`
-   Go to Definition, Find All References and Rename across the mod and the game `Data` tree
-   Document symbols (outline, breadcrumbs) and workspace symbols
-   Hover showing the resolved value of a reference, with sprite image preview for assets
-   Inlay hints showing computed math results inline, and evaluation of percentage literals (`50%` resolves to `0.5`)
-   Signature help for math functions with parameter names and active-argument highlighting, plus arity checking for every known function (the full mXparser vocabulary and Cosmoteer's own)
-   Deprecation hints: a renamed type (`Ammo*` to `Resource*`) is flagged with its replacement and a quick fix
-   Particle data-channel intelligence: completion, go-to-definition, find-references and rename for the channels particle updaters read and write
-   Color field support: correct `Rf`/`Gf`/`Bf`/`Af` completion and inline color swatches whose picker rewrites the component values
-   Dual-form support for `Modifiable<T>` fields (scalar or `{ BaseValue … }` group) and grouped `Texture`/`Shader` values
-   Part-category completion, offering every category used across the project
-   Asset-path completion: schema-aware, works on unquoted values and while the path is still being typed, filtered to the field's asset kind
-   "Did you mean …?" quick fixes for mistyped references and asset paths
-   Rooting for fragment files so they get full schema intelligence when opened standalone: alias-based rooting from the game root, reverse-include rooting from the field that includes them, whole-file-root classification, spawner-generator files and `builtin_ships/**`
-   Progress indicators while the project-wide indexes build
-   Optional whole-workspace validation (`diagnostics.validateWholeWorkspace`) and multi-root workspace support
-   JetBrains IDE support, automatic detection of the Cosmoteer installation path, cancellation-token support, inheritance-cycle and duplicate-key detection
-   Virtual-inheritance references (the `:` path segment, e.g. `&:/v_Value`, `&../:/v_Group`): lexed and parsed like the game, resolved for go-to-definition, hover and completion (including the `&:/` starting prefix), and never falsely flagged, since the target may exist only in an inheritor
-   Void fields (a field declared without a value, like vanilla's `v_Faction // VIRTUAL; must be inherited`) are now real named members: reference paths resolve to the declaration and completion offers them
-   Completion for inheritance bases after `:`: sibling and root names from the inheriting group's container (never the group's own members, never the group itself), the `^/N/` extend-own-member idiom and the reference-path prefixes
-   `&/` completion offers the convenience globals the mod itself adds to `cosmoteer.rules` (its own root file or manifest `Add` actions) alongside the vanilla ones, and a path through such a global lists the aliased target's members
-   "Extract value to shared root field" refactoring: a number (including suffixed forms like `50%` or `45d`) repeated across several assignments can be hoisted into a root field, with every occurrence replaced by a reference to it

### Changed

-   All math-function knowledge (names, argument counts, parameters, documentation, evaluation) now lives in a single registry shared by signature help, diagnostics and the evaluator
-   Field names, reference path segments and manifest nodes match case-insensitively, like the game. Enum and `Type=` values stay case-sensitive, also like the game, and a value that differs only in casing gets a dedicated warning with a quick fix. Booleans accept `true/yes/y`, `false/no/n` and `1`/`0` in any case
-   Rename edits are restricted to the open mod, the vanilla `Data` install is never written (opt out via `rename.allowEditingVanillaFiles`)
-   Runtime `~` references and references resolving to runtime values are no longer statically validated
-   Commented-out references no longer count toward file reachability
-   A mod's root `cosmoteer.rules` is no longer seeded into the reachability closure, since the game never loads it
-   Nested manifests (`mod.rules`/`mod_*.rules` in subfolders) are discovered recursively, matching the game
-   Performance: the project-wide indexes build in a single directory walk and warm up in the background, file reads run concurrently, and the reachability computation is about 6x faster

### Fixed

-   Circular-inheritance diagnostics landing on wrong, shifting lines when the cycle closes in another file. The diagnostic now anchors to the validated file's own inheritance reference
-   Members of a map-typed slot resolving their `Type=` in the wrong registry, which gave included component fragments wrong completions and bogus required-field prompts
-   Shader constants written in group form (`_waveTex { … }`) not completing their fields
-   The shader preview failing on functions with HLSL default parameter values
-   A stray `=` reported as a possible parser bug instead of `Unexpected "="`, matching the game's parser
-   A decimal operand glued to a slash (`1.5/2`) lexed as one path-like token, breaking the surrounding math expression
-   A false `Not expected comma` when several fields share one line (`A = 1, C = 2`). `,` terminates a node exactly like `;`
-   A `-` or `/` before a parenthesized group (`7- (12/64)`) glued into a bogus function name
-   A large class of false `Reference name is not known` warnings: file-URI decoding for any drive letter, group-merge globals resolving only their first file, references through a mod's `Overrides` of vanilla files, backslash-separated reference paths, and a startup race that cached an empty game tree
-   The cursor on an element inside a list or group value resolving to the container instead of the element, which broke hover, completion and navigation on list elements
-   Windows backslash paths not recognized by the path-based document-root rules
-   Parser crashes and edge cases: nested function-call arguments, scientific notation, time literals, top-level inline math, EOF handling, empty values, an autocomplete crash on an empty `Key =`, a document-outline range error and the color picker overwriting a group's brace
-   Console log output not respecting the log-level settings
-   Notifications not closing after work done
-   `,` in group inheritance not recognized as a separator
-   `^` rejected anywhere but the first position of a reference
-   References containing a `:` path segment truncated at the colon (`&../:/v_Foo` lexed as `&../`), which broke navigation and completion for the virtual-inheritance idiom the vanilla data itself uses

## 0.3.1 Beta Hotfix

### Fixed

-   Show a notice that VS Code needs a restart when the settings do not appear

## 0.3.0 Beta

### Added

-   Setting for the Cosmoteer workspace path, with an error message when it is not set
-   Validation for non-asset references, assignments whose right side is a reference, parenthesized values and math expressions
-   A new extension icon and a readme for the images folder

### Changed

-   Removed `InheritanceNode`. Inheritance is now a property of the object and array nodes

### Fixed

-   A `""` string starting with `<` wrongly recognized as a reference
-   Documents parsed three times in a row
-   `,` not treated as a separator in objects, like `;`
-   A crash when `\` appeared outside a string
-   Several parser and autocompletion crashes
-   Value nodes in function calls reporting the function's start position instead of their own, producing confusing error highlights
-   Math expressions not recognized as valid nodes
-   Grammar styling inconsistencies for references and numbers

## 0.2.1 Beta Hotfix

### Fixed

-   `&` references in function calls wrongly required to be parenthesized
-   `/` after a number tokenized as a path instead of a division
-   Empty `""` strings crashing the language server
-   Crashes on string delimiters, with better error handling
-   Stricter typing for value nodes

## 0.1.0 Beta

### Added

-   `&` references in the same parent scope, with validation
-   Validation for function calls
-   Localization support (en, de)
-   File icon for `.rules` files (dark and light) and an extension icon
-   Detailed diagnostics for errors

### Fixed

-   `;` after arrays and as a separator in objects
-   Parentheses around a function call's first parameter

## 0.0.1 Beta

-   Initial beta release with basic semantic highlighting and diagnostics
