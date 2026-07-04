package cosmoteer.actions

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.testFramework.LightVirtualFile
import com.redhat.devtools.lsp4ij.LSPIJUtils
import com.redhat.devtools.lsp4ij.LanguageServerManager
import cosmoteer.lsp.CosmoteerLanguageServerAPI
import cosmoteer.lsp.ModOverviewParams
import cosmoteer.preview.ShaderPreviewService
import org.eclipse.lsp4j.TextDocumentIdentifier

/** Whether a file is a mod manifest (`mod.rules` or a version-specific `mod_*.rules`). */
fun isModManifest(file: VirtualFile): Boolean = MANIFEST_NAME.matches(file.name)

private val MANIFEST_NAME = Regex("^mod(_[^/\\\\]*)?\\.rules$", RegexOption.IGNORE_CASE)

/**
 * Requests the mod-overview markdown for a manifest from the server and opens it as a read-only
 * in-memory markdown document (rendered by the Markdown plugin when installed). Mirrors the
 * VS Code `cosmoteer.showModOverview` command.
 */
class ShowModOverviewAction : AnAction() {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(event: AnActionEvent) {
        val file = event.getData(CommonDataKeys.VIRTUAL_FILE)
        event.presentation.isEnabledAndVisible =
            event.project != null && file != null && isModManifest(file)
    }

    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        val file = event.getData(CommonDataKeys.VIRTUAL_FILE) ?: return
        showModOverview(project, file)
    }
}

/**
 * Fetches and shows the overview for a manifest. Shared by the action and the gutter marker.
 *
 * @param project the project whose language server is queried.
 * @param manifest the mod manifest file.
 */
fun showModOverview(project: Project, manifest: VirtualFile) {
    val params = ModOverviewParams(TextDocumentIdentifier(LSPIJUtils.toUri(manifest).toASCIIString()))
    LanguageServerManager.getInstance(project)
        .getLanguageServer(ShaderPreviewService.SERVER_ID)
        .thenCompose { item ->
            val server = item?.server as? CosmoteerLanguageServerAPI
                ?: return@thenCompose java.util.concurrent.CompletableFuture.completedFuture<String?>(null)
            server.modOverview(params)
        }
        .thenAccept { markdown ->
            ApplicationManager.getApplication().invokeLater {
                if (project.isDisposed) return@invokeLater
                if (markdown.isNullOrEmpty()) {
                    NotificationGroupManager.getInstance()
                        .getNotificationGroup("Cosmoteer Language Server")
                        .createNotification(
                            "No mod overview available",
                            "The file is not inside a mod with a mod.rules.",
                            NotificationType.WARNING
                        )
                        .notify(project)
                    return@invokeLater
                }
                val overview = LightVirtualFile("Mod Overview.md", markdown)
                overview.isWritable = false
                FileEditorManager.getInstance(project).openFile(overview, true)
            }
        }
}
