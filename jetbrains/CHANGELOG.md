# Changelog

Cosmoteer Language server provides a lot of useful features, like:
- Autocompletion
- Diagnostics

## [Unreleased]

### Added

- A number the game also reads as a group can now be rewritten into that form in one step. "Make this modifiable" writes the value the file already had as its `BaseValue` and an empty `Modifiers` list beside it, and the offer runs the other way on a group that carries nothing but its base value.
- A component a part wires before declaring it can now be declared from the lightbulb. The kind is picked in a dialog, and the declaration is written where the part keeps its components, with every field the game throws without scaffolded.
- An inline block can now be moved into a file of its own. The file name is asked for in a dialog, the block is written there, and a reference to it takes its place, with every path it carries re-expressed against the new folder.
- Every class the schema knows now says what it is in one sentence, on the class page in the schema search and on the hover over a `Type =` value.
- A component wired into a slot that reads another kind of component is now reported, which the game answers with a crash while the part is built. The part's own components of the right kind are offered as the fix.
- The mod overview now opens with a health table: action targets, how much of the mod the game loads, ids registered twice, part grid values out of reach, language files behind the one they follow, dead fields, repeated field sets and overrides that change nothing.

## 0.8.0 - 2026-08-23

### Added

- A hover now says where the declaration under the cursor stands in its group's chain. A member names the value it replaces and the file and line that one is written in, and a group's own name says how many of its fields its bases supply. The checkbox for it is under Editing in the settings page.
- A reference can now be replaced with the value it stands for. "Inline the value" appears on a reference resolving to a single written value, and the value is copied the way its own file spells it.
- The effective-group report now lists what a mod loads in place of the game's own value, with the game's value beside it.
- The mod overview now names which unreachable file brings the most others back with it, and names the file whose commented-out line disabled the chain where one did.
- A reference that does not work out to a number now shows what it points at, both as an inlay hint and on hover. The checkbox for the inline half is under Editing in the settings page.
- The mod overview now lists the mod's own parts that no tech in the project unlocks.
- A particle channel a file computes that nothing in the effect reads is now faded out, which is what a misspelled channel name leaves behind.
- A manifest's `Replace` and `Remove` actions are now read the way the game reads them, so a member a mod replaces or removes shows what the game really loads.
- Render layers are now offered and checked per ship class. Only the layers the part's own ship declares are suggested, and a layer no ship declares, or one belonging to another ship class, is reported with the ship named. Turn it off with `cosmoteerLSPRules.diagnostics.validateRenderLayers`.
- Quotes, braces, brackets and `<` now close themselves as you type, and `//` and `/* */` comments toggle with the editor's own comment shortcut.

### Changed

- Problems now appear about twice as fast after you stop typing.
- Checking a whole mod is faster. A pass reads each folder once instead of once per reference into it, and which ships a part may be drawn on is worked out once for the project instead of once per part file.
- The language server is started with more room for short-lived data, so the collections a whole-mod check used to trigger are rarer and no longer stall it for up to half a second at a time. It also settles back to less memory once the check is done.
- Semantic highlighting from the language server is on by default and is painted by the plugin itself, so the colors stay on the text while you type instead of dropping out whenever a request is still running.

### Fixed

- A file written in the same instant the editor read the folder it sits in is no longer missed until something else changes there.
- A value is now suggested while its quotes are still open. `Layer = "roo` used to answer with the group's field names rather than the ship render layers, and the accepted suggestion now writes the missing closing quote.
- `Layer` written on an `IndicatorSprites` component is marked as having no effect, which is what the game does with it.
- Turning semantic highlighting on or off now reaches the files you already have open, instead of only the next file you open.

## 0.7.0 - 2026-08-19

### Added

