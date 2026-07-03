Based on https://github.com/microsoft/vscode-extension-samples/tree/main/lsp-sample

## This is not an official extension from the Cosmoteer Team

# Cosmoteer Language Server

This is a language server for the game Cosmoteer. Its goal is to provide code completion, hover information, navigation, refactoring, theming and diagnostics for Cosmoteer modding files (\*.rules), including `mod.rules` manifests.

### How to use

Set the `cosmoteerPath` setting to the path of your Cosmoteer installation. This is needed to validate references and assets; without it those features are unavailable.
If you have custom references which can't yet be resolved by the language server, you can add them to the `ignorePaths` setting. This is an array of strings; any path that contains one of these strings is ignored.
By default the language server only validates the file which is currently open. To validate every `.rules` file in your workspace folder(s), enable the `cosmoteerLSPRules.diagnostics.validateWholeWorkspace` setting (off by default, as it parses the whole project and uses more memory).

## Suggestions

Please be aware that this extension does not provide `abc`(You can see those icons or text left from the suggested text) suggestions those are by vs code itself. If you see a file icon with a `->`in the top corner of this file icon. Than this is a suggestion from the language server.
To generate those suggestions you can use the `ctrl+space` keybinding to get the suggestions from the language server. Unless you changed it in the settings.

### Features until now

**Editing & syntax**

-   Basic syntax highlighting
-   Diagnostics for syntax errors
-   Semantic-token highlighting for `.rules` (colours references, bareword enum values, math functions and field names by what they actually are, on top of the TextMate grammar), working identically in both VS Code and JetBrains

**Shader tooling**

`.shader` files are a first-class language (HLSL highlighting, hover, go-to-definition following `#include`s, document outline, completion and signature help):

-   Shader-constant completion and hover in a material's `Shader = …` block (the `_`-prefixed uniforms the referenced shader declares, typed and with defaults)
-   Live WebGL shader preview (a "Preview shader" CodeLens / `Cosmoteer: Preview Shader` command) that renders the material the way the game does, with live constant controls and backdrop / blend / pause options, updating as you edit (including unsaved edits)
-   Shader diagnostics, on by default: shader-constant checks (`cosmoteerLSPRules.diagnostics.validateShaderConstants`) and in-shader checks (`cosmoteerLSPRules.diagnostics.validateShaderCode`)

**Schema intelligence (full type safety, extracted from the Cosmoteer game data)**

The extension ships a schema of every `.rules` type — field names, value types, required/optional, enums and polymorphic `Type=` registries — extracted directly from the game's own `*Rules` classes. This powers type-aware editing across the board:

-   Field-name completion offering the fields valid in the current group/file (with type, required/optional, default and enum members shown as documentation), inserted as ready-to-fill snippets
-   Value completion for `Type=` discriminators, enum fields, booleans and `ID<…>` references — in groups, custom containers, typed list elements and at whole-file roots
-   `Type` suggested first in a polymorphic group that hasn't chosen its subtype yet
-   Sibling component references (`OperationalToggle = IsOperational`) and cross-file id references (`ResourceType = battery`) completed from the project's definitions
-   Validation of invalid enum values and invalid `Type=` discriminators, with "Did you mean …?" quick fixes
-   Go to definition, find all references, hover and rename for both sibling and cross-file `ID<…>` references
-   The document outline annotates each group with the schema class it resolves to (e.g. `Turret → TurretWeaponRules`)

**Code completion**

-   Code completion for all references (cross-file, inheritance and super-path aware)
-   Code completion for assets (image/sound/shader paths)
-   Code completion for `mod.rules` actions (verb names, fields per verb and target paths)

**Validation / diagnostics**

