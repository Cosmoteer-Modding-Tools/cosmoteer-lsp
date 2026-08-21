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
 * Requests the explanation of the reference at the caret and opens it as a read-only in-memory
 * markdown document. Mirrors the VS Code `cosmoteer.explainReference` command.
 *
 * No gutter marker: a reference is far too common for a marker of its own, so this lives in the Tools
 * and editor-popup menus.
 */
class ExplainReferenceAction : AnAction() {
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
        explainReference(project, file, editor.caretModel.offset)
    }
}

/**
 * Fetches and shows the report for the reference at an offset.
 *
 * @param project the project whose language server is queried.
 * @param file the `.rules` file containing the reference.
 * @param offset a caret offset on the reference.
 */
fun explainReference(project: Project, file: VirtualFile, offset: Int) {
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
            server.explainReference(params)
        }
        .thenAccept { markdown ->
            ApplicationManager.getApplication().invokeLater {
                if (project.isDisposed) return@invokeLater
                if (markdown.isNullOrEmpty()) {
                    NotificationGroupManager.getInstance()
                        .getNotificationGroup("Cosmoteer Language Server")
                        .createNotification(
                            "No report available",
                            "The caret is not on a reference.",
                            NotificationType.WARNING
                        )
                        .notify(project)
                    return@invokeLater
                }
                val report = LightVirtualFile("What This Reference Points At.md", markdown)
                report.isWritable = false
                FileEditorManager.getInstance(project).openFile(report, true)
            }
        }
}
