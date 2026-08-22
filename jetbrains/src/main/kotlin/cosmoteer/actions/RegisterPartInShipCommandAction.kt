package cosmoteer.actions

import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.redhat.devtools.lsp4ij.LanguageServerManager
import com.redhat.devtools.lsp4ij.commands.LSPCommand
import com.redhat.devtools.lsp4ij.commands.LSPCommandAction
import cosmoteer.lsp.commandResultOf
import cosmoteer.preview.ShaderPreviewService
import org.eclipse.lsp4j.ExecuteCommandParams
import java.util.concurrent.CompletableFuture

/**
 * Handles the command the server's "register this part in a ship class" refactoring carries, so the
 * offer in the editor runs here rather than on the server.
 *
 * LSP4IJ resolves a command against the language server first and only looks for an action of the same
 * id when the server does not claim it, which is why the server deliberately leaves this one out of its
 * `executeCommandProvider`. It has to run here because the ship class is a choice only the author can
 * make. The action id in `plugin.xml` must stay exactly the command id the server writes into the code
 * action.
 */
class RegisterPartInShipCommandAction : LSPCommandAction() {
    override fun getCommandPerformedThread(): ActionUpdateThread = ActionUpdateThread.EDT

    override fun commandPerformed(command: LSPCommand, event: AnActionEvent) {
        val project = event.project ?: return
        val args = argumentsOf(command) ?: return
        // No ship in the arguments is what tells the server to report the candidates rather than to
        // write anything.
        executeCommand(project, args).thenAccept { result -> offerShips(project, args, result) }
    }

    /**
     * The refactoring arguments the code action carried, as a tree this action can add the chosen ship to.
     *
     * @param command the command as it arrived.
     * @returns a mutable copy of the argument object, or null when the command carried none.
     */
    private fun argumentsOf(command: LSPCommand): JsonObject? {
        val raw = command.originalArguments?.firstOrNull() ?: command.arguments.firstOrNull()
        return (raw as? JsonElement)?.takeIf { it.isJsonObject }?.asJsonObject?.deepCopy()
    }

    /**
     * Lets the user pick the ship class the part is registered in, then runs the registration.
     *
     * @param project the project the dialog and notifications belong to.
     * @param args the arguments the pick is added to, sent back for the second round.
     * @param result the raw scan result (a Gson tree or null).
     */
    private fun offerShips(project: Project, args: JsonObject, result: Any?) {
        val scan = commandResultOf(result)
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) return@invokeLater
            if (scan == null) {
                notify(
                    project,
                    "The server did not answer the request, so nothing was changed. " +
                        "Check that the Cosmoteer language server is running.",
                    NotificationType.WARNING
                )
                return@invokeLater
            }
            val failure = scan.get("failure")?.takeIf { !it.isJsonNull }?.asString
            if (failure != null) {
                notify(project, failureMessage(failure), NotificationType.WARNING)
                return@invokeLater
            }
            val candidates = scan.getAsJsonArray("candidates") ?: JsonArray()
            val open = candidates.map { it.asJsonObject }.filter { it.get("blocked")?.isJsonNull != false }
            if (open.isEmpty()) {
                notify(
                    project,
                    "No ship class can take this part. Either none is loaded, or every one of them " +
                        "gets its Parts list from a base file, which this refactoring will not rewrite.",
                    NotificationType.INFORMATION
                )
                return@invokeLater
            }
            val labels = open.map { labelOf(it) }.toTypedArray()
            val choice = chooseOne(
                project,
                "The part is added to the ship class's Parts list. A ship class of the game's own " +
                    "install is patched from this mod's manifest instead, with an AddMany action.",
                "Cosmoteer: Register Part In A Ship Class",
                labels
            )
            if (choice < 0) return@invokeLater
            args.addProperty("ship", open[choice].get("key")?.asString ?: return@invokeLater)
            executeCommand(project, args).thenAccept { applied -> report(project, applied) }
        }
    }

    /**
     * One line describing a ship class: what it is called, and what registering into it would touch.
     *
     * @param candidate the candidate the server reported.
     * @returns the label shown in the picker.
     */
    private fun labelOf(candidate: JsonObject): String {
        val name = candidate.get("id")?.takeIf { !it.isJsonNull }?.asString
            ?: candidate.get("groupName")?.asString.orEmpty()
        val file = (candidate.get("fsPath")?.asString ?: "").substringAfterLast('/').substringAfterLast('\\')
        val how = if (candidate.get("via")?.asString == "modAction") "mod manifest" else file
        val already = if (candidate.get("alreadyRegistered")?.asBoolean == true) " (already listed)" else ""
        return "$name  ->  $how$already"
    }

    /**
     * Runs the command on the project's language server, which owns the edit so that both clients
     * share one implementation.
     *
     * @param project the project whose server is asked.
     * @param arguments the single argument object the command takes.
     * @returns the raw `workspace/executeCommand` result, null when no server is running.
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
     * Says what the registration did, or why it did nothing. The edit arrives as a workspace edit, so
     * the files it touched are written out before anything is reported.
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
                    "The server did not answer the registration request, so nothing was changed. " +
                        "Check that the Cosmoteer language server is running.",
                    NotificationType.WARNING
                )
                return@invokeLater
            }
            val failure = answer.get("failure")?.takeIf { !it.isJsonNull }?.asString
            if (failure != null) {
                val manifests = answer.getAsJsonArray("manifests")?.joinToString(", ") { it.asString }.orEmpty()
                val detail = if (manifests.isNotEmpty()) " Candidates: $manifests." else ""
                notify(project, failureMessage(failure) + detail, NotificationType.WARNING)
                return@invokeLater
            }
            FileDocumentManager.getInstance().saveAllDocuments()
            val changed = answer.getAsJsonArray("changedFiles")?.firstOrNull()?.asString.orEmpty()
            val name = changed.substringAfterLast('/').substringAfterLast('\\')
            val warning = answer.get("warning")?.takeIf { !it.isJsonNull }?.asString
            val note = if (warning == "noPartId") {
                " This part declares no ID yet, and the game will refuse to load it until it does."
            } else {
                ""
            }
            notify(project, "Registered the part in $name.$note", NotificationType.INFORMATION)
        }
    }

    /**
     * Why a registration did nothing, in one sentence the user can act on.
     *
     * @param failure the reason the server reported.
     * @returns the message to show.
     */
    private fun failureMessage(failure: String): String = when (failure) {
        "stale" -> "The part has moved since the offer was made, so nothing was changed."
        "noShipClasses" -> "No ship class was found. Set the Cosmoteer game path so the game's own ships are read."
        "unknownShip" -> "That ship class is no longer registered, so nothing was changed."
        "alreadyRegistered" -> "That ship already lists this part, so nothing was changed."
        "partsInherited" ->
            "That ship gets its Parts list from a base file, which this refactoring will not rewrite."
        "noPartsList" -> "That ship declares no Parts list to add to, so nothing was changed."
        "noModRoot" ->
            "This part is in no mod, so there is no manifest to patch the game's ship from. " +
                "Put it in a mod, or turn on editing of the game's own files."
        "ambiguousManifest" ->
            "This mod has several manifests and none of them is mod.rules, so which one gets the " +
                "part is yours to decide."
        "notEditable" -> "The file could not be edited, so nothing was changed."
        "editRejected" -> "The editor turned down the edit, so nothing was changed."
        else -> "The part could not be registered ($failure)."
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
            .createNotification("Cosmoteer register part", content, type)
            .notify(project)
    }

    companion object {
        /** The server's own command id, the one it declares and answers. */
        const val COMMAND = "cosmoteer.registerPartInShip"
    }
}