-   Validation for references in `.rules` files (incl. inheritance, super-paths and case-insensitive members)
-   Validation for function calls, math expressions and assignments with references (mXparser semantics)
-   Validation for assets (e.g. images, sounds, shaders), including inheritance-relative asset paths
-   Validation for `mod.rules` actions (unknown verbs, missing required fields, target existence)
-   Duplicate-key and inheritance-cycle detection
-   "Did you mean …?" quick fixes for mistyped references and asset paths
-   Optional whole-workspace validation (validate every `.rules` file, not just the open one — opt-in via `cosmoteerLSPRules.diagnostics.validateWholeWorkspace`)
-   Component-reference validation: flag a component `ID<…>` value (`OperationalToggle = IsOperational`) that names no component in the part, its inherited bases or its include-valued components blocks (`cosmoteerLSPRules.diagnostics.validateComponentReferences`, on by default once the game install is indexed)
-   Missing-required-field validation: flag a polymorphic component group that omits a field the game requires, checking the full inheritance chain (`cosmoteerLSPRules.diagnostics.validateRequiredFields`, on by default)
-   Cross-file GUI id validation: flag a `ToggleID` / `ColorID` / `TargeterID` / `TriggerID` declared by no GUI collection in the project (`cosmoteerLSPRules.diagnostics.validateCrossFileReferences`, on by default once the game install is indexed)
-   Localization-key validation: flag a `KeyString` field (`NameKey`, …) whose key no strings file declares, with an insert-into-all-strings quick fix (`cosmoteerLSPRules.diagnostics.validateLocalizationKeys`, on by default once the game install is indexed)

**Navigation & refactoring**

-   Go to definition (cross-file, follows references and inheritance)
-   Find all references across the mod and the game `Data` tree
-   Rename / refactor a symbol across files (never writes to the read-only vanilla game files)
-   Schema-aware go-to-definition, find-references, hover and rename for `ID<…>` references (sibling components and cross-file ids such as resources)
-   Cross-file references to aggregate list-element entities — factions, GUI part toggles/colors/targeters, career techs/encounters, ship doors, … — with completion, go-to-definition, find-references and rename (the list fields and their id keys are derived from the schema)
-   Document symbols (Outline / breadcrumbs), annotated with each group's resolved schema class
-   Workspace symbols (search symbols across the project)

**Resolved-value intelligence**

-   Hover information showing the resolved value of a reference, with sprite image preview for assets
-   Inlay hints showing computed math/function results inline (e.g. `Damage = (&Base)/2 + ceil(17/2)  = 14`)
-   Percentage values evaluated to their decimal form in hover and inlay hints (e.g. `Chance = 50%  = 0.5`)
-   Signature help for math functions: typing inside a call (`ceil(`, `pow(`, …) shows its parameters and highlights the active argument. Every known function (the full mXparser vocabulary plus Cosmoteer's own) gets a signature with its real argument count, and calls with missing arguments are flagged
-   Localization-key completion and hover for `KeyString` fields (`NameKey`, …), showing the resolved text in every available language

**Other**

-   Code formatting for `.rules` (including `mod.rules` and its actions) and `.shader` files: re-indents by nesting, normalizes spacing around `=`, `:`, commas and parentheses, trims trailing whitespace and caps blank-line runs. The `.rules` formatter is whitespace-only and self-verifying — the result must lex to the identical token stream (values, comments and `\` line continuations untouched), otherwise it changes nothing. Toggle with `cosmoteerLSPRules.formatting.enabled`, and enable `cosmoteerLSPRules.formatting.formatOnSave` to auto-format on every save (off by default; works alongside VS Code's own `editor.formatOnSave`)
-   Deprecation hints: a renamed type (e.g. `Ammo*` → `Resource*`) is flagged with its replacement and a quick fix that swaps it in
-   Part-category completion: offers every category used across the project (`Category = armor`, `TypeCategories = [ … ]`)

-   Full `mod.rules` manifest support (parsing, validation and completion of `Actions`)
-   Multi-root workspace support (navigation, references, rename and validation span all open folders)
-   Localisation support (en, de) so far
-   Support for JetBrains IDEs (in addition to VS Code)
-   Automatic detection of the Cosmoteer installation path
-   Cancellation-token support to avoid unnecessary work

### Features in the future

-   Code completion for functions (Needs type checking)
-   Type checking
-   Identifier validation
-   Unit-aware value evaluation (the `.rules`/mXparser format has no unit literals today, so this is exploratory)
-   _If you have any suggestions or ideas, please open a issue on the [GitHub](https://github.com/Cosmoteer-Modding-Tools/cosmoteer-lsp/issues)_

### Showcase

![Basic Syntax Highlighting Example Image](https://github.com/Cosmoteer-Modding-Tools/cosmoteer-lsp/blob/master/showcase/syntax_highlighting.png?raw=true)
![Diagnostics for syntax errors Example Image](https://github.com/Cosmoteer-Modding-Tools/cosmoteer-lsp/blob/master/showcase/diagnostics.png?raw=true)

https://github.com/user-attachments/assets/b1de7a49-404f-483b-8739-f1e7b6706a50
