# Cosmoteer Language Server

**This is not an official extension from the Cosmoteer team.**

A language server for Cosmoteer modding files: `.rules` (including `mod.rules` manifests) and `.shader`. It provides completion, hover, navigation, refactoring, formatting, diagnostics and a live shader preview, in VS Code and JetBrains IDEs.

Based on the [VS Code LSP sample](https://github.com/microsoft/vscode-extension-samples/tree/main/lsp-sample).

## Setup

The extension detects the Cosmoteer installation automatically. If that fails, set `cosmoteerLSPRules.cosmoteerPath` to your installation folder; reference and asset validation and all cross-file features need it.

Completion entries provided by this extension carry the language-server icon; plain `abc` entries are VS Code's own word-based suggestions. Trigger completion with `Ctrl+Space` (default keybinding).

## Recommended VS Code settings

The extension works out of the box, but a few VS Code settings gate whole feature groups. If something from the feature list below seems missing, check these first:

```jsonc
{
    // Inlay hints: computed math results and percentage values shown inline.
    // If this is "off" you see no inline hints at all; "offUnlessPressed" shows
    // them only while holding Ctrl+Alt.
    "editor.inlayHints.enabled": "on",

    // CodeLens: the "Preview Shader" and "Mod Overview" links above the code.
    "editor.codeLens": true,

    // Semantic highlighting: the parse-aware coloring of references, enums,
    // math functions and field names. The default "configuredByTheme" lets some
    // themes turn it off silently.
    "editor.semanticHighlighting.enabled": true,

    // Suggestions while typing inside quoted strings (asset paths and
    // localization keys). Without this, completion inside a string only appears
    // after a trigger character like "/" or via Ctrl+Space.
    "editor.quickSuggestions": {
        "strings": "on"
    }
}
```

All values except `editor.quickSuggestions.strings` are the VS Code defaults, so this matters mostly when a personal profile or another extension changed them.

## Settings

All settings live under the `cosmoteerLSPRules.` prefix.

| Setting | Default | What it does |
| --- | --- | --- |
| `cosmoteerPath` | `""` | Path to the Cosmoteer installation (auto-detected when empty) |
| `ignorePaths` | `[]` | Reference paths to exclude from validation; any path containing one of these strings is ignored |
| `maxNumberOfProblems` | `100` | Maximum number of problems reported per file |
| `diagnostics.validateWholeWorkspace` | off | Validate every `.rules` file in the workspace, not just open files |
| `diagnostics.workspaceValidationScope` | `allFiles` | Scope of the whole-workspace pass: all files, or only the files reachable from the `mod.rules` manifest |
| `diagnostics.validateComponentReferences` | on | Flag a component ID reference that names no component in the part or its bases |
| `diagnostics.validateCrossFileReferences` | on | Flag a GUI toggle/color/targeter/trigger id with no declaration in the project or game data |
| `diagnostics.validateRequiredFields` | on | Flag a group missing a schema-required field (inherited fields count as present) |
| `diagnostics.validateShaderConstants` | on | Flag a material shader constant the referenced `.shader` does not declare, or with a mismatched value type |
| `diagnostics.validateShaderCode` | on | Diagnostics inside `.shader` files: missing `#include` targets, undeclared uniforms, unknown functions |
| `diagnostics.validateLocalizationKeys` | on | Flag a localization key that no language strings file declares |
| `diagnostics.validateRedundantSeparators` | on | Hint at a `,`/`;` separator a line break already makes redundant (shown as an editor hint, not in the Problems panel) |
| `rename.allowEditingVanillaFiles` | off | Allow Rename to edit files inside the game `Data` install |
| `associateShaderFiles` | on | Open `.shader` files with the Cosmoteer Shader language when another extension claims the extension |
| `formatting.enabled` | on | Document formatting for `.rules` and `.shader` files |
| `formatting.formatOnSave` | off | Format before every save, independent of the editor's `formatOnSave` |
| `trace.server` | `off` | Trace the communication between the editor and the language server |

The cross-file validators (component references, GUI ids, localization keys) run only once the game install is indexed.

## Index cache on disk

To make server starts fast, the language server persists its project indexes (schema ids, includes, localization keys, word index) and, when whole-workspace validation is enabled, the per-file validation results between sessions. Reopening an unchanged mod restores everything, Problems panel included, in about a second.

-   Location: `%LOCALAPPDATA%\cosmoteer-lsp\` on Windows (the system temp directory on other platforms)
-   Size: roughly 10-30 MB per game install plus per workspace, depending on mod size
-   Validity: every cache is keyed to the exact server build and game install, and each workspace file is verified by size and modification time on load, so edits made while the server was not running are always picked up. Persisted validation results are stricter still: they are only restored when nothing at all (files, game data, settings) changed since they were saved
-   Cleanup: files unused for 30 days are deleted automatically. The folder is safe to delete manually at any time; the only cost is one slower start while the caches rebuild

The server logs its startup and validation timings to the output channel, useful when a start feels slow.

## Features

**Editing**

-   Syntax highlighting, plus semantic tokens that color references, enum values, math functions and field names from the real parse
-   Code formatting for `.rules` and `.shader` files: re-indents by nesting and normalizes spacing, changing whitespace only. The result must lex to the identical token stream, otherwise the file is left unchanged. Optional format on save
-   Document outline (annotated with each group's resolved schema class) and workspace symbols
-   Reference-path completion for every reference form the game accepts, including inheritance bases after `:` (siblings, the `^/N/` extend-own-member idiom), virtual-inheritance `:` segments (`&:/…`) and, inside a mod, the mod's own `cosmoteer.rules` convenience globals after `&/`

**Schema intelligence**

A schema of every `.rules` type, extracted from the game's own classes, drives type-aware editing:

-   Field-name completion with type, default and enum documentation, inserted as ready-to-fill snippets
-   Value completion for `Type=` discriminators, enums, booleans and `ID<…>` references, plus an "Insert N required fields" scaffold
-   Validation of enum values, `Type=` discriminators, numeric fields and missing required fields, with "Did you mean …?" quick fixes
-   Hover showing a field's type, default, enum members and what a reference resolves to

**Navigation & refactoring**

-   Go to definition, find all references and rename across the mod and the game `Data` tree, including cross-file entities (factions, GUI ids, techs, buffs, resources, components, particle data channels)
-   "Extract value to shared root field": a code action on a number repeated across several assignments that hoists it into a root field and replaces every occurrence with a reference, following the single-source-of-truth practice from the game's own style guide
-   Rename never writes to the vanilla game files

**Diagnostics**

-   Syntax errors, unresolved references and assets, math expressions, duplicate keys, inheritance cycles
-   Values the game silently never reads: bare valueless fields, unknown members inside a group-typed field's list form, extra list elements and value shapes the field cannot read
-   Missing separators: two fields on one line with no `,`/`;` between them (the game silently reads them as ONE value) and a run of numbers read as a single list element, each with a quick fix. Conversely, a separator a line break already makes redundant is shown as a subtle hint with a remove quick fix
-   Component references, cross-file GUI ids, localization keys, shader constants and shader code, each toggleable in the settings
-   `mod.rules` actions: unknown verbs, missing required fields, unresolvable targets
-   Deprecation hints for renamed types, with a quick fix

**Resolved values**

-   Hover showing the resolved value of a reference, with sprite preview for assets
-   Inlay hints with computed math results (e.g. `Damage = (&Base)/2 + ceil(17/2)  = 14`) and percentages evaluated to their decimal form
-   Signature help for math functions, with arity checking for every known function
-   Completion for math-function names inside expressions and on numeric fields, inserted as ready-to-fill call snippets

**Shaders**

-   `.shader` is a full language: HLSL highlighting, completion, hover, signature help, go-to-definition through `#include`s, document outline
-   Shader-constant completion and hover in a material's `Shader = …` block
-   Live WebGL preview (CodeLens or `Cosmoteer: Preview Shader`) that renders the material the way the game does, with live constant controls, updating as you edit

**Mod tooling**

-   Full `mod.rules` manifest support: parsing, validation and completion of `Actions`
-   Mod overview report (CodeLens or `Cosmoteer: Show Mod Overview`): what the manifest does, whether each action target resolves, and which files are unreachable by the game
-   Localization-key completion and hover for `KeyString` fields, with an insert-into-all-strings quick fix
-   Color swatches with an in-place picker, part-category completion
-   Multi-root workspace support, localization (en, de)

## Planned

-   In Depth Diagnostics
-   More useful code actions and refactorings and quick fixes
-   More visuals for understanding how sprites are working
-   If you have suggestions or ideas, please open an issue on [GitHub](https://github.com/Cosmoteer-Modding-Tools/cosmoteer-lsp/issues)

## Credits

Thanks to the Cosmoteer team for beeing that open and allow to have the schema public available without the modders first need to generate it, and to the modders who have contributed to the community and provided feedback on this extension. 

Especial thanks to Walt for the open communication and allowance. As Celeste for helping with laying the ground for Jetbrains IDE Support and providing valuable input. Same for Rojamahorse which provided valuable feedback and testing and a very complex mod for testing the extension. And also SkipperWraith who brought me back to this project.

## Showcase

![Basic Syntax Highlighting Example Image](https://github.com/Cosmoteer-Modding-Tools/cosmoteer-lsp/blob/master/showcase/syntax_highlighting.png?raw=true)
![Diagnostics for syntax errors Example Image](https://github.com/Cosmoteer-Modding-Tools/cosmoteer-lsp/blob/master/showcase/diagnostics.png?raw=true)

https://github.com/user-attachments/assets/b1de7a49-404f-483b-8739-f1e7b6706a50
