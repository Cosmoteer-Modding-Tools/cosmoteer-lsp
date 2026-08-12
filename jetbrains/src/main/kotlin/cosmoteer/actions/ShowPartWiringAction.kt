package cosmoteer.actions

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.testFramework.LightVirtualFile
import com.redhat.devtools.lsp4ij.LSPIJUtils
import com.redhat.devtools.lsp4ij.LanguageServerManager
import cosmoteer.lsp.CosmoteerLanguageServerAPI
import cosmoteer.preview.ShaderPreviewService
import org.eclipse.lsp4j.Position
import org.eclipse.lsp4j.TextDocumentIdentifier
import org.eclipse.lsp4j.TextDocumentPositionParams
import java.util.concurrent.CompletableFuture

/**
 * Requests the part wiring report for the part at the caret and opens it as a read-only in-memory
 * markdown document (rendered by the Markdown plugin when installed). Mirrors the VS Code
 * `cosmoteer.showPartWiring` command.
 *
 * There is no gutter marker for this: `CosmoteerLineMarkerProvider` returns at most one marker per
 * element and already claims the root `Part` line for the grid editor, so the JetBrains entry point
 * is the Tools and editor-popup menus. VS Code gets a lens because CodeLenses stack.
 */
class ShowPartWiringAction : AnAction() {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(event: AnActionEvent) {
        val file = event.getData(CommonDataKeys.VIRTUAL_FILE)
        event.presentation.isEnabledAndVisible =
            event.project != null && file?.extension?.equals("rules", ignoreCase = true) == true
    }

    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        val editor = event.getData(CommonDataKeys.EDITOR) ?: return
        val file = event.getData(CommonDataKeys.VIRTUAL_FILE) ?: return
        showPartWiring(project, file, editor.caretModel.offset)
    }
}

/**
 * Fetches and shows the wiring report for the part at an offset.
 *
 * @param project the project whose language server is queried.
 * @param file the `.rules` file containing the part.
 * @param offset a caret offset inside the part group.
 */
fun showPartWiring(project: Project, file: VirtualFile, offset: Int) {
    val params = ReadAction.compute<TextDocumentPositionParams?, RuntimeException> {
        val document = FileDocumentManager.getInstance().getDocument(file) ?: return@compute null
        val safeOffset = offset.coerceIn(0, document.textLength)
        val line = document.getLineNumber(safeOffset)
        TextDocumentPositionParams(
            TextDocumentIdentifier(LSPIJUtils.toUri(file).toASCIIString()),
            Position(line, safeOffset - document.getLineStartOffset(line))
        )
    } ?: return
    LanguageServerManager.getInstance(project)
        .getLanguageServer(ShaderPreviewService.SERVER_ID)
        .thenCompose { item ->
            val server = item?.server as? CosmoteerLanguageServerAPI
                ?: return@thenCompose CompletableFuture.completedFuture<String?>(null)
            server.partWiring(params)
        }
        .thenAccept { markdown ->
            ApplicationManager.getApplication().invokeLater {
                if (project.isDisposed) return@invokeLater
                if (markdown.isNullOrEmpty()) {
                    NotificationGroupManager.getInstance()
                        .getNotificationGroup("Cosmoteer Language Server")
                        .createNotification(
                            "No part wiring available",
                            "The caret is not inside a part.",
                            NotificationType.WARNING
                        )
                        .notify(project)
                    return@invokeLater
                }
                val report = LightVirtualFile("Part Wiring.md", markdown)
                report.isWritable = false
                FileEditorManager.getInstance(project).openFile(report, true)
            }
        }
}
