package cosmoteer.actions

import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.InputValidator
import com.intellij.openapi.ui.Messages
import com.redhat.devtools.lsp4ij.commands.LSPCommand
import cosmoteer.lsp.commandResultOf
import cosmoteer.lsp.failureCode

/**
 * Handles the command the server's "extract text into a localization key" refactoring carries, so the
 * offer in the editor runs here rather than on the server.
 *
 * It has to run here because the key path is a name the author owns and only the IDE can ask for one.
 */
class ExtractLocalizationKeyCommandAction :
    CosmoteerCommandAction("cosmoteer.extractLocalizationKey", "Cosmoteer localization key") {
    override fun commandPerformed(command: LSPCommand, event: AnActionEvent) {
        val project = event.project ?: return
        val args = argumentsOf(command) ?: return
        val proposed = args.get("key")?.asString ?: return

        val key = Messages.showInputDialog(
            project,
            "The key path every language file will declare, one name per group.",
            "Extract Text Into A Localization Key",
            null,
            proposed,
            KeyPathValidator
        )?.trim()
        if (key.isNullOrEmpty()) return

        args.addProperty("key", key)
        execute(project, args).thenAccept { result -> report(project, result) }
    }

    /**
     * Says what the extraction did, or why it did nothing. The edit itself is applied by the server
     * through `workspace/applyEdit`, so there is nothing to show but the outcome.
     *
     * @param project the project the notification belongs to.
     * @param result the raw command result (a Gson tree or null).
     */
    private fun report(project: Project, result: Any?) {
        val answer = commandResultOf(result)
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) return@invokeLater
            if (answer == null) {
                notify(
                    project,
                    "The server did not answer the extraction request, so nothing was changed. " +
                        "Check that the Cosmoteer language server is running.",
                    NotificationType.WARNING
                )
                return@invokeLater
            }
            val failure = answer.failureCode()
            if (failure != null) {
                notify(project, failureMessage(failure), NotificationType.WARNING)
                return@invokeLater
            }
            val key = answer.get("key")?.asString ?: ""
            val files = answer.getAsJsonArray("changedFiles")?.size() ?: 0
            notify(project, "Added \"$key\" to $files language files.", NotificationType.INFORMATION)
        }
    }

    /**
     * Why an extraction did nothing, in one sentence the user can act on.
     *
     * @param failure the reason the server reported.
     * @returns the message to show.
     */
    private fun failureMessage(failure: String): String = when (failure) {
        "stale" -> "That text has changed since the offer was made, so nothing was changed."
        "noStringsFiles" -> "This mod has no language strings file to put the text in, so nothing was changed."
        "editRejected" -> "The editor turned down the edit, so nothing was changed."
        else -> "The text could not be extracted, so nothing was changed."
    }

    /** Accepts only what a strings file can declare: names joined by "/". */
    private object KeyPathValidator : InputValidator {
        private val KEY_PATH = Regex("^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*$")

        override fun checkInput(inputString: String?): Boolean = KEY_PATH.matches(inputString?.trim().orEmpty())

        override fun canClose(inputString: String?): Boolean = checkInput(inputString)
    }
}