- Seven shapes the game refuses to load are now reported instead of parsing as if they were fine, among them free text where a member name belongs, a number naming a member, a nameless `{` or `[` block outside a list, an inheritance with no body and a `/*` that no `*/` ever ends. Each of these makes the game drop the whole file at load time, so a mod could be shipped broken while the editor showed nothing.
- A block comment the game does not close is now a warning, with a fix that makes it close. The game closes a block comment only when the run of `*` before the closing `/` is odd, so a banner like `/****** Section ******/` silently swallows everything up to the next `*/` when the mod loads.
- A member written on a line whose value already runs to the line end is now a warning saying the value before it swallows it. The game accepts that shape and folds the member into the value, so it loses the member rather than failing to load.
- A group whose fields several other files of the mod write word for word is now marked, with a fix that creates the shared base file for you: a new `base_*.rules` beside them holding the repeated fields, with every one of them rewritten to inherit it and its own copies deleted, the way the game's own data and the larger mods are built. When those files are the only things inheriting their base, the fields go into that base file instead of into a new one in front of it. `Tools | Cosmoteer: Extract Shared Base Files` searches the whole project and lists every extraction worth making, largest first.
- The whole rewrite is shown before any of it happens, in the IDE's own diff viewer, one entry per changed file with the file as it is now beside the text the extraction would leave in it. Close the viewer and you are asked whether to go ahead.
- Applying an extraction no longer leaves the files it rewrote unsaved. Only a file you already have open goes through the editor, so the change lands in its undo history; every other file is written straight to disk, and the open ones are saved afterwards.
- "Allow refactorings to edit vanilla files" is one switch covering rename and the shared-base extraction, replacing the rename-only one. With it on, the game's `Data` folder becomes visible to the extraction as a project of its own, which it cannot be otherwise because it carries no mod manifest. Installed workshop mods stay off limits either way.
- A field written with exactly the value its group already inherits is now faded, with a fix that removes it. The inheritance chain is followed into the game's own `Data`, so a value copied line for line from a vanilla base is found, and a path is compared as the file it names rather than as the text it is spelled with.

### Changed

- The dead-field hint now also reads a field written as a bare list, the shape the game's own files use for effect collections. A `MediaEffects [ … ]` block that ended up on the component instead of on its hit or death slot is faded out with a remove quick fix instead of loading silently and doing nothing.

### Fixed

- Values are read the way the game reads them in five shapes that used to shift list positions or invent members: computed values inside a list count as one element each, a list element starting with a minus and continuing with arithmetic stays one element, a stray `)` and an unescaped `"` stay part of their value, and a value written on the line below its `=` belongs to the field above it.

## 0.6.0 - 2026-08-04

### Added

- Code mods are understood. A mod that ships a `.dll` declaring its own serializable types has those types, fields, enums and discriminators merged into the schema, so a modded component completes, hovers and validates like a built-in one. Assemblies in the open workspace, in your own `Mods` folder and in installed workshop mods all count, and the schema follows them as they are installed, updated or rebuilt.
- A code mod's own `///` documentation shows on hover when the mod is built with `<GenerateDocumentationFile>true</GenerateDocumentationFile>`, hover on a modded class links the mod's Steam Workshop page, and `Open in decompiler` opens the class from that mod's own assembly.
- Code mod support is configurable under Settings | Tools | Cosmoteer Rules | Code mods, and `Rebuild Schema from Code Mod Assemblies` in the Tools menu forces a rebuild.
- Whole-mod validation is on by default, scoped to what the game actually loads. Backups and templates stay out, and results are cached on disk, so only the first open of a project pays for the scan.
- Field documentation now covers every field in the schema, with units, ranges and the fields a value interacts with.
- Twelve more fields the game accepts and then ignores carry the dead-field hint, and a file that is one object gets the hint on its top-level fields too.
- The three music track collections the game crashes without now count as required.
- `Migrate Mod to Current Game Version` in the Tools menu upgrades every rules file of the workspace in one undoable edit and reports what it did, grouped by game version. An optional second mode also strips fields the game never reads.
- Deprecation hints now span the whole recorded changelog history, including `Flammable` and its `non_flammable` category replacement, deleted and renamed fields, and the manifest's `ModifiesMultiplayer` flag.
- A version-split manifest (`mod_*.rules`) without `CompatibleGameVersions` warns that the game never selects it, with a quick fix that inserts the installed game's version.

## 0.5.0 - 2026-07-18

### Added

- Field-name completion now works while typing a partial name, not only from an empty line.
- Deeper schema intelligence: fragment files that reach the game through mod actions, convenience-global aliases, and same-file or cross-file inheritance now know their class, so completion, hover and validation work inside them. Typed `Components` maps, font, cursor, sound and shader groups, and map entry-list forms are modeled.
- `mod.rules` action targets drive intelligence into the files they add: `Add`/`AddMany`/`AddBase`/`Overrides` fragments type from their target, inline action values complete and validate in the manifest, and `<./…>` targets resolve against the install root.
- Hover and completion on group-typed, list and asset fields now show a generated example (the `Type=` discriminator, required fields, and positional `Color`/`Vector2` forms), and color swatches appear on the positional list form the game saves.
- Interactive part grid editor, available as a JetBrains tool window with a gutter marker on `Part` lines: clicking the grid authors per-cell fields (doors, walls, crew destinations, colliders, ports and more) and writes each change straight to the `.rules` file.
- Field documentation for the most-modded gameplay and GUI classes, shown in hover and completion.
- Fields the game declares but never reads get a hint with a remove quick fix.
- `BaseValue` references show their value as an inlay hint (toggleable via `inlayHints.showBaseValue`), and `Modifiers` entries complete, hover and validate.
- Cross-file id intelligence now covers part ids, component ids, resource ids, damage types, triggers, effect buckets, bullet categories, ship ids and more, with completion, go-to-definition, find-usages, rename and validation. Ids declared by dependency mods and manifests count.
- Reference-path completion completes the segment at the cursor and matches member names case-insensitively, and references into other workshop mods recommend the game-root path form with a quick fix.
- Virtual-inheritance `:` paths resolve to the derived versions they select.
- Shader preview overhaul: real per-vertex math for ship, crew and part shaders, engine screen targets, WebGL2 rendering, preprocessor completion and hover, and sliders that fit each constant's range.
- Full mXparser operator support in `.rules` math, and computed-value inlay hints for the `d`/`r` number suffixes.
- Rules content written in `.txt` files is now indexed like `.rules`.

