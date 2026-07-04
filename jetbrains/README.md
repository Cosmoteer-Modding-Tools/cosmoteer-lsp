# Cosmoteer Language Server for JetBrains IDEs

A JetBrains plugin (Rider first, but any IntelliJ-platform IDE 2024.2+) that runs the same
bundled Node.js language server as the VS Code extension, integrated through
[LSP4IJ](https://plugins.jetbrains.com/plugin/23257-lsp4ij). No Ultimate edition and no
JavaScript plugin required. Node.js is resolved from the settings, then PATH. When neither has
one, the plugin offers to download a private copy of the official Node LTS build
(checksum-pinned, only the `node` executable is kept, stored under the IDE system directory),
so nothing needs to be installed up front.

## Features

Everything the server offers arrives through LSP4IJ: diagnostics (including the opt-in
cross-file/component/required-field/shader/localization validators), completion with snippets,
hover, go-to-definition, find usages, document/workspace symbols, rename, formatting, quick
fixes, signature help, inlay hints, color swatches, and document links. Editor highlighting
comes from the bundled TextMate grammars for `.rules` and `.shader`. LSP semantic tokens can be
layered on top through a setting (off by default, the asynchronous overlay repaint reads as
flicker). The plugin also registers TextMate-backed file types, which give the files their icon
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
- **Settings**: Settings | Tools | Cosmoteer Rules mirrors every `cosmoteerLSPRules.*` option.
  Applying pushes the changes to running servers without a restart.

One intentional difference: format-on-save is not a plugin setting (LSP4IJ has no
`willSaveWaitUntil`). Use Settings | Tools | Actions on Save | Reformat code instead.

## Building

```bash
npm run compile          # at the repo root: esbuild produces out/server/src/server.js
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
