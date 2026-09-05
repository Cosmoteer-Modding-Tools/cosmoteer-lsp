# Cosmoteer Language Server for JetBrains IDEs

A JetBrains plugin (Rider first, but any IntelliJ-platform IDE 2024.2+) that runs the same
bundled Node.js language server as the VS Code extension, integrated through
[LSP4IJ](https://plugins.jetbrains.com/plugin/23257-lsp4ij). No Ultimate edition and no
JavaScript plugin required. Node.js is resolved from the settings, then PATH. When neither has
one, the plugin offers to download a private copy of the official Node LTS build
(checksum-pinned, only the `node` executable is kept, stored under the IDE system directory),
so nothing needs to be installed up front.

## Features

Everything the server offers arrives through LSP4IJ: diagnostics (including the cross-file,
component, required-field, shader and localization validators, all on by default), completion with
snippets, hover, go-to-definition, find usages, document/workspace symbols, rename, formatting, quick
fixes, signature help, inlay hints, color swatches, and document links. Editor highlighting
comes from the bundled TextMate grammars for `.rules` and `.shader`, with the server's semantic
tokens painted on top so a reference, a bareword value and a math function no longer all look the
same. The plugin puts that overlay into the editor's markup itself instead of leaving it to
LSP4IJ, so the colors follow the text through an edit rather than dropping out while a request is
still running. It is on by default and can be turned off under Settings | Tools | Cosmoteer Rules.
The plugin also registers TextMate-backed file types, which give the files their icon
and keep the IDE from advertising other marketplace plugins for the extensions while leaving
the actual editing to the TextMate grammar.

Note for Rider with the Unity plugin: Unity's ShaderLab support claims `.shader` too. If a
Cosmoteer shader opens as ShaderLab, reassign the pattern to "Cosmoteer Shader" under
Settings | Editor | File Types.

Client-side features are reimplemented natively:

- **Shader preview**: the same WebGL page as in VS Code, hosted in a JCEF tool window.
  Trigger it from the gutter icon on any `Shader = "….shader"` line, the editor context menu,
  or Tools | Cosmoteer: Preview Shader. It live-updates while you edit the material or its shader.
- **Mod overview**: gutter icon on a `mod.rules`/`mod_*.rules` manifest (or the context menu)
  opens the generated markdown report.
- **Part grid editor**: a tool window that edits a part's grid fields, opened from the gutter icon
  on a `Part` group or Tools | Cosmoteer: Edit Part Grid.
- **Part table**: a tool window comparing every part of the game and of the mod being edited side by
  side, opened from Tools | Cosmoteer: Compare Parts in a Table. Columns are picked from the fields
  the parts really carry, and a formula column computes over them.
- **Migrate mod**: Tools | Cosmoteer: Migrate Mod rewrites a mod for a newer game version.
- **Extract shared base files**: Tools | Cosmoteer: Extract Shared Base Files factors the repeated
  fields of a mod into base files, with a side-by-side diff before anything is written. The same
  refactoring is offered on the duplicate-field hint itself.
- **Build mod schema**: Tools | Cosmoteer: Build Mod Schema reads a code mod's `.dll` types so its
  own rules classes validate.
- **Add ships to a faction**: Tools | Cosmoteer: Add Ships to a Faction, or the project view's
  context menu on `.ship.png` files or a folder of them, registers saved ships in a faction with the
  tier, difficulty and role the server reads off their parts, each open to change first. Wrecks,
  starter ships and storage pods are roles too, and a station gets its stasis icon drawn beside it.
- **New faction**: Tools | Cosmoteer: New Faction asks the id, the name, the border colour, an icon,
  a beacon ship and whether to write a lore page on one dialog, and writes the faction, its galaxy
  entries, its FTL beacon, its lore page, its name and the manifest actions.
- **New nebula**: Tools | Cosmoteer: New Nebula builds a nebula on one of the game's own looks with
  your colours and spawn settings, and writes the nebula, its spawner entry, its creative-mode doodad
  and its texts, wired in from the manifest.
- **New galaxy size**: Tools | Cosmoteer: New Galaxy Size clones the standard map generator with
  your number of systems and offers the size when a new game begins.
- **New asteroid type**: Tools | Cosmoteer: New Asteroid Type writes the deposit tiles, the asteroid
  recipes per size, the spawner entries and the hard conversions for a mineable asteroid yielding a
  resource of your choice, with a look borrowed from the game's own deposits, and the manifest
  actions that wire them in.
- **New planet**: Tools | Cosmoteer: New Planet builds a planet on one of the game's own with
  your name, sizes and a place in career sectors, and writes the doodad, its name key and the
  manifest actions that register and spawn it.
- **Resource in trade**: Tools | Cosmoteer: Resource in Trade makes trade ships carry a resource
  and stations stock or buy it, writing only the two manifest actions the trade reads.
- **New submenu**: every wizard is also one line of the Cosmoteer submenu under New, in the
  project view's right-click menu and under File, with the selected folder as the mod to write into.
- **New content file**: Tools | Cosmoteer: New Content File writes a part, resource, shot, media
  effect, title screen ship, roof decal folder, build toolbar category, part stat line, part
  toggle, buff or codex page and wires it in. A buff is merged into the game's buff map with an
  `Overrides` action and a codex page is appended to the tutorial pages, and the notification
  says what a part or a show condition has to do before the entry appears in game.
- **New tech**: Tools | Cosmoteer: New Tech takes one of your parts, a cost and the prerequisites,
  and writes the tech into the game's tech tree with the part's own name, icon and group.
- **Settings**: Settings | Tools | Cosmoteer Rules mirrors every `cosmoteerLSPRules.*` option.
  Applying pushes the changes to running servers without a restart.

One intentional difference: format-on-save is not a plugin setting (LSP4IJ has no
`willSaveWaitUntil`). Use Settings | Tools | Actions on Save | Reformat code instead.

## Building

```bash
npm run compile          # at the repo root: esbuild produces out/server/src/server.mjs
cd jetbrains
./gradlew buildPlugin    # zip in build/distributions/
```

Gradle needs JDK 17–21 (`JAVA_HOME="C:\Program Files\Java\jdk-21"` on this machine). The Gradle
build stages the server bundle, `media/`, `l10n/`, and the TextMate bundle next to the plugin
jar. It does not run esbuild, so build the server first.

## Running a sandbox IDE

```bash
# IntelliJ IDEA Community sandbox:
./gradlew runIde
# Rider sandbox (primary target):
./gradlew runRider
```

Open any folder containing `.rules` files. The language server starts on the first opened
`.rules`/`.shader` file (see the LSP console under the LSP4IJ tool window for its state and logs).

## Verifying

```bash
./gradlew verifyPlugin   # IntelliJ Plugin Verifier against IC + Rider
node ../.claude/skills/run-cosmoteer-lsp/jetbrains-driver.mjs   # protocol smoke test of the staged bundle
```
