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
- **Migrate mod**: Tools | Cosmoteer: Migrate Mod rewrites a mod for a newer game version.
- **Extract shared base files**: Tools | Cosmoteer: Extract Shared Base Files factors the repeated
  fields of a mod into base files, with a side-by-side diff before anything is written. The same
  refactoring is offered on the duplicate-field hint itself.
- **Build mod schema**: Tools | Cosmoteer: Build Mod Schema reads a code mod's `.dll` types so its
  own rules classes validate.
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
