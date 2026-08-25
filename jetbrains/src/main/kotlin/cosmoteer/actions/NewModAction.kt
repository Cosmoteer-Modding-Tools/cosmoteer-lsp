package cosmoteer.actions

import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileChooser.FileChooser
import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.redhat.devtools.lsp4ij.LanguageServerManager
import cosmoteer.lsp.commandResultOf
import cosmoteer.preview.ShaderPreviewService
import org.eclipse.lsp4j.ExecuteCommandParams
import java.util.concurrent.CompletableFuture

/**
 * Creates a whole mod, in the two rounds the server's command speaks: the first reports the folders
 * the game loads mods from and the game versions the manifest should name, the second writes the
 * mod folder with its manifest and language file.
 *
 * Where the mod goes, what it is called and who wrote it are the author's to answer, which is why
 * the questions are asked here while the writing stays on the server with the rest of the mod
 * knowledge.
 */
class NewModAction : AnAction() {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(event: AnActionEvent) {
        event.presentation.isEnabledAndVisible = event.project != null
    }

    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        executeCommand(project, JsonObject()).thenAccept { result -> ask(project, result) }
    }

    /**
     * Asks where the mod goes, what it is called and who wrote it, then runs the creation.
     *
     * @param project the project the dialogs and notifications belong to.
     * @param result the raw scan result (a Gson tree or null).
     */
    private fun ask(project: Project, result: Any?) {
        val scan = commandResultOf(result)
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) return@invokeLater
            if (scan == null) {
                notify(
                    project,
                    "The server did not answer the request, so nothing was created. " +
                        "Check that the Cosmoteer language server is running.",
                    NotificationType.WARNING
                )
                return@invokeLater
            }
            val destination = chooseDestination(project, scan) ?: return@invokeLater
            val name = Messages.showInputDialog(
                project,
                "Name your mod. The folder and the mod id are derived from this.",
                "Cosmoteer: New Mod",
                null
            )
            if (name.isNullOrBlank()) return@invokeLater
            val authors = (scan.getAsJsonArray("knownAuthors") ?: JsonArray()).map { it.asString }
            val author = Messages.showInputDialog(
                project,
                "Your name as the game shows it. It also becomes the first half of the mod id.",
                "Cosmoteer: New Mod",
                null,
                authors.firstOrNull(),
                null
            )
            if (author.isNullOrBlank()) return@invokeLater

            val args = JsonObject().apply {
                addProperty("destination", destination)
                addProperty("name", name)
                addProperty("author", author)
            }
            executeCommand(project, args).thenAccept { applied -> report(project, applied) }
        }
    }

    /**
     * Offers the folders the game loads mods from, plus picking any folder by hand.
     *
     * @param project the project the dialogs belong to.
     * @param scan the scan result holding the folders.
     * @return the chosen folder, or null when the author backed out.
     */
    private fun chooseDestination(project: Project, scan: JsonObject): String? {
        val destinations = (scan.getAsJsonArray("destinations") ?: JsonArray())
            .map { it.asJsonObject.get("path")?.asString.orEmpty() }
            .filter { it.isNotEmpty() }
        val browse = "Choose a folder..."
        val labels = (destinations + browse).toTypedArray()
        val choice = chooseOne(
            project,
            "A mod in one of the game's own Mods folders is found by the game as it is. Anywhere " +
                "else it has to be linked in first, which Cosmoteer: Run in Cosmoteer does.",
            "Cosmoteer: New Mod",
            labels
        )
        if (choice < 0) return null
        if (choice < destinations.size) return destinations[choice]
        val descriptor = FileChooserDescriptorFactory.createSingleFolderDescriptor()
        return FileChooser.chooseFile(descriptor, project, null)?.path
    }

    /**
     * Runs the command on the project's language server, which owns the write so that both clients
     * share one implementation.
     *
     * @param project the project whose server is asked.
     * @param arguments the single argument object the command takes.
     * @return the raw `workspace/executeCommand` result, null when no server is running.
     */
    private fun executeCommand(project: Project, arguments: JsonObject): CompletableFuture<Any?> =
        LanguageServerManager.getInstance(project)
            .getLanguageServer(ShaderPreviewService.SERVER_ID)
            .thenCompose { item ->
                item?.server?.workspaceService
                    ?.executeCommand(ExecuteCommandParams(COMMAND, listOf(arguments)))
                    ?: CompletableFuture.completedFuture<Any?>(null)
            }

    /**
     * Says what was created and what has to happen before the game loads anything from it.
     *
     * @param project the project the notification belongs to.
     * @param result the raw apply result (a Gson tree or null).
     */
    private fun report(project: Project, result: Any?) {
        val answer = commandResultOf(result)
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) return@invokeLater
            if (answer == null) {
                notify(
                    project,
                    "The server did not answer the request, so nothing was created. " +
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
            val modRoot = answer.get("modRoot")?.asString.orEmpty()
            val id = answer.get("id")?.asString.orEmpty()
            val notes = mutableListOf("Created $modRoot as $id.")
            notes += if (answer.get("loadedByGame")?.asBoolean == true) {
                "The game reads mods from that folder, so it will find this one."
            } else {
                "The game does not read mods from that folder. Cosmoteer: Run in Cosmoteer links it in for you."
            }
            notes += "Cosmoteer: New Content File adds your first part and the action that loads it."
            notify(project, notes.joinToString(" "), NotificationType.INFORMATION)
        }
    }

    /**
     * Why no mod was created, in one sentence the author can act on.
     *
     * @param failure the reason the server reported.
     * @return the message to show.
     */
    private fun failureMessage(failure: String): String = when (failure) {
        "noDestination" -> "That folder is not there, so nothing was created."
        "invalidName" -> "That name leaves no folder name behind. Use letters and digits."
        "invalidAuthor" -> "That author name leaves nothing for the mod id. Use letters and digits."
        "pathTaken" -> "A folder of that name is already there, and it was left alone."
        "idTaken" ->
            "Another mod on this machine already carries that id, and the game tells mods apart by it."
        "writeFailed" -> "The mod folder could not be written, so nothing was created."
        else -> "Nothing was created ($failure)."
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
            .createNotification("Cosmoteer new mod", content, type)
            .notify(project)
    }

    companion object {
        /** The server's own command id, the one it declares and answers. */
        const val COMMAND = "cosmoteer.newMod"
    }
}
