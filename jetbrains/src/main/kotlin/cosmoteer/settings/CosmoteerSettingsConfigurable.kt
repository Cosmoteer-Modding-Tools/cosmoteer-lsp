package cosmoteer.settings

import com.intellij.openapi.fileChooser.FileChooserDescriptor
import com.intellij.openapi.options.BoundConfigurable
import com.intellij.openapi.ui.DialogPanel
import com.intellij.ui.dsl.builder.AlignX
import com.intellij.ui.dsl.builder.bindIntText
import com.intellij.ui.dsl.builder.bindItem
import com.intellij.ui.dsl.builder.bindSelected
import com.intellij.ui.dsl.builder.bindText
import com.intellij.ui.dsl.builder.panel
import com.intellij.ui.dsl.builder.toNullableProperty

/**
 * The Settings | Tools | Cosmoteer Rules page. Mirrors the VS Code extension's
 * `cosmoteerLSPRules.*` settings. Applying pushes a `workspace/didChangeConfiguration` so running
 * servers re-pull their configuration without a restart.
 */
class CosmoteerSettingsConfigurable : BoundConfigurable("Cosmoteer Rules") {
    private val state = CosmoteerSettings.getInstance().state

    override fun createPanel(): DialogPanel = panel {
        group("Paths") {
            row("Cosmoteer installation path:") {
                textFieldWithBrowseButton(
                    // Single-folder descriptor built directly, same reason as the Node.js picker
                    // below: the FileChooserDescriptorFactory helpers are being deprecated release
                    // by release, while this constructor is only obsolete. Args: chooseFiles,
                    // chooseFolders, chooseJars, chooseJarsAsFiles, chooseJarContents, chooseMultiple.
                    FileChooserDescriptor(false, true, false, false, false, false)
                        .withTitle("Select the Cosmoteer Installation Folder")
                )
                    .align(AlignX.FILL)
                    .bindText(state::cosmoteerPath)
                    .comment("The game folder, used to resolve vanilla files and assets. Required for most features.")
            }
            row("Node.js executable:") {
                textFieldWithBrowseButton(
                    // Build the single-file descriptor directly: the FileChooserDescriptorFactory
                    // single-file helpers are all deprecated from 2025.2 on, while this constructor
                    // is only marked obsolete (which the verifier ignores) and exists since the 243
                    // floor. Args: chooseFiles, chooseFolders, chooseJars, chooseJarsAsFiles,
                    // chooseJarContents, chooseMultiple.
                    FileChooserDescriptor(true, false, false, false, false, false)
                        .withTitle("Select the Node.js Executable")
                )
                    .align(AlignX.FILL)
                    .bindText(state::nodePath)
                    .comment(
                        "Leave empty to use the node found on PATH, or the private runtime the plugin " +
                        "offers to download when there is none. The language server runs on Node.js."
                    )
            }
            row("Ignored paths:") {
                expandableTextField(
                    { it.split(';').map(String::trim).filter(String::isNotEmpty).toMutableList() },
                    { it.joinToString(";") }
                )
                    .align(AlignX.FILL)
                    .bindText(
                        { state.ignorePaths.joinToString(";") },
                        { state.ignorePaths = it.split(';').map(String::trim).filter(String::isNotEmpty).toMutableList() }
                    )
                    .comment("Semicolon-separated folders the validators skip.")
            }
        }
        group("Diagnostics") {
            row("Maximum number of problems:") {
                intTextField(0..100000).bindIntText(state::maxNumberOfProblems)
            }
            row {
                checkBox("Validate the whole workspace, not only open files")
                    .bindSelected(state::validateWholeWorkspace)
                    .comment(
                        "On by default, so the Problems view describes the mod rather than the open tabs. " +
                        "Results are cached on disk per file, so only the first open of a project pays for " +
                        "the scan. Turn off on a low-memory machine."
                    )
            }
            row("Workspace validation scope:") {
                comboBox(listOf("modRulesReachable", "allFiles"))
                    .bindItem(state::workspaceValidationScope.toNullableProperty())
                    .comment(
                        "modRulesReachable (the default) validates only what the game loads: the mod.rules " +
                        "action sources, their includes and inheritance, and the strings folder, so backups " +
                        "and templates stay out. A project with no manifest is unrestricted either way."
                    )
            }
            row { checkBox("Validate component references").bindSelected(state::validateComponentReferences) }
            row { checkBox("Validate cross-file references").bindSelected(state::validateCrossFileReferences) }
            row { checkBox("Validate required fields").bindSelected(state::validateRequiredFields) }
            row { checkBox("Validate shader constants").bindSelected(state::validateShaderConstants) }
            row { checkBox("Validate shader code").bindSelected(state::validateShaderCode) }
            row { checkBox("Validate localization keys").bindSelected(state::validateLocalizationKeys) }
            row { checkBox("Hint at redundant separators").bindSelected(state::validateRedundantSeparators) }
            row { checkBox("Hint at fields the game ignores").bindSelected(state::validateIgnoredFields) }
            row { checkBox("Fade fields written at their default").bindSelected(state::validateDefaultValues) }
        }
        group("Code mods") {
            row {
                checkBox("Understand mods that ship a .dll")
                    .bindSelected(state::codeModsEnabled)
                    .comment(
                        "Reads the types, fields and 'Type=' values a mod's assembly declares and merges " +
                        "them into the schema, so a modded component completes, hovers and validates like " +
                        "a built-in one. Covers the open project, the installed workshop mods and your own " +
                        "Mods folder. Off means those types are reported as unknown."
                    )
            }
            row {
                checkBox("Pick up mod changes automatically")
                    .bindSelected(state::codeModsAutoRefresh)
                    .comment(
                        "Watches the assemblies the schema was built from, so a mod installed, updated or " +
                        "rebuilt while the IDE is open is merged on its own. Off means only " +
                        "Tools | Cosmoteer | Rebuild Schema from Code Mod Assemblies updates it."
                    )
            }
        }
        group("Editing") {
            row {
                checkBox("Show the referenced group's BaseValue as an inlay hint")
                    .bindSelected(state::inlayShowBaseValue)
                    .comment("A reference to a group with a BaseValue member renders '/BaseValue = 160d' inline.")
            }
            row { checkBox("Allow rename to edit vanilla files").bindSelected(state::allowEditingVanillaFiles) }
            row { checkBox("Enable formatting").bindSelected(state::formattingEnabled) }
            row {
                checkBox("Semantic highlighting from the language server")
                    .bindSelected(state::semanticTokensEnabled)
                    .comment(
                        "Re-colors identifiers with the server's semantic tokens on top of the built-in " +
                        "highlighting. The overlay arrives asynchronously after each edit, which can look " +
                        "like flickering colors, so it is off by default."
                    )
            }
            row("Server trace:") {
                comboBox(listOf("off", "messages", "verbose"))
                    .bindItem(state::traceServer.toNullableProperty())
            }
        }
        group("Decompiler") {
            row {
                checkBox("End schema hovers with an 'Open in decompiler' link")
                    .bindSelected(state::decompilerShowInHover)
                    .comment(
                        "Power user: the link opens the hovered field's owning C# class from the game's " +
                        "assemblies in ILSpy or dotPeek. Installs are found automatically, so the path " +
                        "below is only needed when that fails."
                    )
            }
            row("Decompiler executable:") {
                textFieldWithBrowseButton(
                    // Single-file descriptor, built directly for the same deprecation reason as the
                    // pickers above. Args: chooseFiles, chooseFolders, chooseJars, chooseJarsAsFiles,
                    // chooseJarContents, chooseMultiple.
                    FileChooserDescriptor(true, false, false, false, false, false)
                        .withTitle("Select the Decompiler Executable")
                )
                    .align(AlignX.FILL)
                    .bindText(state::decompilerExecutablePath)
                    .comment("Leave empty to auto-detect ILSpy or dotPeek (PATH and the usual install locations).")
            }
            row("Command-line style:") {
                comboBox(listOf("auto", "ilspy", "dotpeek"))
                    .bindItem(state::decompilerTool.toNullableProperty())
                    .comment("'auto' infers ILSpy or dotPeek from the executable's file name.")
            }
        }
    }

    override fun apply() {
        super.apply()
        // Pushes the saved settings to every running server, so the change lands without a restart.
        CosmoteerSettings.notifyRunningServers()
    }
}
