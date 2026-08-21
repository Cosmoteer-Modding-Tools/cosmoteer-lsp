# Cosmoteer Language Server

**This is not an official extension from the Cosmoteer team.**

A language server for Cosmoteer modding files: `.rules` (including `mod.rules` manifests) and `.shader`. It provides completion, hover, navigation, refactoring, formatting, diagnostics and a live shader preview, in VS Code and JetBrains IDEs.

Based on the [VS Code LSP sample](https://github.com/microsoft/vscode-extension-samples/tree/main/lsp-sample).

## Setup

The extension detects the Cosmoteer installation automatically. If that fails, set `cosmoteerLSPRules.cosmoteerPath` to your installation folder. Reference and asset validation and all cross-file features need it.

Completion entries provided by this extension carry the language-server icon, plain `abc` entries are VS Code's own word-based suggestions. Trigger completion with `Ctrl+Space` (default keybinding).

## Recommended VS Code settings

The extension works out of the box, but a few VS Code settings gate whole feature groups. If something from the feature list below seems missing, check these first:

```jsonc
{
    // Inlay hints: computed math results and percentage values shown inline.
    // If this is "off" you see no inline hints at all; "offUnlessPressed" shows
    // them only while holding Ctrl+Alt.
    "editor.inlayHints.enabled": "on",

    // CodeLens: the "Preview Shader", "Mod Overview", "Edit Part Grid" and
    // "Show Part Wiring" links above the code.
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
| `ignorePaths` | `[]` | Reference paths to exclude from validation, any path containing one of these strings is ignored |
| `maxNumberOfProblems` | `100` | Maximum number of problems reported per file |
| `diagnostics.validateWholeWorkspace` | on | Validate the whole mod, not just the files open in the editor. Cached on disk per file, so only the first open of a project pays for the scan |
| `diagnostics.workspaceValidationScope` | `modRulesReachable` | Scope of the whole-workspace pass: only the files the `mod.rules` actions actually load (their includes, inheritance and the strings folder), or `allFiles` for every `.rules` under the workspace. A workspace with no manifest is unrestricted either way |
| `diagnostics.validateComponentReferences` | on | Flag a component ID reference that names no component in the part or its bases |
| `diagnostics.validateCrossFileReferences` | on | Flag a GUI toggle/color/targeter/trigger id with no declaration in the project or game data |
| `diagnostics.validateRequiredFields` | on | Flag a group missing a schema-required field (inherited fields count as present) |
| `diagnostics.validateShaderConstants` | on | Flag a material shader constant the referenced `.shader` does not declare, or with a mismatched value type |
| `diagnostics.validateShaderCode` | on | Diagnostics inside `.shader` files: missing `#include` targets, undeclared uniforms, unknown functions |
| `diagnostics.validateLocalizationKeys` | on | Flag a localization key that no language strings file declares |
| `diagnostics.validateRedundantSeparators` | on | Hint at a `,`/`;` separator a line break already makes redundant (shown as an editor hint, not in the Problems panel) |
| `diagnostics.validateIgnoredFields` | on | Hint at a field the game never reads, with a remove quick fix (shown as an editor hint, not in the Problems panel) |
| `diagnostics.validateUnclosedComments` | on | Warn about a block comment the game never closes, because the run of `*` before its closing `/` is even, with a quick fix that closes it |
| `diagnostics.validateDefaultValues` | on | Fade a field written at the game's own default, with a remove quick fix. Only inside groups that do not inherit, since an explicit default can override a base's value |
| `diagnostics.validateUnusedConstants` | on | Fade a `SCREAMING_CASE` constant nothing reads, and a chain of constants that only read each other, with a remove quick fix. Only judged when no other file in the project spells the name |
| `codeMods.enabled` | on | Read the types, fields and `Type=` values a mod's `.dll` declares and merge them into the schema, so modded components complete, hover and validate like built-in ones. Covers the workspace, the installed workshop mods and your own `Mods` folder. Off scans nothing and uses the shipped schema alone |
| `codeMods.autoRefresh` | on | Pick up a code mod installed, updated or rebuilt while the editor is open, by watching the assemblies the schema was built from. Off leaves that to `Cosmoteer: Rebuild Schema from Code Mod Assemblies` |
| `inlayHints.showBaseValue` | on | Show the referenced group's `BaseValue` inline: a reference to a group with a `BaseValue` member renders `/BaseValue = 160d` |
| `hover.showSubstitutions` | on | End a computed value's hover with the references it substituted, the number each one stood for, and the file and line that number came from |
| `hover.showModifiers` | on | End a modifiable value's hover with what its modifiers do to the number, inherited ones included, and the range the written clamps prove it stays inside |
| `diagnostics.validateDuplicateFields` | on | Hint at a group whose fields several other files of the mod write word for word, carrying the "extract shared base file" refactoring that moves them into one base file all of them inherit |
| `diagnostics.validateRedundantOverrides` | on | Fade a field written with exactly the value its group already inherits, with a remove quick fix. The chain is followed into the game's own `Data` |
| `diagnostics.validateModManifest` | on | Check the `mod.rules` manifest itself: a missing or malformed `ID` or `Name`, a field name that is a near miss of a real one, and a `StringsFolder`, `Logo` or ship library folder that is not on disk |
| `diagnostics.validatePartGeometry` | on | Fade a door, blocked travel cell or wall entry the part's own size puts out of the game's reach, with a remove quick fix, and report a `PhysicalRect` that leaves the part as an error |
| `diagnostics.validateDuplicateIds` | on | Flag an id two files of the same mod both register, naming the other file. The game keeps one and drops the rest |
| `diagnostics.validateUndeclaredDependencies` | on | Flag an id that only resolves because another mod is installed on this machine, with a fix that writes that mod into the manifest as a dependency |
| `diagnostics.validateUnreceivableBuffs` | on | Flag a buff modifier, clamp or toggle naming a buff the part never receives, since a part is handed a buff only through its own `ReceivableBuffs` |
| `allowEditingVanillaFiles` | off | Let refactorings read and rewrite the game `Data` install. Rename reaches into it, and the shared-base extraction treats it as a project of its own, which it cannot do otherwise because the game tree carries no mod manifest. Installed workshop mods stay off limits either way |
| `decompiler.showInHover` | off | Power user: end schema hovers with an "Open in decompiler" link that opens the owning C# class from the game's assemblies |
| `decompiler.executablePath` | `""` | Path to your ILSpy or dotPeek executable (auto-detected when empty, searching the PATH and the usual install locations) |
| `decompiler.tool` | `auto` | Command-line style for the decompiler (`auto` infers ILSpy or dotPeek from the executable name) |
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
-   Cleanup: files unused for 30 days are deleted automatically. The folder is safe to delete manually at any time, the only cost is one slower start while the caches rebuild

The server logs its startup and validation timings to the output channel, useful when a start feels slow.

## Features

**Editing**

-   Syntax highlighting, plus semantic tokens that color references, enum values, math functions and field names from the real parse
-   Code formatting for `.rules` and `.shader` files: re-indents by nesting and normalizes spacing, changing whitespace only. The result must lex to the identical token stream, otherwise the file is left unchanged. Optional format on save
-   Document outline (annotated with each group's resolved schema class) and workspace symbols
-   Reference-path completion for every reference form the game accepts, including inheritance bases after `:` (siblings, the `^/N/` extend-own-member idiom), virtual-inheritance `:` segments (`&:/…`) and, inside a mod, the mod's own `cosmoteer.rules` convenience globals after `&/`
-   Folding for every `{ … }` and `[ … ]` body and for multi-line comments, both `/* … */` blocks and runs of `//` banner lines, so a part file reads as its list of components
-   Expand selection along the parse: from the caret out to the value, the field, the group holding it and on to the whole file

**Schema intelligence**

A schema of every `.rules` type, extracted from the game's own classes, drives type-aware editing:

-   Field-name completion with type, default and enum documentation, inserted as ready-to-fill snippets
-   Value completion for `Type=` discriminators, enums, booleans and `ID<…>` references, plus an "Insert N required fields" scaffold
-   Validation of enum values, `Type=` discriminators, numeric fields and missing required fields, with "Did you mean …?" quick fixes
-   Hover showing a field's type, default, enum members and what a reference resolves to
-   `Cosmoteer: Search Schema and Field Docs` (also in the JetBrains Tools menu and the editor context menu) ranks every type, field, enum value and `Type=` subtype against what you type and searches the field documentation with it, so a half-remembered phrase such as "how often" finds the interval fields. A hit opens as a page with the value type, whether it is required, its default, the legal values and a worked example, and from inside a known group it offers to write any of that group's fields at the cursor

**Navigation & refactoring**

-   Go to definition, find all references and rename across the mod and the game `Data` tree, including cross-file entities (factions, GUI ids, techs, buffs, resources, components, particle data channels)
-   Type hierarchy over the inheritance graph: from a group that inherits, or that others inherit, up to the bases it writes, including the ones a mod's `AddBase` appends, and down to every group in the project naming it as a base. One level per request, so a base like `Part` opens as a list you expand. "Show Type Hierarchy" in VS Code, the hierarchy window on Ctrl+H in JetBrains
-   "Extract text into a localization key": display text written where a key belongs is moved into every language file the mod ships, you name the key, and the field starts pointing at it. The proposed name follows what the file already does, and a name that is taken gets a number rather than pointing at somebody else's string
-   "Insert the missing field": a group short of a field the game requires gets it written in at the end with the indentation its other members use, one fix per field plus one that writes them all, each scaffolded with a starting value to replace. A field whose value has to name something that exists is reported without a fix rather than filled with a guess
-   "Extract value to shared root field": a code action on a number repeated across several assignments that hoists it into a root field and replaces every occurrence with a reference, following the single-source-of-truth practice from the game's own style guide
-   "Extract shared base file": a group whose fields several other files of the mod write word for word is marked, and the fix writes a new `base_*.rules` beside them holding those fields, rewrites every one of them to inherit it and deletes their own copies, the way the game's own data and the larger mods are built. It finds both files that already share a base and copied files that share no base at all, and `Cosmoteer: Extract Shared Base Files` (also in the JetBrains Tools menu) searches the whole mod at once. A field only moves when it means exactly the same thing from the new file, and the base a file already inherits is carried over so nothing is lost from its chain. When those files are the only things inheriting their base, the fields go into that base file instead of into a new one in front of it. The whole rewrite is shown as a diff before any of it happens
-   "Remove a field the base already supplies": a field written with exactly the value its group inherits is faded out with a remove fix. The chain is followed into the game's own `Data`, so a value copied line for line from a vanilla base is found, and a path is compared as the file it names rather than as the text it is spelled with
-   Refactorings never write to the vanilla game files. `cosmoteerLSPRules.allowEditingVanillaFiles` is the one switch that lifts that, for somebody working on the game data itself: it also makes the `Data` tree visible to the shared-base extraction, which cannot see it otherwise because it carries no mod manifest. Installed workshop mods belong to somebody else and stay off limits either way

**Diagnostics**

-   Syntax errors, unresolved references and assets, math expressions, duplicate keys, inheritance cycles
-   Shapes the game refuses to load at all, which the editor otherwise reads as valid: free text where a member name belongs, a number naming a member, a `{`/`[` block with no name in front of it outside a list, an inheritance with no body, a `/*` no `*/` ever ends, a stray `*/`, a member started on a line the value before it already owns, and a second reference hung on a field by a `,`
-   Block comments the game never closes, because it only ends one when the run of `*` before the closing `/` is odd. A banner like `/****** Section ******/` swallows everything up to the next `*/` when the mod loads, so a file can lose every part it defines while looking correct in the editor. A quick fix drops one `*`
-   Values the game silently never reads: bare valueless fields, unknown members inside a group-typed field's list form, extra list elements and value shapes the field cannot read
-   Missing separators: two fields on one line with no `,`/`;` between them (the game silently reads them as one value) and a run of numbers read as a single list element, each with a quick fix. Conversely, a separator a line break already makes redundant is shown as a subtle hint with a remove quick fix
-   Component references, cross-file GUI ids, localization keys, shader constants and shader code, each toggleable in the settings
-   An id two files of the same mod both register, reported on both and naming the other file, since the game keeps one entry and drops the rest. Only a declaration the mod really wires in counts, so a base file carrying a leftover `ID` is left alone
-   An id that only resolves because another mod is installed on this machine, with a fix that writes that mod into the manifest as a dependency
-   A buff modifier, clamp or toggle naming a buff its own part never receives, which can never move the value it drives. The receivable set is folded through the whole inheritance chain
-   Part grid values the part's own size puts out of the game's reach: a door location inside the part or off its edge, a blocked travel cell or wall entry outside it, and a `PhysicalRect` that leaves the part, which makes the game drop the file
-   `mod.rules` actions: unknown verbs, missing required fields, unresolvable targets
-   The `mod.rules` manifest itself: a missing or malformed `ID` or `Name`, a near-miss field name, and a `StringsFolder`, `Logo` or ship library folder that is not on disk. A key the game does not know but that is nothing like a real field is left alone, because mods keep their own keys there for loaders that ship a `.dll`
-   A version-split `mod_*.rules` without `CompatibleGameVersions`, which the game never selects when the mod has other manifest files, with a quick fix inserting the installed game's version
-   Deprecation hints for symbols changed by game updates, each naming the game version that changed it and carrying a quick fix: renamed `Type=` discriminators (`AmmoStorage`, now `ResourceStorage`), renamed fields the game still accepts (`CreatePartWhenDestroyed`, now `UnderlyingPart`, 0.23.0), deleted fields with their migration (`Flammable`, now the `non_flammable` part category, 0.30.0) and superseded fields (`ExplosiveDamageResistance`, now the `DamageResistances` map, 0.24.0)

**Resolved values**

-   Hover showing the resolved value of a reference, with sprite preview for assets
-   Inlay hints with computed math results (e.g. `Damage = (&Base)/2 + ceil(17/2)  = 14`) and percentages evaluated to their decimal form
-   Units read from the value and from the field alike: `Rotation = -2.5d` shows `= -0.043633 rad (-2.5°)`, `Chance = 200%` shows `= 2 (200%)`, and an angle written without a suffix shows the very large angle in radians the game will really use, which is almost always a missing `d`
-   Hover on a computed value listing the references it substituted, the number each stood for, and the file and line it came from, which is the step the game's own evaluator performs before any arithmetic
-   Hover on a modifiable value listing what its modifiers do to the number, what drives each one, the mode it combines with and the clamp it puts on the result, inherited modifiers in the order they really run, and the range the written clamps prove the value stays inside. A group writing both a `Modifiers` list and a `BuffType` shortcut is told the shortcut is ignored
-   Signature help for math functions, with arity checking for every known function
-   Completion for math-function names inside expressions and on numeric fields, inserted as ready-to-fill call snippets

**Shaders**

-   `.shader` is a full language: HLSL highlighting, completion, hover, signature help, go-to-definition through `#include`s, document outline
-   Shader-constant completion and hover in a material's `Shader = …` block
-   Live WebGL preview (CodeLens or `Cosmoteer: Preview Shader`) that renders the material the way the game does, with live constant controls, updating as you edit

**Mod tooling**

-   Full `mod.rules` manifest support: parsing, validation and completion of `Actions`
-   Mod overview report (CodeLens or `Cosmoteer: Show Mod Overview`): what the manifest does, whether each action target resolves, and which files are unreachable by the game
-   Part grid editor (CodeLens or `Cosmoteer: Edit Part Grid`): cells, doors, walls and component locations edited on the part itself and written straight back into the rules
-   Part wiring report (CodeLens or `Cosmoteer: Show Part Wiring`, also in the JetBrains Tools and editor menus): whether a ship pulls the part's file in at all, whether the build palette has anywhere to show it, which techs and modes offer it, and whether its name and description keys exist in each language the mod ships. A part that loads but is wired into nothing looks perfectly correct otherwise
-   Registering a part in a ship class from the lightbulb: a ship the mod owns gets the part appended to its `Parts` list, a ship of the game install is patched from the mod's `mod.rules` with an `AddMany` action instead, so nothing in the install is touched
-   `Cosmoteer: Show What The Game Loads Here` folds a group's whole inheritance chain into one table: every member the game ends up with, its value, and the file and line it comes from, with an override saying which declaration it hides. Unwritten fields of the class are listed separately with the value the game falls back to, and a base that could not be followed is named as such
-   `Cosmoteer: Explain This Reference` (also in the JetBrains Tools and editor menus) walks the reference under the cursor segment by segment: which hop stopped it, where the last one that worked landed, and every member the game really has at that place, inheritance chain folded in and mod additions included, with the closest name offered when the written one looks like a typo. A `~` path and a `:` path are answered with what the game decides for itself instead of a verdict, since neither can be judged from the file alone
-   `Cosmoteer: Run this Mod in Cosmoteer` links the open mod into the folder the game loads mods from, switches it on in the game's own settings and starts the game with developer mode on. The settings file is edited by splicing the one entry, with a backup beside it, and anything that cannot be established stops the command and says why
-   `Cosmoteer: Import Problems from the Game Log` reads the newest log that mentions this mod and shows what the game threw on the lines it happened on, which is the half of the truth the editor cannot see, since the game reads the files after every mod's actions have been applied
-   One-command migration (`Cosmoteer: Migrate Mod to Current Game Version`, also in the JetBrains Tools menu): applies every known game-update rename, deletion and rewrite across the whole workspace as one undoable edit, reports the fixes grouped by game version, lists the findings that need author judgment, and can optionally strip fields the game never reads. "Preview the migration" works the whole upgrade out and shows it as a side-by-side diff without changing anything
-   Code mod support: a mod that ships a `.dll` gets its own serializable types read straight out of the assembly, so its `Type=` discriminators, fields and enums complete, hover and validate like the game's own. Covers assemblies in the workspace and in the installed workshop mods, needs no .NET install, and refreshes on demand with `Cosmoteer: Rebuild Schema from Code Mod Assemblies` (also in the JetBrains Tools menu)
-   Localization-key completion and hover for `KeyString` fields, with an insert-into-all-strings quick fix
-   Color swatches with an in-place picker, part-category completion
-   Multi-root workspace support, localization (en, de)

## Planned

-   In Depth Diagnostics
-   More useful code actions and refactorings and quick fixes
-   If you have suggestions or ideas, please open an issue on [GitHub](https://github.com/Cosmoteer-Modding-Tools/cosmoteer-lsp/issues)

## Credits

Thanks to the Cosmoteer team for being so open and allowing the schema to be publicly available without modders first needing to generate it, and to the modders who have contributed to the community and provided feedback on this extension.

Special thanks to Walt for the open communication and allowance. Also to Celeste for laying the ground for the JetBrains IDE support and providing valuable input, to Rojamahorse for valuable feedback, testing and a very complex mod to test the extension with, and to SkipperWraith who brought me back to this project.

## Showcase

**Computed values inline.** Inlay hints evaluate the math a field actually resolves to, references included.

![Inlay hints showing computed math results next to a part's stats](https://github.com/Cosmoteer-Modding-Tools/cosmoteer-lsp/blob/master/showcase/inlay_hints.png?raw=true)

**Hover.** A field's type, default and documentation from the game's own classes, plus what the reference resolves to.

![Hover on a field showing its type, documentation and resolved value](https://github.com/Cosmoteer-Modding-Tools/cosmoteer-lsp/blob/master/showcase/hover_field.png?raw=true)

Asset paths hover with a sprite preview.

![Hover on an asset path showing the sprite it resolves to](https://github.com/Cosmoteer-Modding-Tools/cosmoteer-lsp/blob/master/showcase/hover_asset.png?raw=true)

**Completion.** Field names with their type, default and documentation, inserted as ready-to-fill snippets.

![Field-name completion with documentation](https://github.com/Cosmoteer-Modding-Tools/cosmoteer-lsp/blob/master/showcase/completion.png?raw=true)

**Diagnostics.** Unknown fields, invalid enums, unresolved references and assets, missing separators, missing required fields, deprecated symbols.

![Diagnostics in the editor and the Problems panel](https://github.com/Cosmoteer-Modding-Tools/cosmoteer-lsp/blob/master/showcase/diagnostics.png?raw=true)

Most of them come with a quick fix.

![Quick fix suggesting the correct enum value](https://github.com/Cosmoteer-Modding-Tools/cosmoteer-lsp/blob/master/showcase/quick_fix.png?raw=true)

**Live shader preview.** The material rendered the way the game renders it, with the shader's constants as live controls.

![Live WebGL shader preview next to the material's rules](https://github.com/Cosmoteer-Modding-Tools/cosmoteer-lsp/blob/master/showcase/shader_preview.png?raw=true)

**Part grid editor.** Cells, doors, walls and component locations edited on the part itself.

![The part grid editor next to the part's rules](https://github.com/Cosmoteer-Modding-Tools/cosmoteer-lsp/blob/master/showcase/part_grid.png?raw=true)

**Mod overview.** What the manifest does, whether each action target resolves, and which files the game never loads.

![Mod overview report listing the manifest's actions and file reachability](https://github.com/Cosmoteer-Modding-Tools/cosmoteer-lsp/blob/master/showcase/mod_overview.png?raw=true)

**One-command migration.** Every known game-update rename, deletion and rewrite applied across the workspace as one undoable edit.

![Migration summary after upgrading the mod to the current game version](https://github.com/Cosmoteer-Modding-Tools/cosmoteer-lsp/blob/master/showcase/migration.png?raw=true)
