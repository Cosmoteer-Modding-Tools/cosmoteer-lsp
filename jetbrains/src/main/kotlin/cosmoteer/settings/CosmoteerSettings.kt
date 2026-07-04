package cosmoteer.settings

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage

/**
 * Application-level settings for the Cosmoteer language server, mirroring the
 * `cosmoteerLSPRules.*` configuration surface of the VS Code extension. The values are handed to
 * the server verbatim through the `workspace/configuration` request, so the map produced by
 * [toConfigurationMap] must stay aligned with the server's `CosmoteerSettings` shape in
 * `server/src/settings.ts`.
 */
@State(name = "CosmoteerLspSettings", storages = [Storage("cosmoteer-lsp.xml")])
class CosmoteerSettings : PersistentStateComponent<CosmoteerSettings.SettingsState> {

    /** The bag of persisted values. Public vars so the XML serializer and the settings UI can reach them. */
    class SettingsState {
        var nodePath: String = ""
        var cosmoteerPath: String = ""
        var ignorePaths: MutableList<String> = mutableListOf()
        var maxNumberOfProblems: Int = 100
        var traceServer: String = "off"
        var validateWholeWorkspace: Boolean = false
        var workspaceValidationScope: String = "allFiles"
        var validateComponentReferences: Boolean = true
        var validateCrossFileReferences: Boolean = true
        var validateRequiredFields: Boolean = true
        var validateShaderConstants: Boolean = true
        var validateShaderCode: Boolean = true
        var validateLocalizationKeys: Boolean = true
        var allowEditingVanillaFiles: Boolean = false
        var formattingEnabled: Boolean = true
        /**
         * JetBrains-only, not sent to the server: whether LSP semantic tokens re-color the editor
         * on top of the TextMate highlighting. Off by default because the overlay re-applies
         * asynchronously after every edit, which reads as constant color flicker.
         */
        var semanticTokensEnabled: Boolean = false
    }

    private var state = SettingsState()

    override fun getState(): SettingsState = state

    override fun loadState(state: SettingsState) {
        this.state = state
    }

    /**
     * Renders the settings as the JSON-compatible map the server expects for the
     * `cosmoteerLSPRules` configuration section.
     *
     * @returns a nested map matching the server-side `CosmoteerSettings` type.
     */
    fun toConfigurationMap(): Map<String, Any> = mapOf(
        "maxNumberOfProblems" to state.maxNumberOfProblems,
        "cosmoteerPath" to state.cosmoteerPath,
        "trace" to mapOf("server" to state.traceServer),
        "ignorePaths" to state.ignorePaths.toList(),
        "diagnostics" to mapOf(
            "validateWholeWorkspace" to state.validateWholeWorkspace,
            "workspaceValidationScope" to state.workspaceValidationScope,
            "validateComponentReferences" to state.validateComponentReferences,
            "validateCrossFileReferences" to state.validateCrossFileReferences,
            "validateRequiredFields" to state.validateRequiredFields,
            "validateShaderConstants" to state.validateShaderConstants,
            "validateShaderCode" to state.validateShaderCode,
            "validateLocalizationKeys" to state.validateLocalizationKeys,
        ),
        "rename" to mapOf("allowEditingVanillaFiles" to state.allowEditingVanillaFiles),
        // Format-on-save is intentionally not exposed: LSP4IJ has no willSaveWaitUntil, JetBrains
        // users get the same behavior from Settings | Tools | Actions on Save | Reformat code.
        "formatting" to mapOf(
            "enabled" to state.formattingEnabled,
            "formatOnSave" to false,
        ),
    )

    companion object {
        /** The single application-wide instance backing every project's language server. */
        fun getInstance(): CosmoteerSettings =
            ApplicationManager.getApplication().getService(CosmoteerSettings::class.java)
    }
}
