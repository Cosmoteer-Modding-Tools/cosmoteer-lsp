package cosmoteer.actions

import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import cosmoteer.lsp.commandResultOf

/**
 * Sweeps the project for fields that several rules files write word for word and lets the user pick
 * one of the extractions to make, the way the game's own data and the larger mods are structured.
 * Picking hands over to {@link SharedBaseFlow}, which shows the rewrite in the diff viewer and
 * applies it only once the user has read it. Mirrors the VS Code
 * `cosmoteer.extractSharedBaseFiles` command.
 */
class ExtractSharedBaseAction : AnAction() {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(event: AnActionEvent) {
        event.presentation.isEnabledAndVisible = event.project != null
    }

    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        // An argument object with no plan in it is what tells the server to report rather than to
        // rewrite anything.
        SharedBaseFlow.executeCommand(project, JsonObject()).thenAccept { result -> offerPlans(project, result) }
    }

    /**
     * Lets the user pick one of the extractions the sweep found.
     *
     * @param project the project the dialog and notifications belong to.
     * @param result the raw sweep result (a Gson tree or null).
     */
    private fun offerPlans(project: Project, result: Any?) {
        val scan = commandResultOf(result)
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) return@invokeLater
            if (scan == null) {
                SharedBaseFlow.showNotification(
                    project,
                    SharedBaseFlow.unreadable("scan", result),
                    NotificationType.WARNING
                )
                return@invokeLater
            }
            val plans = scan.getAsJsonArray("plans") ?: JsonArray()
            val scanned = scan.get("filesScanned")?.asInt ?: 0
            if (plans.size() == 0) {
                SharedBaseFlow.showNotification(
                    project,
                    "Nothing to extract: none of the $scanned scanned files repeat another one's fields.",
                    NotificationType.INFORMATION
                )
                return@invokeLater
            }
            val labels = plans.map { it.asJsonObject.get("label")?.asString ?: "" }.toTypedArray()
            val choice = chooseOne(
                project,
                "Every entry moves the repeated fields into one base file, either a new one the " +
                    "listed files are rewritten to inherit or the base they already inherit. " +
                    "The diff is shown before anything changes. Scanned $scanned files.",
                "Cosmoteer Shared Base",
                labels
            )
            if (choice < 0) return@invokeLater
            // The plan goes back exactly as it arrived. The server re-reads the files it names and
            // rebuilds it from what they say now, so a client-side copy would only risk describing
            // a state that no longer exists.
            SharedBaseFlow.start(project, plans.get(choice))
        }
    }
}
