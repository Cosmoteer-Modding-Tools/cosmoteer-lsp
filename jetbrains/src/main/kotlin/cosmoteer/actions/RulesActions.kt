package cosmoteer.actions

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
import cosmoteer.lsp.CosmoteerLanguageServerAPI
import cosmoteer.lsp.notifyCosmoteer
import cosmoteer.lsp.requestFromServer
import org.eclipse.lsp4j.Position
import org.eclipse.lsp4j.TextDocumentIdentifier
import org.eclipse.lsp4j.TextDocumentPositionParams
import java.util.concurrent.CompletableFuture

/** An action offered only while a `.rules` file is the one being looked at. */
abstract class RulesFileAction : AnAction() {
    final override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(event: AnActionEvent) {
        val file = event.getData(CommonDataKeys.VIRTUAL_FILE)
        event.presentation.isEnabledAndVisible =
            event.project != null && file?.extension?.equals("rules", ignoreCase = true) == true
    }
}

/** An action offered on a `.rules` file that acts on the caret of the open editor. */
abstract class RulesCaretAction : RulesFileAction() {
    final override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        val editor = event.getData(CommonDataKeys.EDITOR) ?: return
        val file = event.getData(CommonDataKeys.VIRTUAL_FILE) ?: return
        perform(project, file, editor.caretModel.offset)
    }

    /**
     * Does what the action is for.
     *
     * @param project the project the action was invoked in.
     * @param file the `.rules` file the caret is in.
     * @param offset the caret offset.
     */
    protected abstract fun perform(project: Project, file: VirtualFile, offset: Int)
}

/**
 * Reads an offset in a file as the position params the server's own requests take.
 *
 * @param file the file the offset is in.
 * @param offset the offset, clamped to the document.
 * @returns the params, or null when the file carries no document.
 */
fun positionParamsFor(file: VirtualFile, offset: Int): TextDocumentPositionParams? =
    ReadAction.compute<TextDocumentPositionParams?, RuntimeException> {
        val document = FileDocumentManager.getInstance().getDocument(file) ?: return@compute null
        val safeOffset = offset.coerceIn(0, document.textLength)
        val line = document.getLineNumber(safeOffset)
        TextDocumentPositionParams(
            TextDocumentIdentifier(LSPIJUtils.toUri(file).toASCIIString()),
            Position(line, safeOffset - document.getLineStartOffset(line))
        )
    }

/**
 * Asks the server for a markdown report and opens it as a read-only in-memory document, which the
 * Markdown plugin renders when it is installed. Says why there is none when the server has nothing.
 *
 * @param project the project whose language server is queried.
 * @param reportName the name the opened document carries.
 * @param emptyTitle the balloon's title when the server answered nothing.
 * @param emptyText the balloon's text when the server answered nothing.
 * @param emptyType the balloon's severity when the server answered nothing.
 * @param request the request to run.
 */
fun showServerMarkdown(
    project: Project,
    reportName: String,
    emptyTitle: String,
    emptyText: String,
    emptyType: NotificationType = NotificationType.WARNING,
    request: (CosmoteerLanguageServerAPI) -> CompletableFuture<String?>,
) {
    requestFromServer(project, request).thenAccept { markdown ->
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) return@invokeLater
            if (markdown.isNullOrEmpty()) {
                notifyCosmoteer(project, emptyTitle, emptyText, emptyType)
                return@invokeLater
            }
            val report = LightVirtualFile(reportName, markdown)
            report.isWritable = false
            FileEditorManager.getInstance(project).openFile(report, true)
        }
    }
}