### Changed

- Whole-workspace validation is much faster on mods that reference ids from other installed mods, and the repeated "Indexing mentions" popups are gone.

### Fixed

- A large class of id false positives is resolved: ids a mod creates from its manifest, built-in ship ids, effect-bucket names, bullet categories, planet styles and component references are now recognized or checked correctly.
- Syntax highlighting no longer misreads bare identifiers, dotted string ids, asset paths, percentages or quoted references.
- Parser and completion fixes: an in-progress empty field no longer desyncs the parser, empty completion answers reopen as you type, and completion behind a closing `}` offers the right scope.
- Shader preview fixes: HLSL `%`, `isinf`, integer casts and `#if defined(…)` now translate, fixing the crew preview falling back to a plain quad.

## 0.4.1 - 2026-07-07

### Added

- Validation of values the game silently never reads: bare valueless fields, unknown members inside a group-typed field's list form, extra list elements and value shapes the field cannot read.
- Positional list values (`BaseSize = [7.2, 7.2]`) now get validation, hover and completion, including nested entry lists.
- Bare `&…` reference list elements are validated like any other reference.
- A warning when a list element name and its body share a line without a separator, with a quick fix.
- The server logs startup and validation timings, useful when a start feels slow.

### Changed

- Much faster starts. Project indexes and whole-workspace validation results are persisted, so reopening an unchanged mod restores everything in about a second.
- Faster editing through incremental document sync, diagnostic deltas and lazily resolved completion documentation.
- Whole-workspace scans reuse per-file results and skip unchanged files.
- The bundled language server ships as a native ES module bundle.

### Fixed

- Automatic Cosmoteer detection finds installations in secondary Steam library folders and works on Linux and macOS, including Flatpak and Snap installs.
- A wrong or unreadable detected path shows a warning instead of a stuck progress notification.
- Completions inside `[ … ]` no longer offer the outer group's field names, and field-name completion no longer re-offers fields already written in their bare form.
- Effect lists on group-typed fields (`HitEffects [ … ]`) now carry full schema intelligence.
- A crash in the document outline caused by a `[` and a parser problem when continuing a math expression.
- Whole-workspace validation no longer leaks problems from out-of-scope files, and reference false positives from the game-data loading phase no longer stick until the next edit.
- Go-to-definition on the inheritance reference of an empty group did nothing.

## 0.4.0 - 2026-07-04

### Added

- Full feature parity with the VS Code extension via LSP4IJ: pull diagnostics with all opt-in validators, completion with snippets, hover, navigation, find usages, rename, formatting, quick fixes, signature help, inlay hints, color swatches, document links, workspace symbols and semantic-token highlighting for `.rules` and `.shader` files.
- Live WebGL shader preview in a tool window, opened from a gutter icon on `Shader = …` lines, the editor context menu, or the Tools menu.
- Mod overview report for `mod.rules` manifests (gutter icon and context menu).
- Settings page under Settings | Tools | Cosmoteer Rules mirroring every `cosmoteerLSPRules.*` option. Changes apply to running servers without a restart.
- Localized server messages following the IDE language (English and German).
- File icons for `.rules` and `.shader` files, via registered TextMate-backed file types. The registration also stops the IDE from advertising other marketplace plugins for these extensions.
- Setting to enable LSP semantic-token highlighting on top of the TextMate colors (off by default: the overlay repaints asynchronously after every edit, which looks like flickering).
- Node.js is no longer a hard prerequisite: when no runtime is configured or on PATH, the plugin offers to download a private copy of the official Node.js LTS build (checksum-verified, about 30 MB, only the `node` executable is kept) and starts the server with it.

### Changed

- Rebuilt on LSP4IJ instead of the Ultimate-only native LSP API: the plugin now runs on Rider, IntelliJ IDEA Community and every other JetBrains IDE (2024.2+), and no longer needs the JavaScript plugin or a configured Node interpreter, only Node.js on PATH or in the settings.
