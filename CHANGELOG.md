# Changelog

All notable changes to this project will be documented in this file.

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
