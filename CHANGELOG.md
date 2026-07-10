# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

### Added

- Interactive part grid editor. An "Edit part grid" CodeLens on every `Part` opens a visual editor that shows the part's sprites split into the in-game cell grid, with an extra ring for the door and virtual cells around it.
- Clicking the grid authors the per-cell fields instead of hand-typing coordinates: allowed door locations, blocked travel cells and their directions, external/internal/blueprint walls per cell edge, crew destinations with sub-cell snapping, virtual internal cell pairs, `PhysicalRect`/`SaveRect` and `Size`.
- Every click writes the change to the `.rules` file immediately and undoes with the normal editor undo. Values inherited from a base part render as ghosts, and the first edit creates the local override carrying them along.
- The editor view can be rotated and flipped to preview other orientations (coordinates stay rotation-0), and the rotation fields themselves (`IsRotateable`, `IsFlippable`, flip mappings) are editable from the sidebar.
- The editor also covers the component geometry: a gizmo for every component's `Location` and `Rotation` (chained components resolve their transform), polygon collider vertex editing, network port cells with their facing, resource grid rects with disable cells, prohibit rects, buff areas and circles, tile score lines, storage pick-up and delivery points, airlock and toggle button positions, resource sprite offsets, railgun segment endpoints, and the `AllowedContiguity` flags.
- Edge-distance regions like the heat exchanger's heat absorption area draw as a halo around the part, and dragging its boundary sets how many cells the region reaches beyond the part edge.
- The part grid editor is also available in the JetBrains plugin as a tool window, with a gutter marker on `Part` lines.
- References into other workshop mods now recommend the `<./Data/../../../workshop/…>` game-root form. A relative path that resolves gets an informational hint, one written from the wrong depth gets the working rewrite, both with a quick fix.
- A `mod.rules` manifest can build its `Actions` list by concatenating other files' action lists (`Actions: &<launcher.rules>/Actions, &<register.rules>/Actions`). Those included files are now handled like the manifest itself: their `AddTo`/`OverrideIn`/`AddBaseTo` game-root target paths no longer flag as unresolved references, and their action verbs, required fields and target existence are validated the same way a manifest's are.
- A file pulled into a manifest's `Actions` by reference now counts as reachable content, so it and the parts its actions add are no longer reported as unreachable.
- `^/N` references into a base that a mod's `AddBase` action appends to a node now resolve everywhere the resolver runs, so go-to-definition, hover, completion and validation give one consistent answer. A reference into the appended base (`Part/^/1/HEAT_TARGET_STORAGE`, where the overclock base is added at slot 1) jumps and completes to that base's members, while a reference to the wrong slot (`^/0`, still the part's original base) is correctly reported as unresolved.
- The virtual-inheritance `:` path segment now resolves to the derived versions it selects. Go-to-definition on a `&Base/:/Member` reference jumps to the member's value in every group that inherits the base, alongside the base's own declaration, and completion after `:/` offers the members the deriving overrides supply.
- The shader preview now runs the real per-vertex math of ship part, roof, wall, crew and indicator shaders, including the atlas sprite animation frame selection, instead of a generic stand-in quad.
- Shaders that sample the engine's screen targets (`_diffuseTarget`, `_normalsTarget`, `_stencilTarget`, `_capturedBackBuffer`) render against plausible stand-ins, so lighting and distortion effects show instead of going black or blank.
- Crew shader previews render with shirt, skin and hair colours, and the include-library base shaders (`base.shader`, `base_particle.shader`, …) preview their default pipeline instead of failing.
- The preview renders on WebGL2 when available: real explicit-LOD sampling and texture-size queries (decals), Min/Max blend modes, and repeat wrapping and mipmaps for non-power-of-two textures.
- More engine-fed constants start at their in-game values in the preview controls (`_shipBounds`, roof opacity and colours, specular shape, interaction clocks).
- Engine clocks now animate in the preview the way the game drives them: blueprint flicker and redprint fluctuation, planet rotation and wave crossfade, GUI highlight sweeps and click flashes, and the crew animation clock, each with an "auto" toggle to set them manually instead.
- Preprocessor completion in `.shader` files: directive keywords after `#`, macro names in `#ifdef`/`#if defined(…)` (the engine's feature-level macros plus every guard the include chain tests), guard names after `#define`, and file-system path completion inside `#include "…"`.
- Hover on preprocessor macros: engine feature-level gates are explained, defined macros show their replacement, and guards tested by an included base shader explain the define-before-include pattern.
- A numeric `MipLevels = N` on a texture now caps the preview's sampled mip chain at N levels like the engine, instead of always sampling a full chain.
- Preview sliders fit their range and step to the written value's magnitude and display full precision, so a tiny constant like `_midTexScale = 0.0005` no longer shows as `0.00` or snaps to a coarse grid, and negative values are reachable.
- Full mXparser 4.4.2 operator support in `.rules` math, matching the engine's math library operator for operator: modulo `#`, tetration `^^`, the boolean families (`&`, `&&`, `~&`, `|`, `||`, `~|`, `(+)`, `-->`, `<--`, `<->`, `-/>`, `</-`), the binary relations (`=`, `==`, `<>`, `~=`, `!=`, `<`, `>`, `<=`, `>=`) and the bitwise operators (`@&`, `@|`, `@^`, `@<<`, `@>>`). Expressions using them parse, validate and show computed-value inlay hints with the game's exact evaluation order and epsilon semantics, verified against the shipped mXparser DLL.
- Computed-value inlay hints also cover the `d`/`r` number suffixes: `90d` converts degrees to radians exactly like the game, in plain values and inside expressions, and results snap to the game's almost-integer rounding (`0.1 * 30` shows `= 3`).
- Part ids are now first-class references: `EditorParentParts` (both the flat and the `[part, order]` spelling) and part-keyed maps like `PartIDTileCosts` complete with the project's `Part { ID = … }` declarations, with go-to-definition, hover, find-references and rename included.
- Component name completion inside `Components` blocks: ids the part references but never declares (a proxy's `ComponentID`, an `OperationalToggle` written before its toggle exists) are offered as new component names, scaffolded with a `Type =` block. Works in mode fragments too, where the expectation lives in the vanilla part the fragment is toggled into, so a new missile mode gets its `MissilesPrereq` suggested.
- Component ids written in route tuples (a network router's `Routes [ [from, to, cost] ]`) now complete with the part's component ids and jump to the referenced component. A route endpoint that names no component anywhere in the part gets the same missing-component warning and did-you-mean fix as other component references.
- Reference-keyed maps written in the `[{ Key, Value }]` entry form now complete and navigate their `Key` values (a ship's `RenderLayers`, resistances), and self-keyed maps such as `RenderLayers` and `TradeShips` contribute their keys as navigable declarations.
- Spawner tags in sector-generation files (`Tags`, `RootLocationTag`, `MinDistanceFromTags`) complete with the tags declared across the project's sysgen files and navigate to the declaring `Tags` entry. A tag nothing declares gets a warning, aware of the tags the game modes register in code (`player`, `spawn_point`, …) and of tags declared by other installed workshop mods.
- Part ids that resolve nowhere now warn too. A part declared by any installed workshop mod counts (dependency mods outside the workspace stay quiet), `OtherIDs` aliases count, and label fields like `SelectionTypeID` or the save-compatibility `FlipWhenLoadingIDs` are never checked.
- Damage-type keys (`DamageResistances { fire = … }`) now complete with every damage type the project's hit effects deal plus the engine's built-in three, and navigate to the declaring `DamageType = …`.
- A resistance key naming a damage type nothing anywhere deals now gets a warning with a did-you-mean fix, since such an entry silently never applies in game. Damage types declared by installed workshop mods count, and vanilla's own dead `shrapnel` entry stays quiet.
- Scalar trigger and toggle references (`FireTrigger = Turret`, `AutoOffTrigger = …`, a spawner search's `Tag`) now resolve through the schema's scalar payload: they complete with the part's component ids, jump to the component, and a trigger naming no component gets the missing-component warning. The payload member is extracted from the engine's deserializers by schemagen, so it follows game updates.
- The group spelling's inner `TriggerID`/`ToggleID` completes with the engine's registered trigger and toggle provider names (`HitIntervalElapsed`, `IsRunning`, …).
- Mods that write rules content in `.txt` files are now fully indexed: parts and other declarations in `.txt` complete, validate and navigate like `.rules` files, and `<file.txt>` references resolve.
- Sparse override-patch files (a `Part { }` a mod.rules action merges into a vanilla part) now resolve their component references against the merged result, removing false missing-component warnings and completing the target's components.
- Go-to-definition on component ids now works part-wide: a component declared in an inherited base part, an included components block or an override target resolves across files, from assignment references and route tuples alike.
- The engine's hardcoded ids (runtime spawner tags, crew-job component ids like `ConstructionTracker`, the built-in damage types) are extracted from the game assemblies into the schema by schemagen, so they follow a game update through a normal schema regeneration instead of hand-curated lists.
- Vanilla's own stale ids (leftovers like the `graveyard_platform` tag or the dead `shrapnel` resistance) are recognized mechanically: an unknown id the base game's files also reference stays quiet, so a new game version's leftovers never produce false warnings while a modder's typo still flags.
- Cross-file id validation now covers every id class, with no hand-kept class or field list at all: buffs, resources, statuses, editor groups, doodads, factions, career techs, nebula types and part features validate alongside the existing kinds. What keeps that safe is derived mechanically: usage-defined name classes (categories, features, damage types) declare through their uses, a part's `Stats` keys declare the stats its GUI widgets read, `OtherIDs` aliases declare on every entity kind, declarations in unrooted files or manifest-added collections are found by shape, dependency mods are consulted, label fields the engine never resolves (`SelectionTypeID`, `FlipWhenLoadingIDs`, `UpgradedFrom`) are recognized from the base game's own usage, and classes whose coverage cannot be established are never judged.
- Reference lists nested inside tuple slots (the career map picker's faction candidates) resolve, complete and navigate too.
- Resource ids now complete inside a part's cost tuples: the id slot of `Resources [ [bullet, 20] ]` (and any other tuple-typed field with an id slot) offers the project's resource ids while typing, and the written id gets go-to-definition, hover, find-references and rename like any other cross-file id.
- Component id completion is now part-wide: a component `ID<…>` value (`OperationalToggle = `, `ComponentID = `) offers every component the part declares, including ones from inherited base parts and include-merged `Components` blocks, with same-container siblings listed first. Fields that resolve outside the part (cross-part proxies, chain-fire targets) no longer offer misleading local ids.
- Fields the game ignores now get an editor hint with a remove quick fix: a field the component's class never reads, left over from copying or from switching a `Type` in the game's dev editor (such as `Filename` on a `ValueCurve`), is dead weight the game silently drops. Every class the game reads field by field is judged, so dead leftovers on parts, effects and both the game's and the engine's particle updaters and renderers are caught. A field read through any reference in the file (including inside quoted expressions), or one whose class fits the surrounding group too poorly to trust the match, stays quiet. Toggleable via `diagnostics.validateIgnoredFields`.

### Fixed

- Path completion in game-root references now accepts any casing of the `<./Data/` prefix, so a reference written as `&<./data/ships/…/missile_launcher.rules>/Part/Components/` offers the target file's members just like the capitalized form.
- File extensions in paths and asset values now match with any casing, like the game's own file loading: `<Foo.Rules>` references parse, navigate and complete, `sound.WAV`/`icon.PNG` values classify as assets, uppercase-extension files appear in the asset tree and shader include completion, and a mod's additions resolve regardless of how the manifest and the reference spell the target path's case.
- Accepting a completion whose snippet lands the cursor at a value slot (a scaffolded `Type = `, an enum, bool or component reference field) now reopens the suggestion popup there, instead of leaving the slot without suggestions until triggered manually.
- An empty completion answer is now marked incomplete, so the editor asks again on the next keystroke. Previously a request that hit the server mid-startup or mid-cancellation cached its emptiness for the whole popup session, and typing further never brought the suggestions back until the popup was closed and reopened.
- An in-progress empty field (`Type = ` with the value not yet typed, the state right after a completion snippet or after deleting a value) no longer desyncs the parser. The next line was consumed as the value, which broke the surrounding braces and with them every suggestion, hover and diagnostic in the container until the value was written. The empty value now parses as an empty field, matching the game's own grammar.
- Syntax highlighting no longer misreads bare identifiers. A dotted string id like `flash.laser_blaster` or `SW.doorium` is coloured as a value, not a reference; keys, group names and enum values are told apart from real `&`/`<…>` references; asset paths (`../foo.png`, `bar.shader`) colour as strings; and keys separated from their `=` by tabs, dotted group names, and references written inside quotes (`AddTo = "<…rules>/Path"`) all colour correctly.
- Percentages (`50%`, `-0.6%`) and `Infinity` now colour as numbers instead of plain values.
- A quoted all-digits value like `SituationCode = "0000"` is treated as text, so its highlight and hover keep the leading zeros instead of showing the number `0`.
- Division glued to a subtraction inside a list expression (`[4*166/64-0.6, …]`) is no longer misread as a reference and falsely reported as unresolved.
- Enum field hovers show the default as the member name instead of its raw number (`AllowedContiguity` default `Sides`, not `170`), decomposing flag combinations without a single name (`Ships, Parts`).
- A handful of schema defaults declared via attributes rendered as `Mono.Cecil.CustomAttributeArgument` in hovers; they now show their real values.
- The boolean `&` operator between parenthesized operands (`(&A) & (&B)`, used by the vanilla fire status) parses as part of the value instead of producing a bogus `Unknown function "&"` error.
- A quoted expression argument like `ceil("(&A) / (&B)")` (used by the vanilla thermal missile launcher) is no longer flagged as an invalid argument type.
- Function-call validation no longer runs in language-strings files, where text like `Desejado(s)` was misread as an unknown math function.
- "Asset not found" is no longer reported for a field the game ignores, such as the vanilla reactor shockwaves' `Filename = SmoothFalloffRamp.png` (dev-editor metadata next to the baked curve points).
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
-   Separator diagnostics: a warning when two fields on one line have no `,`/`;` between them (the game silently reads them as ONE value, verified against the real parser) and when a run of numbers is read as a single list element, each with an insert-separator quick fix; plus a subtle hint (`diagnostics.validateRedundantSeparators`) on a separator a line break already makes redundant, with a remove quick fix
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
-   Rename edits are restricted to the open mod; the vanilla `Data` install is never written (opt out via `rename.allowEditingVanillaFiles`)
-   Runtime `~` references and references resolving to runtime values are no longer statically validated
-   Commented-out references no longer count toward file reachability
-   A mod's root `cosmoteer.rules` is no longer seeded into the reachability closure, since the game never loads it
-   Nested manifests (`mod.rules`/`mod_*.rules` in subfolders) are discovered recursively, matching the game
-   Performance: the project-wide indexes build in a single directory walk and warm up in the background, file reads run concurrently, and the reachability computation is about 6x faster

### Fixed

-   Circular-inheritance diagnostics landing on wrong, shifting lines when the cycle closes in another file; the diagnostic now anchors to the validated file's own inheritance reference
-   Members of a map-typed slot resolving their `Type=` in the wrong registry, which gave included component fragments wrong completions and bogus required-field prompts
-   Shader constants written in group form (`_waveTex { … }`) not completing their fields
-   The shader preview failing on functions with HLSL default parameter values
-   A stray `=` reported as a possible parser bug instead of `Unexpected "="`, matching the game's parser
-   A decimal operand glued to a slash (`1.5/2`) lexed as one path-like token, breaking the surrounding math expression
-   A false `Not expected comma` when several fields share one line (`A = 1, C = 2`); `,` terminates a node exactly like `;`
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

-   Removed `InheritanceNode`; inheritance is now a property of the object and array nodes

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
