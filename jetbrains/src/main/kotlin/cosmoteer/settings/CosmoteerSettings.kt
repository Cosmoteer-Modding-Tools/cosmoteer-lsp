package cosmoteer.settings

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.project.ProjectManager
import com.redhat.devtools.lsp4ij.LanguageServerManager
import org.eclipse.lsp4j.DidChangeConfigurationParams

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
        var validateWholeWorkspace: Boolean = true
        var workspaceValidationScope: String = "modRulesReachable"
        var validateComponentReferences: Boolean = true
        var validateCrossFileReferences: Boolean = true
        var validateRequiredFields: Boolean = true
        var validateShaderConstants: Boolean = true
        var validateShaderCode: Boolean = true
        var validateLocalizationKeys: Boolean = true
        var validateRedundantSeparators: Boolean = true
        var validateIgnoredFields: Boolean = true
        var validateUnclosedComments: Boolean = true
        var validateDefaultValues: Boolean = true
        var validateUnusedConstants: Boolean = true
        var validateDuplicateFields: Boolean = true
        var validateRedundantOverrides: Boolean = true
        var validateModManifest: Boolean = true
        var validatePartGeometry: Boolean = true
        var validateDuplicateIds: Boolean = true
        var validateUndeclaredDependencies: Boolean = true
        var validateUnreceivableBuffs: Boolean = true
        var validatePaths: Boolean = true
        var validateSpriteGeometry: Boolean = true
        var validateRenderLayers: Boolean = true
        var validateUnusedParticleChannels: Boolean = true
        var validateModConflicts: Boolean = true
        var validateInertFields: Boolean = true
        var validateLocalizationCoverage: Boolean = true
        var validateMarkerVocabulary: Boolean = true
        var validateEffectBuckets: Boolean = true
        var validateUnderlyingParts: Boolean = true
        var validateBulletComponents: Boolean = true
        var validateChainedBuffReceivable: Boolean = true
        var validateValueRanges: Boolean = true
        var validateTextMarkup: Boolean = true
        var validateChainedToCycles: Boolean = true
        var validateMishandledFields: Boolean = true
        var validateRefusedEnumValues: Boolean = true
        var validateBlendSpriteCodes: Boolean = true
        var validateIndicatorIndexes: Boolean = true
        var codeModsEnabled: Boolean = true
        var codeModsAutoRefresh: Boolean = true
        var codeLensShowFileReachability: Boolean = true
        var inlayShowBaseValue: Boolean = true
        var inlayShowTargetValue: Boolean = true
        var hoverShowSubstitutions: Boolean = true
        var hoverShowModifiers: Boolean = true
        var hoverShowProvenance: Boolean = true
        var allowEditingVanillaFiles: Boolean = false
        var formattingEnabled: Boolean = true
        var decompilerShowInHover: Boolean = false
        var decompilerExecutablePath: String = ""
        var decompilerTool: String = "auto"
        /**
         * JetBrains-only, not sent to the server: whether LSP semantic tokens re-color the editor
         * on top of the TextMate highlighting. On by default since the plugin paints the tokens
         * itself (see CosmoteerSemanticHighlightService), which is what removed the flicker the
         * option used to warn about.
         */
        var semanticTokensEnabled: Boolean = true
        /**
         * JetBrains-only, not sent to the server: whether the user has already been told that the
         * whole mod is validated, not only the open files. Shown at most once, the first time a
         * pass does real work.
         */
        var workspaceValidationNoticeShown: Boolean = false
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
            "validateRedundantSeparators" to state.validateRedundantSeparators,
            "validateIgnoredFields" to state.validateIgnoredFields,
            "validateUnclosedComments" to state.validateUnclosedComments,
            "validateDefaultValues" to state.validateDefaultValues,
            "validateUnusedConstants" to state.validateUnusedConstants,
            "validateDuplicateFields" to state.validateDuplicateFields,
            "validateRedundantOverrides" to state.validateRedundantOverrides,
            "validateModManifest" to state.validateModManifest,
            "validatePartGeometry" to state.validatePartGeometry,
            "validateDuplicateIds" to state.validateDuplicateIds,
            "validateUndeclaredDependencies" to state.validateUndeclaredDependencies,
            "validateUnreceivableBuffs" to state.validateUnreceivableBuffs,
            "validatePaths" to state.validatePaths,
            "validateSpriteGeometry" to state.validateSpriteGeometry,
            "validateRenderLayers" to state.validateRenderLayers,
            "validateUnusedParticleChannels" to state.validateUnusedParticleChannels,
            "validateModConflicts" to state.validateModConflicts,
            "validateInertFields" to state.validateInertFields,
            "validateLocalizationCoverage" to state.validateLocalizationCoverage,
            "validateMarkerVocabulary" to state.validateMarkerVocabulary,
            "validateEffectBuckets" to state.validateEffectBuckets,
            "validateUnderlyingParts" to state.validateUnderlyingParts,
            "validateBulletComponents" to state.validateBulletComponents,
            "validateChainedBuffReceivable" to state.validateChainedBuffReceivable,
            "validateValueRanges" to state.validateValueRanges,
            "validateTextMarkup" to state.validateTextMarkup,
            "validateChainedToCycles" to state.validateChainedToCycles,
            "validateMishandledFields" to state.validateMishandledFields,
            "validateRefusedEnumValues" to state.validateRefusedEnumValues,
            "validateBlendSpriteCodes" to state.validateBlendSpriteCodes,
            "validateIndicatorIndexes" to state.validateIndicatorIndexes,
        ),
        "codeMods" to mapOf(
            "enabled" to state.codeModsEnabled,
            "autoRefresh" to state.codeModsAutoRefresh,
        ),
        "codeLens" to mapOf(
            "showFileReachability" to state.codeLensShowFileReachability,
        ),
        "inlayHints" to mapOf(
            "showBaseValue" to state.inlayShowBaseValue,
            "showTargetValue" to state.inlayShowTargetValue,
        ),
        "hover" to mapOf(
            "showSubstitutions" to state.hoverShowSubstitutions,
            "showModifiers" to state.hoverShowModifiers,
            "showProvenance" to state.hoverShowProvenance,
        ),
        "allowEditingVanillaFiles" to state.allowEditingVanillaFiles,
        "decompiler" to mapOf(
            "showInHover" to state.decompilerShowInHover,
            "executablePath" to state.decompilerExecutablePath,
            "tool" to state.decompilerTool,
        ),
        // Format-on-save is intentionally not exposed: LSP4IJ has no willSaveWaitUntil, JetBrains
        // users get the same behavior from Settings | Tools | Actions on Save | Reformat code.
        "formatting" to mapOf(
            "enabled" to state.formattingEnabled,
            "formatOnSave" to false,
        ),
    )

    companion object {
        /**
         * Looks up the application-level settings service.
         *
         * @returns the single application-wide instance backing every project's language server.
         */
        fun getInstance(): CosmoteerSettings =
            ApplicationManager.getApplication().getService(CosmoteerSettings::class.java)

        /**
         * Sends `workspace/didChangeConfiguration` to every project's running server. The server
         * ignores the payload under the pull model and re-requests `workspace/configuration`, which
         * is answered from the just-saved settings, so a change lands without a restart.
         *
         * Shared by the settings page and by anything else that writes a setting on the user's
         * behalf, such as the whole-mod validation notice's "Only open files" action.
         */
        fun notifyRunningServers() {
            val settingsJson = JsonObject().apply {
                add("cosmoteerLSPRules", Gson().toJsonTree(getInstance().toConfigurationMap()))
            }
            for (project in ProjectManager.getInstance().openProjects) {
                LanguageServerManager.getInstance(project)
                    .getLanguageServer(SERVER_ID)
                    .thenAccept { item ->
                        item?.server?.workspaceService?.didChangeConfiguration(DidChangeConfigurationParams(settingsJson))
                    }
            }
        }

        /** The LSP4IJ server id the plugin registers the Cosmoteer server under. */
        private const val SERVER_ID = "cosmoteerLanguageServer"
    }
}
