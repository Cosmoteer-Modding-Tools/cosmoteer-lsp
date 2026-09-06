package cosmoteer.actions

import com.google.gson.JsonObject
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.InputValidator
import com.intellij.openapi.ui.Messages
import com.redhat.devtools.lsp4ij.commands.LSPCommand
import cosmoteer.lsp.commandResultOf
import cosmoteer.lsp.failureCode

/**
 * Handles the command the server's "clone this under a new id" refactoring carries, so the offer in the
 * editor runs here rather than on the server.
 *
 * It has to run here because the new id is a name only the author can give, and because the copy
 * writes files that have to be read before they are written.
 */
class CloneDeclarationCommandAction : CosmoteerCommandAction("cosmoteer.cloneDeclaration", "Cosmoteer clone") {
    override fun commandPerformed(command: LSPCommand, event: AnActionEvent) {
        val project = event.project ?: return
        val args = argumentsOf(command) ?: return
        // No id in the arguments is what tells the server to report what a copy would take rather
        // than to write anything.
        execute(project, args).thenAccept { result -> askForId(project, args, result) }
    }

    /**
     * Lets the author name the copy, then asks the server what that copy would look like.
     *
     * @param project the project the dialog and notifications belong to.
     * @param args the arguments the id is added to.
     * @param result the raw report result (a Gson tree or null).
     */
    private fun askForId(project: Project, args: JsonObject, result: Any?) {
        val scan = commandResultOf(result)
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) return@invokeLater
            if (scan == null) {
                notify(project, unreadable(), NotificationType.WARNING)
                return@invokeLater
            }
            val failure = scan.failureCode()
            if (failure != null) {
                notify(project, failureMessage(failure, ""), NotificationType.WARNING)
                return@invokeLater
            }
            val proposed = scan.get("proposedId")?.asString.orEmpty()
            val files = scan.get("files")?.asInt ?: 0
            val newId = Messages.showInputDialog(
                project,
                "The id the copy declares. Everything inside the copy that names the old id is " +
                    "rewritten to it. $files file(s) would be copied.",
                "Cosmoteer: Clone Under A New ID",
                null,
                proposed,
                object : InputValidator {
                    override fun checkInput(input: String?): Boolean = VALID_ID.matches(input?.trim().orEmpty())
                    override fun canClose(input: String?): Boolean = checkInput(input)
                }
            )?.trim()
            if (newId.isNullOrEmpty()) return@invokeLater
            args.addProperty("newId", newId)
            val previewArgs = args.deepCopy()
            previewArgs.addProperty("preview", true)
            execute(project, previewArgs).thenAccept { preview -> showPreview(project, args, preview) }
        }
    }

    /**
     * Shows the whole copy before any of it happens, then asks whether to write it.
     *
     * @param project the project the diff and dialogs belong to.
     * @param args the arguments the copy is written with.
     * @param result the raw preview result (a Gson tree or null).
     */
    private fun showPreview(project: Project, args: JsonObject, result: Any?) {
        val preview = commandResultOf(result)
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) return@invokeLater
            if (preview == null) {
                notify(project, unreadable(), NotificationType.WARNING)
                return@invokeLater
            }
            val failure = preview.failureCode()
            if (failure != null) {
                val detail = preview.getAsJsonArray("detail")?.joinToString(", ") { it.asString }.orEmpty()
                notify(project, failureMessage(failure, detail), NotificationType.WARNING)
                return@invokeLater
            }
            val changed = preview.getAsJsonArray("changed")
            val shown = changed != null && SharedBaseFlow.showSideBySideDiff(project, changed)
            if (!shown) SharedBaseFlow.openDiff(project, preview.get("diff")?.asString.orEmpty(), "cosmoteer-clone.diff")

            val writes = preview.getAsJsonArray("writes")?.size() ?: 0
            val destination = preview.get("destinationDir")?.asString.orEmpty()
            val dropped = preview.getAsJsonArray("droppedOtherIds")?.joinToString(", ") { it.asString }.orEmpty()
            val aliases = if (dropped.isEmpty()) {
                ""
            } else {
                " The OtherIDs aliases $dropped stay with the original, because the game answers to them there."
            }
            val answer = Messages.showYesNoDialog(
                project,
                "Write $writes file(s) into $destination?$aliases References elsewhere in the project " +
                    "keep pointing at the original.",
                "Cosmoteer: Clone Under A New ID",
                "Clone",
                "Cancel",
                null
            )
            if (answer != Messages.YES) return@invokeLater
            execute(project, args).thenAccept { applied -> report(project, applied) }
        }
    }

    /**
     * Says what the copy did, or why it did nothing.
     *
     * @param project the project the notification belongs to.
     * @param result the raw apply result (a Gson tree or null).
     */
    private fun report(project: Project, result: Any?) {
        val answer = commandResultOf(result)
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) return@invokeLater
            if (answer == null) {
                notify(project, unreadable(), NotificationType.WARNING)
                return@invokeLater
            }
            val failure = answer.failureCode()
            if (failure != null) {
                val detail = answer.getAsJsonArray("detail")?.joinToString(", ") { it.asString }.orEmpty()
                notify(project, failureMessage(failure, detail), NotificationType.WARNING)
                return@invokeLater
            }
            FileDocumentManager.getInstance().saveAllDocuments()
            val newId = answer.get("newId")?.asString.orEmpty()
            val created = answer.getAsJsonArray("createdPaths")?.size() ?: 0
            val message = if (answer.get("unit")?.asString == "listElement") {
                "Added $newId to the same list."
            } else {
                "Cloned as $newId into $created file(s)."
            }
            notify(project, message, NotificationType.INFORMATION)
        }
    }

    /** The message for a server that did not answer at all. */
    private fun unreadable(): String =
        "The server did not answer the request, so nothing was changed. " +
            "Check that the Cosmoteer language server is running."

    /**
     * Why a clone did nothing, in one sentence the user can act on.
     *
     * @param failure the reason the server reported.
     * @param detail what the reason is about: a path, a file, or the mods to choose between.
     * @returns the message to show.
     */
    private fun failureMessage(failure: String, detail: String): String = when (failure) {
        "stale" -> "The declaration has moved since the offer was made, so nothing was changed."
        "noDeclaration" -> "Nothing here declares an id, so there is nothing to clone."
        "inheritedIdentity" ->
            "This takes its id from a base file, so a copy would carry the same id. Give it an ID of its own first."
        "unreadableBase" ->
            "A base file of this one could not be read, so there is no saying what the copy would carry."
        "severalIdentities" -> "This file declares more than one thing. Put the caret in the one to clone."
        "invalidId" -> "An id is made of letters, digits, dots and underscores."
        "idUnchanged" -> "That is the id it already has. The game matches ids without regard to case."
        "idTaken" ->
            "Something already declares that id, and the game keeps one of two such entries and drops the other."
        "notEditable" ->
            "The copy would land outside a mod you can edit. The game's own files and installed " +
                "workshop mods are left alone."
        "ambiguousDestination" ->
            "The workspace holds several mods, so which one gets the copy is yours to decide. Candidates: $detail."
        "destinationExists" -> "$detail is already there, so nothing was changed."
        "unresolvablePath" -> "This reads $detail, which is not on disk, so the copy would read nothing either."
        "escapingPath" ->
            "This reads $detail from outside the destination mod, which a published mod cannot do. " +
                "Copy that file into the mod first."
        "writeFailed" -> "The copy could not be written, so it was removed again."
        "editRejected" -> "The editor turned the edit down."
        else -> "The copy could not be made ($failure)."
    }

    companion object {
        /** What an id may be spelled with, the same set the server enforces. */
        private val VALID_ID = Regex("^[A-Za-z0-9_.]+$")
    }
}
