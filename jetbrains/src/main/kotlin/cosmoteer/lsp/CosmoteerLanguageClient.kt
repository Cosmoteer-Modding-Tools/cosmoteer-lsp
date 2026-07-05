package cosmoteer.lsp

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.options.ShowSettingsUtil
import com.intellij.openapi.project.Project
import com.redhat.devtools.lsp4ij.client.LanguageClientImpl
import cosmoteer.settings.CosmoteerSettings
import cosmoteer.settings.CosmoteerSettingsConfigurable
import org.eclipse.lsp4j.jsonrpc.services.JsonRequest
import java.util.concurrent.CompletableFuture

/**
 * Answers the server's `workspace/configuration` pulls from the plugin settings and handles the
 * custom `cosmoteer/openSettings` request the server sends when the game path is missing.
 */
class CosmoteerLanguageClient(private val ijProject: Project) : LanguageClientImpl(ijProject) {
    private val gson = Gson()

    /**
     * Builds the settings JSON LSP4IJ resolves configuration sections against. The server asks
     * for the `cosmoteerLSPRules` section, so the map is nested under that key.
     *
     * @returns the settings wrapped in a one-key object.
     */
    override fun createSettings(): Any {
        val root = JsonObject()
        root.add("cosmoteerLSPRules", gson.toJsonTree(CosmoteerSettings.getInstance().toConfigurationMap()))
        return root
    }

    /**
     * Opens the plugin's settings page. The server requests this after telling the user the
     * Cosmoteer install path is not configured.
     *
     * @param params the VS Code-shaped configuration scope hint, unused here.
     * @returns a completed future, the server ignores the response value.
     */
    @JsonRequest("cosmoteer/openSettings")
    fun openSettings(params: Any?): CompletableFuture<Any?> {
        ApplicationManager.getApplication().invokeLater {
            ShowSettingsUtil.getInstance().showSettingsDialog(ijProject, CosmoteerSettingsConfigurable::class.java)
        }
        return CompletableFuture.completedFuture(null)
    }
}
