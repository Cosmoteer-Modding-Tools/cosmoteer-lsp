package cosmoteer.lsp

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.options.ShowSettingsUtil
import com.intellij.openapi.project.Project
import com.redhat.devtools.lsp4ij.client.LanguageClientImpl
import cosmoteer.settings.CosmoteerSettings
import cosmoteer.settings.CosmoteerSettingsConfigurable
import org.eclipse.lsp4j.jsonrpc.services.JsonNotification
import org.eclipse.lsp4j.jsonrpc.services.JsonRequest
import java.util.concurrent.CompletableFuture

/**
 * Answers the server's `workspace/configuration` pulls from the plugin settings and handles the
 * custom requests and notifications the server sends: `cosmoteer/openSettings` when the game path
 * is missing, and `cosmoteer/workspaceValidated` after a whole-mod validation pass.
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

    /**
     * Tells the user once that the whole mod is validated, not only the open files, and offers the
     * switch. The server reports every pass that did real work; showing it at most once is this
     * side's business, since the plugin owns the persistent state.
     *
     * @param params the server's report: `files`, `fresh`, `elapsedMs` and the `scope` used.
     */
    @JsonNotification("cosmoteer/workspaceValidated")
    fun workspaceValidated(params: Any?) {
        val settings = CosmoteerSettings.getInstance()
        if (settings.state.workspaceValidationNoticeShown) return
        settings.state.workspaceValidationNoticeShown = true

        val report = gson.toJsonTree(params) as? JsonObject
        val files = report?.get("files")?.asInt ?: 0
        val wholeMod = report?.get("scope")?.asString == "modRulesReachable"
        val what = if (wholeMod) "$files files your mod.rules actions load" else "$files files"
        ApplicationManager.getApplication().invokeLater {
            if (ijProject.isDisposed) return@invokeLater
            NotificationGroupManager.getInstance()
                .getNotificationGroup("Cosmoteer Language Server")
                .createNotification(
                    "Cosmoteer: validating the whole mod",
                    "Problems now cover the whole mod, not only the files you have open ($what). " +
                        "Results are cached, so later starts are fast.",
                    NotificationType.INFORMATION
                )
                .addAction(NotificationAction.createSimple("Only open files") {
                    settings.state.validateWholeWorkspace = false
                    CosmoteerSettings.notifyRunningServers()
                })
                .addAction(NotificationAction.createSimple("Settings") {
                    ShowSettingsUtil.getInstance().showSettingsDialog(ijProject, CosmoteerSettingsConfigurable::class.java)
                })
                .notify(ijProject)
        }
    }
}
