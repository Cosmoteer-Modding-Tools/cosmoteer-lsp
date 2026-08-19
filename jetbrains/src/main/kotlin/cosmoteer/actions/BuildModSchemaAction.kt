package cosmoteer.actions

import com.google.gson.JsonObject
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.redhat.devtools.lsp4ij.LanguageServerManager
import cosmoteer.preview.ShaderPreviewService
import org.eclipse.lsp4j.ExecuteCommandParams
import cosmoteer.lsp.commandResultOf

/**
 * Rebuilds the schema contributed by code mods: asks the language server to re-read every mod
 * assembly in the project and the installed workshop tree and merge the serializable types it
 * declares into the schema, so those mods' own `Type=` discriminators and fields resolve everywhere.
 * The server already loads the cached result at startup, so this is for picking up a mod that was
 * just built or installed. Mirrors the VS Code `cosmoteer.buildModSchemaFromMods` command.
 */
class BuildModSchemaAction : AnAction() {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(event: AnActionEvent) {
        event.presentation.isEnabledAndVisible = event.project != null
    }

    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        LanguageServerManager.getInstance(project)
            .getLanguageServer(ShaderPreviewService.SERVER_ID)
            .thenCompose { item ->
                item?.server?.workspaceService
                    ?.executeCommand(ExecuteCommandParams(COMMAND, emptyList()))
                    ?: java.util.concurrent.CompletableFuture.completedFuture<Any?>(null)
            }
            .thenAccept { result -> showSummary(project, result) }
    }

    /**
     * Reports what the rebuild merged, as a notification.
     *
     * @param project the project the notification belongs to.
     * @param result the raw `workspace/executeCommand` result (a Gson tree or null).
     */
    private fun showSummary(project: Project, result: Any?) {
        val summary = commandResultOf(result)
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) return@invokeLater
            val group = NotificationGroupManager.getInstance().getNotificationGroup("Cosmoteer Language Server")
            if (summary == null) {
                group.createNotification(
                    "Cosmoteer code mod schema",
                    "The rebuild did not run (no workspace folder, or the server is not ready).",
                    NotificationType.WARNING
                ).notify(project)
                return@invokeLater
            }
            if (summary.get("disabled")?.asBoolean == true) {
                group.createNotification(
                    "Cosmoteer code mod schema",
                    "Code mod support is turned off (Settings | Tools | Cosmoteer Rules | Code mods).",
                    NotificationType.INFORMATION
                ).notify(project)
                return@invokeLater
            }
            val types = summary.get("types")?.asInt ?: 0
            val discriminators = summary.get("discriminators")?.asInt ?: 0
            val assemblies = summary.get("assemblies")?.asInt ?: 0
            if (types == 0) {
                group.createNotification(
                    "Cosmoteer code mod schema",
                    "No code mod assemblies found, nothing to add.",
                    NotificationType.INFORMATION
                ).notify(project)
                return@invokeLater
            }
            group.createNotification(
                "Cosmoteer code mod schema",
                "Added $types types and $discriminators discriminators from $assemblies assemblies.",
                NotificationType.INFORMATION
            ).notify(project)
        }
    }

    companion object {
        private const val COMMAND = "cosmoteer.buildModSchema"
    }
}
