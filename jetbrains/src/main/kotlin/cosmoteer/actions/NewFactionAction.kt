package cosmoteer.actions

import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import cosmoteer.lsp.commandResultOf
import cosmoteer.lsp.executeServerCommand
import cosmoteer.lsp.failureCode
import cosmoteer.lsp.notifyCosmoteer
import java.util.concurrent.CompletableFuture

/**
 * Creates a faction and everything the career mode needs to give it territory, in the two rounds
 * the server's command speaks: the first says which ids and player indexes are taken, the second
 * writes the faction, its galaxy entries, its FTL beacon and its name, and wires each in from the
 * manifest. Mirrors the VS Code `cosmoteer.newFaction.create` command.
 */
class NewFactionAction : AnAction() {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(event: AnActionEvent) {
        event.presentation.isEnabledAndVisible = event.project != null
    }

    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        val anchor = event.modAnchorUri() ?: return
        createFaction(project, anchor) { id ->
            val open = Messages.showYesNoDialog(
                project,
                "The faction $id exists now. Add ships to it?",
                "Cosmoteer: New Faction",
                "Add Ships",
                "Later",
                null
            )
            if (open == Messages.YES) {
                val manager = ActionManager.getInstance()
                val action = manager.getAction(ADD_SHIPS_ACTION_ID) ?: return@createFaction
                manager.tryToExecute(action, null, null, null, true)
            }
        }
    }

    companion object {
        const val COMMAND = "cosmoteer.newFaction"

        /** The registered id of the ship action, which the faction action hands over to. */
        private const val ADD_SHIPS_ACTION_ID = "cosmoteer.addShipToFaction"

        /**
         * Asks the id and the name, lets the server write the faction, and hands the id on.
         *
         * @param project the project the dialogs belong to.
         * @param anchor the uri the mod is found from.
         * @param onCreated what to do with the new id, on the UI thread, not called when nothing was created.
         */
        fun createFaction(project: Project, anchor: String, onCreated: (String) -> Unit) {
            val scanArgs = JsonObject().apply { addProperty("uri", anchor) }
            executeCommand(project, scanArgs).thenAccept { result ->
                val scan = commandResultOf(result)
                ApplicationManager.getApplication().invokeLater {
                    if (project.isDisposed) return@invokeLater
                    if (scan == null) {
                        notify(project, "The server did not answer the request, so nothing was created.", NotificationType.WARNING)
                        return@invokeLater
                    }
                    val failure = scan.failureCode()
                    if (failure != null) {
                        notify(project, failureMessage(failure), NotificationType.WARNING)
                        return@invokeLater
                    }
                    val taken = (scan.getAsJsonArray("takenIds") ?: JsonArray()).map { it.asString.lowercase() }.toSet()
                    val modRoot = scan.get("modRoot")?.takeIf { !it.isJsonNull }?.asString.orEmpty()
                    val modName = modRoot.replace('\\', '/').trimEnd('/').substringAfterLast('/')
                    val firstIndex = scan.get("suggestedPlayerIndex")?.takeIf { !it.isJsonNull }?.asInt ?: 0
                    val form = askNewFaction(project, modName, taken, firstIndex to firstIndex + 1) ?: return@invokeLater
                    val args = JsonObject().apply {
                        addProperty("uri", anchor)
                        addProperty("id", form.id)
                        addProperty("name", form.name)
                        add("color", JsonArray().apply {
                            add(form.color.red)
                            add(form.color.green)
                            add(form.color.blue)
                        })
                        form.icon?.let { addProperty("icon", it) }
                        form.beaconShip?.let { addProperty("beaconShip", it) }
                        addProperty("lore", form.lore)
                    }
                    executeCommand(project, args).thenAccept { applied -> report(project, applied, onCreated) }
                }
            }
        }

        /**
         * Says what was created, opens the faction file, and hands the id on.
         *
         * @param project the project the notification belongs to.
         * @param result the raw apply result (a Gson tree or null).
         * @param onCreated what to do with the new id.
         */
        private fun report(project: Project, result: Any?, onCreated: (String) -> Unit) {
            val answer = commandResultOf(result)
            ApplicationManager.getApplication().invokeLater {
                if (project.isDisposed) return@invokeLater
                if (answer == null) {
                    notify(project, "The server did not answer the request, so nothing was created.", NotificationType.WARNING)
                    return@invokeLater
                }
                val failure = answer.failureCode()
                if (failure != null) {
                    notify(project, failureMessage(failure), NotificationType.WARNING)
                    return@invokeLater
                }
                FileDocumentManager.getInstance().saveAllDocuments()
                val id = answer.get("id")?.asString.orEmpty()
                val notes = mutableListOf(
                    "Created the faction $id with player indexes ${answer.get("militaryPlayerIndex")?.asInt} " +
                        "and ${answer.get("civilianPlayerIndex")?.asInt}."
                )
                notes += wiringNotes(answer)
                if ((answer.getAsJsonArray("localizationFiles")?.size() ?: 0) == 0) {
                    notes += "This mod ships no language file, so ${answer.get("nameKey")?.asString} was not " +
                        "declared anywhere and the game will show no name."
                }
                val placeholders = answer.getAsJsonArray("placeholderAssets")?.size() ?: 0
                val ownIcon = answer.get("iconFile")?.takeIf { !it.isJsonNull } != null
                if (placeholders == 2) {
                    notes += "Its icon and its FTL beacon are the game's own for now, named in the files for you to replace."
                } else if (placeholders == 1) {
                    notes += if (ownIcon) {
                        "Its FTL beacon is the game's own for now, named in the beacon file for you to replace."
                    } else {
                        "Its icon is the game's own for now, named in the faction file for you to replace."
                    }
                }
                if (answer.get("loreFile")?.takeIf { !it.isJsonNull } != null) {
                    val keys = answer.getAsJsonArray("loreKeys")?.size() ?: 0
                    notes += "Its lore page is in the codex, with $keys texts to write in the language files."
                }
                notify(project, notes.joinToString(" "), NotificationType.INFORMATION)
                openCreatedFile(project, answer.get("factionFile")?.asString)
                if (id.isNotEmpty()) onCreated(id)
            }
        }

        /** Why no faction was created, in one sentence the author can act on. */
        private fun failureMessage(failure: String): String = when (failure) {
            "noModRoot" -> "This folder is in no mod. Open a mod with a mod.rules manifest first."
            "notEditable" -> "This is the game's own data or somebody else's installed mod, which is not yours to add to."
            "noGameRoot" -> "The game path is unset, so where the faction registry lives could not be read."
            "invalidId" -> "A faction id is one word of letters, digits and underscores."
            "idTaken" -> "A faction of that id already exists."
            "pathTaken" -> "A folder for that faction is already there, so nothing was created."
            "writeFailed" -> "The files could not be written, so nothing was created."
            else -> "Nothing was created ($failure)."
        }

        private fun executeCommand(project: Project, arguments: JsonObject): CompletableFuture<Any?> =
            executeServerCommand(project, COMMAND, arguments)

        private fun notify(project: Project, content: String, type: NotificationType) {
            notifyCosmoteer(project, "Cosmoteer faction", content, type)
        }
    }
}
