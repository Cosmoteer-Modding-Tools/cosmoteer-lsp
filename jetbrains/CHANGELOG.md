# Changelog

Cosmoteer Language server provides a lot of useful features, like:
- Autocompletion
- Diagnostics

## [Unreleased]

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
- Faster editing through incremental document sync, diagnostic and semantic-token deltas and lazily resolved completion documentation.
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
