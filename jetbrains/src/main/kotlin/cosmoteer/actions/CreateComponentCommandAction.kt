package cosmoteer.actions

import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.redhat.devtools.lsp4ij.commands.LSPCommand
import cosmoteer.lsp.commandResultOf
import cosmoteer.lsp.failureCode

/**
 * Handles the command the server's "create the component this names" quick fix carries, so the offer
 * in the editor runs here rather than on the server.
 *
 * It has to run here because which kind of component the author meant cannot be read off the
 * reference. The declaration itself is written by the server, which is what `apply` asks for: where
 * it goes is a question about the file's shape, and both clients answer it the same way.
 */
class CreateComponentCommandAction : CosmoteerCommandAction("cosmoteer.createComponent", "Cosmoteer") {
    override fun commandPerformed(command: LSPCommand, event: AnActionEvent) {
        val project = event.project ?: return
        val args = argumentsOf(command) ?: return
        if (args.get("uri")?.asString.isNullOrEmpty()) return
        // No type in the arguments is what tells the server to report the kinds rather than write anything.
        execute(project, args).thenAccept { result -> offerKinds(project, args, result) }
    }

    /**
     * Lets the user pick the kind of component, then has the declaration written.
     *
     * @param project the project the dialog and notifications belong to.
     * @param args the arguments the pick is added to, sent back for the second round.
     * @param result the raw first-round result (a Gson tree or null).
     */
    private fun offerKinds(project: Project, args: JsonObject, result: Any?) {
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
            val failure = answer.failureCode()
            if (failure != null) {
                notify(project, failureMessage(failure), NotificationType.WARNING)
                return@invokeLater
            }
            val choices = answer.getAsJsonArray("choices") ?: JsonArray()
            if (choices.size() == 0) {
                notify(project, "This file declares nothing that takes components.", NotificationType.WARNING)
                return@invokeLater
            }
            val entries = choices.map { it.asJsonObject }
            val labels = entries.map { entry ->
                val type = entry.get("type")?.asString.orEmpty()
                val detail = entry.get("detail")?.asString.orEmpty().substringAfterLast('.')
                if (detail.isEmpty()) type else "$type  ($detail)"
            }
            val name = args.get("name")?.asString.orEmpty()
            val chosen = chooseOne(
                project,
                "Which kind of component '$name' is decides what the game does with it, and which " +
                    "fields it has to carry.",
                "Create Component",
                labels.toTypedArray()
            )
            if (chosen < 0) return@invokeLater
            val second = args.deepCopy().apply {
                addProperty("type", entries[chosen].get("type")?.asString.orEmpty())
                // The IDE writes no tab stops here, so the server writes the declaration in its plain form.
                addProperty("apply", true)
            }
            execute(project, second).thenAccept { written -> showSummary(project, name, written) }
        }
    }

    /**
     * Reports what was written.
     *
     * @param project the project the notification belongs to.
     * @param name the component's name.
     * @param result the raw second-round result (a Gson tree or null).
     */
    private fun showSummary(project: Project, name: String, result: Any?) {
        val answer = commandResultOf(result)
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) return@invokeLater
            if (answer == null) {
                notify(project, "The declaration was not written, so nothing was changed.", NotificationType.WARNING)
                return@invokeLater
            }
            val failure = answer.failureCode()
            if (failure != null) {
                notify(project, failureMessage(failure), NotificationType.WARNING)
                return@invokeLater
            }
            if (answer.get("applied")?.takeIf { !it.isJsonNull }?.asBoolean != true) {
                notify(project, "The editor turned down the edit, so nothing was changed.", NotificationType.WARNING)
                return@invokeLater
            }
            FileDocumentManager.getInstance().saveAllDocuments()
            notify(project, "Declared the component '$name'.", NotificationType.INFORMATION)
        }
    }

    /**
     * Why nothing was declared, in one sentence the user can act on.
     *
     * @param failure the reason the server reported.
     * @returns the message to show.
     */
    private fun failureMessage(failure: String): String = when (failure) {
        "stale" -> "The reference has moved since the offer was made, so nothing was changed."
        "noOwner" -> "This file declares no part or bullet to add a component to."
        "notEditable" ->
            "This file is in the game folder, which is read-only. " +
                "Put the file in a mod, or turn on editing of the game's own files."
        "unknownType" -> "That kind of component cannot be declared here."
        "alreadyDeclared" -> "A component of that name is already declared here."
        else -> "The component could not be created ($failure)."
    }
}
