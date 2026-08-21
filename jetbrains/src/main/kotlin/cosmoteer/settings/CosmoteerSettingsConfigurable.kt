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
import cosmoteer.highlight.CosmoteerSemanticHighlightService

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
                    .comment("Semicolon-separated fragments. A reference whose written path contains one is not checked.")
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
            row { checkBox("Warn about comments the game does not close").bindSelected(state::validateUnclosedComments) }
            row { checkBox("Fade fields written at their default").bindSelected(state::validateDefaultValues) }
            row { checkBox("Fade constants nothing reads").bindSelected(state::validateUnusedConstants) }
            row {
                checkBox("Hint at fields several files write the same way")
                    .bindSelected(state::validateDuplicateFields)
                    .comment(
                        "Marks a group whose fields other files of the mod repeat word for word, and carries " +
                        "the 'extract shared base' refactoring that moves them into one base file all of them " +
                        "inherit. Off removes the hint and the offer, while " +
                        "Tools | Cosmoteer: Extract Shared Base Files still works."
                    )
            }
            row {
                checkBox("Fade fields whose value the base already supplies")
                    .bindSelected(state::validateRedundantOverrides)
                    .comment(
                        "Marks a field written with exactly the value the group inherits, so deleting it " +
                        "leaves the game where it is. Carries a remove fix."
                    )
            }
            row {
                checkBox("Check the mod.rules manifest")
                    .bindSelected(state::validateModManifest)
                    .comment(
                        "Reports a missing or malformed ID or Name, without which the mod never loads, " +
                        "a field name that is a near miss of a real one, and a declared strings folder, " +
                        "logo or ship library folder that is not on disk."
                    )
            }
            row {
                checkBox("Flag an id two files of the mod both register")
                    .bindSelected(state::validateDuplicateIds)
                    .comment(
                        "The game keeps one entry and drops the rest. Only declarations the mod " +
                        "really wires in count, so an inheritance template with a leftover ID is " +
                        "left alone."
                    )
            }
            row {
                checkBox("Report a dependency the manifest does not declare")
                    .bindSelected(state::validateUndeclaredDependencies)
                    .comment(
                        "An id that only resolves because another mod is installed here reads as " +
                        "correct on this machine and names nothing for anybody else. The fix writes " +
                        "the mod into the manifest's Dependencies."
                    )
            }
            row {
                checkBox("Report a buff the part can never receive")
                    .bindSelected(state::validateUnreceivableBuffs)
                    .comment(
                        "A buff modifier, clamp or toggle naming a buff outside the part's own " +
                        "ReceivableBuffs never moves, since the game hands a part a buff only " +
                        "while that part is registered as a receiver of it."
                    )
            }
            row {
                checkBox("Check part grid geometry")
                    .bindSelected(state::validatePartGeometry)
                    .comment(
                        "Fades a door location that is not a cell beside the part, and a blocked cell " +
                        "or per-cell map key outside it, none of which the game reads. A PhysicalRect " +
                        "leaving the part is an error, since the game refuses to load such a part."
                    )
            }
            row {
                checkBox("Check that declared paths exist")
                    .bindSelected(state::validatePaths)
                    .comment(
                        "Reports a music track, a markov name file or a declared folder that is not " +
                        "on disk. These carry an extension only the game knows, so the asset check " +
                        "never reaches them."
                    )
            }
            row {
                checkBox("Check render layers")
                    .bindSelected(state::validateRenderLayers)
                    .comment(
                        "Reports a sprite naming a render layer the ship that draws it does not " +
                        "declare. The game looks the layer up in that ship's own map and throws " +
                        "the first time the part is drawn, so a typo and a layer borrowed from " +
                        "another ship class both crash rather than draw nothing."
                    )
            }
            row {
                checkBox("Check damage level sprite geometry")
                    .bindSelected(state::validateSpriteGeometry)
                    .comment(
                        "Hints at a damage level whose art is stretched differently from the other " +
                        "levels of its list, which squashes or rotates the sprite the moment the " +
                        "part takes that damage."
                    )
            }
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
            row {
                checkBox("Show what a computed value's references stood for")
                    .bindSelected(state::hoverShowSubstitutions)
                    .comment(
                        "A hover over a computed value lists each reference it substituted, the number " +
                        "it stood for, and the file and line that number was read from."
                    )
            }
            row {
                checkBox("Show what a modifiable value's modifiers do to it")
                    .bindSelected(state::hoverShowModifiers)
                    .comment(
                        "A hover over a modifiable value lists each modifier, what drives it, the clamp " +
                        "it puts on the result, and which part supplies the buff."
                    )
            }
            row {
                checkBox("Allow refactorings to edit vanilla files")
                    .bindSelected(state::allowEditingVanillaFiles)
                    .comment(
                        "Lets rename reach into the game's Data folder, and lets the shared-base " +
                        "extraction treat it as a project of its own, which it cannot do otherwise " +
                        "because the game tree carries no mod manifest. Installed workshop mods stay " +
                        "off limits either way."
                    )
            }
            row { checkBox("Enable formatting").bindSelected(state::formattingEnabled) }
            row {
                checkBox("Semantic highlighting from the language server")
                    .bindSelected(state::semanticTokensEnabled)
                    .comment(
                        "Re-colors identifiers with what the server knows they mean, on top of the " +
                        "built-in highlighting: a reference, a bareword value and a math function no " +
                        "longer all look the same."
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
        // The semantic overlay is painted by the plugin, not by the server, so its switch has to
        // reach the service as well. Without this the open editors keep the old state until they
        // are closed and opened again.
        CosmoteerSemanticHighlightService.refreshOpenProjects()
    }
}
