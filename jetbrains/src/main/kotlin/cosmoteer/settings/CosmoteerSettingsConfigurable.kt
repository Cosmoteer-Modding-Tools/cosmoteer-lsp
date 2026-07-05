package cosmoteer.settings

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.intellij.openapi.fileChooser.FileChooserDescriptor
import com.intellij.openapi.options.BoundConfigurable
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.ui.DialogPanel
import com.intellij.ui.dsl.builder.AlignX
import com.intellij.ui.dsl.builder.bindIntText
import com.intellij.ui.dsl.builder.bindItem
import com.intellij.ui.dsl.builder.bindSelected
import com.intellij.ui.dsl.builder.bindText
import com.intellij.ui.dsl.builder.panel
import com.intellij.ui.dsl.builder.toNullableProperty
import com.redhat.devtools.lsp4ij.LanguageServerManager
import org.eclipse.lsp4j.DidChangeConfigurationParams

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
            }
            row("Workspace validation scope:") {
                comboBox(listOf("allFiles", "modRulesReachable"))
                    .bindItem(state::workspaceValidationScope.toNullableProperty())
                    .comment("With modRulesReachable only files reachable from a mod.rules manifest are validated.")
            }
            row { checkBox("Validate component references").bindSelected(state::validateComponentReferences) }
            row { checkBox("Validate cross-file references").bindSelected(state::validateCrossFileReferences) }
            row { checkBox("Validate required fields").bindSelected(state::validateRequiredFields) }
            row { checkBox("Validate shader constants").bindSelected(state::validateShaderConstants) }
            row { checkBox("Validate shader code").bindSelected(state::validateShaderCode) }
            row { checkBox("Validate localization keys").bindSelected(state::validateLocalizationKeys) }
            row { checkBox("Hint at redundant separators").bindSelected(state::validateRedundantSeparators) }
        }
        group("Editing") {
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
    }

    override fun apply() {
        super.apply()
        notifyRunningServers()
    }

    /**
     * Sends `workspace/didChangeConfiguration` to every project's running server. The server
     * ignores the payload under the pull model and re-requests `workspace/configuration`, which is
     * answered from the just-saved settings.
     */
    private fun notifyRunningServers() {
        val settingsJson = JsonObject().apply {
            add("cosmoteerLSPRules", Gson().toJsonTree(CosmoteerSettings.getInstance().toConfigurationMap()))
        }
        for (project in ProjectManager.getInstance().openProjects) {
            LanguageServerManager.getInstance(project)
                .getLanguageServer("cosmoteerLanguageServer")
                .thenAccept { item ->
                    item?.server?.workspaceService?.didChangeConfiguration(DidChangeConfigurationParams(settingsJson))
                }
        }
    }
}
