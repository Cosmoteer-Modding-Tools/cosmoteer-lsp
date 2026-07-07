# Changelog

Cosmoteer Language server provides a lot of useful features, like:
- Autocompletion
- Diagnostics

## [Unreleased]

### Added

### Changed

### Deprecated

### Removed

### Fixed

### Security

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
