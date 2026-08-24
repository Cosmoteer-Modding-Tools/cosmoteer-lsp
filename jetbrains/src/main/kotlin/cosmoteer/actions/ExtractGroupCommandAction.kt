package cosmoteer.actions

import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileDocumentManager
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
 * Handles the command the server's "move this block into its own file" refactoring carries, so the
 * offer in the editor runs here rather than on the server.
 *
 * LSP4IJ resolves a command against the language server first and only looks for an action of the
 * same id when the server does not claim it, which is why the server deliberately leaves this one out
 * of its `executeCommandProvider`. It has to run here because what the new file is called is a name
 * only the author can give. The move itself is the server's: it writes the file, re-expresses every
 * path the block carries against the folder that file lands in, and hands back the edit that replaces
 * the block with a reference. The action id in `plugin.xml` must stay exactly the command id the
 * server writes into the code action.
 */
class ExtractGroupCommandAction : LSPCommandAction() {
    override fun getCommandPerformedThread(): ActionUpdateThread = ActionUpdateThread.EDT

    override fun commandPerformed(command: LSPCommand, event: AnActionEvent) {
        val project = event.project ?: return
        val args = argumentsOf(command) ?: return
        if (args.get("uri")?.asString.isNullOrEmpty()) return
        // No file name in the arguments is what tells the server to report rather than write anything.
        execute(project, args).thenAccept { result -> askForName(project, args, result) }
    }

    /**
     * The refactoring arguments the code action carried, as a tree the file name can be added to.
     *
     * @param command the command as it arrived.
     * @returns a mutable copy of the argument object, or null when the command carried none.
     */
    private fun argumentsOf(command: LSPCommand): JsonObject? {
        val raw = command.originalArguments?.firstOrNull() ?: command.arguments.firstOrNull()
        return (raw as? JsonElement)?.takeIf { it.isJsonObject }?.asJsonObject?.deepCopy()
    }

    /**
     * Runs the command on the project's language server, which owns both rounds so that both clients
     * share one implementation.
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
     * Asks what the new file is called, then has the block moved into it.
     *
     * @param project the project the dialog and notifications belong to.
     * @param args the arguments the name is added to, sent back for the second round.
     * @param result the raw first-round result (a Gson tree or null).
     */
    private fun askForName(project: Project, args: JsonObject, result: Any?) {
        val answer = commandResultOf(result)
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) return@invokeLater
            if (answer == null) {
                notify(
                    project,
                    "The server did not answer the request, so nothing was changed. " +
                        "Check that the Cosmoteer language server is running.",
                    NotificationType.WARNING
                )
                return@invokeLater
            }
            val failure = answer.get("failure")?.takeIf { !it.isJsonNull }?.asString
            if (failure != null) {
                notify(project, failureMessage(failure), NotificationType.WARNING)
                return@invokeLater
            }
            val offer = answer.getAsJsonObject("offer")
            if (offer == null) {
                notify(project, "There is nothing here to move into a file.", NotificationType.WARNING)
                return@invokeLater
            }
            val name = offer.get("name")?.asString.orEmpty()
            val members = offer.get("members")?.asInt ?: 0
            val suggestion = offer.get("fileName")?.asString.orEmpty()
            val fileName = Messages.showInputDialog(
                project,
                "'$name' and its $members members move into this file, and a reference to it takes " +
                    "their place. The path is relative to the folder this file is in.",
                "Move Into Its Own File",
                null,
                suggestion,
                null
            )
            if (fileName.isNullOrBlank()) return@invokeLater
            val second = args.deepCopy().apply { addProperty("fileName", fileName.trim()) }
            execute(project, second).thenAccept { written -> showSummary(project, name, written) }
        }
    }

    /**
     * Reports what was moved.
     *
     * @param project the project the notification belongs to.
     * @param name the block's name.
     * @param result the raw second-round result (a Gson tree or null).
     */
    private fun showSummary(project: Project, name: String, result: Any?) {
        val answer = commandResultOf(result)
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) return@invokeLater
            if (answer == null) {
                notify(project, "The block was not moved, so nothing was changed.", NotificationType.WARNING)
                return@invokeLater
            }
            val failure = answer.get("failure")?.takeIf { !it.isJsonNull }?.asString
            if (failure != null) {
                notify(project, failureMessage(failure), NotificationType.WARNING)
                return@invokeLater
            }
            FileDocumentManager.getInstance().saveAllDocuments()
            val written = answer.getAsJsonObject("written")?.get("uri")?.asString.orEmpty()
            val file = written.substringAfterLast('/').substringAfterLast('\\')
            notify(project, "Moved '$name' into $file.", NotificationType.INFORMATION)
        }
    }

    /**
     * Why nothing was moved, in one sentence the user can act on.
     *
     * @param failure the reason the server reported.
     * @returns the message to show.
     */
    private fun failureMessage(failure: String): String = when (failure) {
        "stale" -> "The block has moved since the offer was made, so nothing was changed."
        "notAGroup" -> "Only a named block can be moved into a file of its own."
        "notEditable" ->
            "This file is in the game folder, which is read-only. " +
                "Put the file in a mod, or turn on editing of the game's own files."
        "inheritedGroup" -> "This block derives from another one, whose members a copy would not carry."
        "multiLineText" -> "A text in this block runs across lines, so it cannot be moved."
        "scopeRelativeValue" ->
            "This block reads something outside itself, so it would mean something else from another file."
        "badFileName" -> "The name has to be a .rules file inside this folder."
        "fileExists" -> "A file of that name is already there, so nothing was written."
        "editRejected" -> "The editor turned down the edit, so nothing was moved."
        else -> "The block could not be moved ($failure)."
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
            .createNotification("Cosmoteer", content, type)
            .notify(project)
    }

    companion object {
        /** The server's own command id, the one it declares and answers. */
        private const val COMMAND = "cosmoteer.extractGroupToFile"
    }
}
