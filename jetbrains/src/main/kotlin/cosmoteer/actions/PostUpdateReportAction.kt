package cosmoteer.actions

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project
import com.intellij.testFramework.LightVirtualFile
import com.redhat.devtools.lsp4ij.LanguageServerManager
import cosmoteer.lsp.commandResultOf
import cosmoteer.preview.ShaderPreviewService
import org.eclipse.lsp4j.ExecuteCommandParams

/**
 * Asks the language server what the game update changed for this mod and opens the report as a
 * read-only in-memory markdown document (rendered by the Markdown plugin when installed). Mirrors
 * the VS Code `cosmoteer.showPostUpdateReport` command.
 */
class PostUpdateReportAction : AnAction() {
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
            .thenAccept { result -> show(project, result) }
    }

    /**
     * Opens the returned report, or says why there is none.
     *
     * @param project the project the report belongs to.
     * @param result the raw `workspace/executeCommand` result (a Gson tree or null).
     */
    private fun show(project: Project, result: Any?) {
        val markdown = commandResultOf(result)?.get("markdown")?.asString
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) return@invokeLater
            if (markdown.isNullOrEmpty()) {
                NotificationGroupManager.getInstance()
                    .getNotificationGroup("Cosmoteer Language Server")
                    .createNotification(
                        "No post-update report",
                        "No project folder is open, or the server is not ready.",
                        NotificationType.WARNING
                    )
                    .notify(project)
                return@invokeLater
            }
            val report = LightVirtualFile("What the game update changed.md", markdown)
            report.isWritable = false
            FileEditorManager.getInstance(project).openFile(report, true)
        }
    }

    companion object {
        private const val COMMAND = "cosmoteer.postUpdateReport"
    }
}
