package cosmoteer.actions

import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.redhat.devtools.lsp4ij.LanguageServerManager
import com.redhat.devtools.lsp4ij.commands.LSPCommand
import com.redhat.devtools.lsp4ij.commands.LSPCommandAction
import cosmoteer.lsp.commandResultOf
import cosmoteer.preview.ShaderPreviewService
import org.eclipse.lsp4j.ExecuteCommandParams
import java.util.concurrent.CompletableFuture

/**
 * Handles the command the server's "apply this deprecation to the whole mod" fix carries, so the
 * offer in the editor runs here rather than on the server.
 *
 * LSP4IJ resolves a command against the language server first and only looks for an action of the
 * same id when the server does not claim it, which is why the server deliberately leaves this one
 * out of its `executeCommandProvider`. It has to run here because the fix can rewrite every part
 * file of a mod at once, and only the IDE can put that in front of the user as a diff and ask
 * before it happens. The action id in `plugin.xml` must stay exactly the command id the server
 * writes into the code action.
 */
class MigrateSymbolCommandAction : LSPCommandAction() {
    override fun getCommandPerformedThread(): ActionUpdateThread = ActionUpdateThread.EDT

    override fun commandPerformed(command: LSPCommand, event: AnActionEvent) {
        val project = event.project ?: return
        val args = argumentsOf(command) ?: return
        if (args.get("symbol")?.asString.isNullOrEmpty()) return
        if (args.get("uri")?.asString.isNullOrEmpty()) return
        val dryRun = args.deepCopy().apply { addProperty("dryRun", true) }
        execute(project, dryRun).thenAccept { result -> offerPreview(project, args, result) }
    }

    /**
     * The fix arguments the code action carried, as a tree the dry-run flag can be added to.
     *
     * @param command the command as it arrived.
     * @returns a mutable copy of the argument object, or null when the command carried none.
     */
    private fun argumentsOf(command: LSPCommand): JsonObject? {
        val raw = command.originalArguments?.firstOrNull() ?: command.arguments.firstOrNull()
        return (raw as? JsonElement)?.takeIf { it.isJsonObject }?.asJsonObject?.deepCopy()
    }

    /**
     * Runs the bulk migration on the project's language server, which owns the rewrite so that both
     * clients share one implementation.
     *
     * @param project the project whose server is asked.
     * @param arguments the single argument object the command takes.
     * @returns the raw `workspace/executeCommand` result, null when no server is running.
     */
    private fun execute(project: Project, arguments: JsonObject): CompletableFuture<Any?> =
        LanguageServerManager.getInstance(project)
            .getLanguageServer(ShaderPreviewService.SERVER_ID)
            .thenCompose { item ->
                item?.server?.workspaceService
                    ?.executeCommand(ExecuteCommandParams(COMMAND, listOf(arguments)))
                    ?: CompletableFuture.completedFuture<Any?>(null)
            }

    /**
     * Opens what the fix would change and applies it only once the user has read it and said so.
     * The change is many files at once, which no one-line summary conveys.
     *
     * @param project the project the diff and dialogs belong to.
     * @param args the fix arguments, sent back without the dry-run flag when the user confirms.
     * @param result the raw dry-run result (a Gson tree or null).
     */
    private fun offerPreview(project: Project, args: JsonObject, result: Any?) {
        val summary = commandResultOf(result)
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) return@invokeLater
            if (summary == null) {
                notify(
                    project,
                    "The preview did not run (no workspace folder, or the server is not ready).",
                    NotificationType.WARNING
                )
                return@invokeLater
            }
            val files = summary.get("files")?.asInt ?: 0
            val manual = summary.getAsJsonArray("manual")?.size() ?: 0
            if (files == 0) {
                val message = if (manual > 0) {
                    "$manual findings need manual review, nothing can be changed mechanically."
                } else {
                    "Nothing else in this mod needs that change."
                }
                notify(project, message, NotificationType.INFORMATION)
                return@invokeLater
            }
            val preview = summary.getAsJsonObject("preview")
            val changed = preview?.getAsJsonArray("changed")
            val shown = changed != null && changed.size() > 0 && SharedBaseFlow.showSideBySideDiff(project, changed)
            if (!shown) {
                SharedBaseFlow.openDiff(project, preview?.get("diff")?.asString ?: "", "cosmoteer-migration.diff")
            }
            val fixes = summary.get("fixes")?.asInt ?: 0
            val notes = mutableListOf<String>()
            if (manual > 0) notes += "$manual findings need manual review and are left alone"
            val omitted = preview?.get("omitted")?.asInt ?: 0
            if (omitted > 0) notes += "$omitted more files are not shown"
            val unparsable = summary.get("unparsable")?.asInt ?: 0
            if (unparsable > 0) notes += "$unparsable files with parse errors were skipped"
            val detail = if (notes.isEmpty()) "" else "\n\n${notes.joinToString(", ")}."
            val confirmed = Messages.showYesNoDialog(
                project,
                "Apply $fixes fixes in $files files of this mod?$detail",
                "Cosmoteer Migration",
                "Apply",
                "Cancel",
                null
            )
            if (confirmed != Messages.YES) return@invokeLater
            execute(project, args).thenAccept { applied -> showSummary(project, applied) }
        }
    }

    /**
     * Reports what the fix did.
     *
     * @param project the project the notification belongs to.
     * @param result the raw apply result (a Gson tree or null).
     */
    private fun showSummary(project: Project, result: Any?) {
        val summary = commandResultOf(result)
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) return@invokeLater
            if (summary == null) {
                notify(project, "The migration did not run, so nothing was changed.", NotificationType.WARNING)
                return@invokeLater
            }
            val fixes = summary.get("fixes")?.asInt ?: 0
            val files = summary.get("files")?.asInt ?: 0
            val manual = summary.getAsJsonArray("manual")?.size() ?: 0
            val pieces = mutableListOf("applied $fixes fixes in $files files")
            if (manual > 0) pieces += "$manual findings need manual review"
            val unparsable = summary.get("unparsable")?.asInt ?: 0
            if (unparsable > 0) pieces += "skipped $unparsable files with parse errors"
            notify(project, pieces.joinToString(", "), NotificationType.INFORMATION)
        }
    }

    /**
     * Shows one outcome notification.
     *
     * @param project the project the notification belongs to.
     * @param content the message body.
     * @param type the notification severity.
     */
    private fun notify(project: Project, content: String, type: NotificationType) {
        NotificationGroupManager.getInstance()
            .getNotificationGroup("Cosmoteer Language Server")
            .createNotification("Cosmoteer migration", content, type)
            .notify(project)
    }

    companion object {
        /** The server's own command id, the one it declares and answers. */
        private const val COMMAND = "cosmoteer.migrateSymbol"
    }
}
